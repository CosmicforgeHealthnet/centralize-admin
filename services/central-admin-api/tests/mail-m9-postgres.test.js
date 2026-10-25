"use strict";

// CosmicForge Mail M9 (operational hardening) on real PostgreSQL:
// retention dry-run / gated execution / legal holds / resumability, system
// retention categories with the append-only purge guard, usage + quota hard
// limits, the staff-mail emergency stop, alert evaluation and the
// token-protected metrics endpoint.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");

const METRICS_TOKEN = crypto.randomBytes(24).toString("hex");

test("CosmicForge Mail M9 operations on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client, { env: { MAIL_RETENTION_BATCH_SIZE: "2", MAIL_METRICS_TOKEN: METRICS_TOKEN, MAIL_RETENTION_INTEGRATION_EVENT_DAYS: "30" } });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  // Execution-enabled build of the same app (same DB, clock and storage).
  const execApp = harness.build({ MAIL_RETENTION_EXECUTION_ENABLED: "true" });
  const { server, origin, base } = await listen(harness.mountApp(harness.mail));
  const exec = await listen(harness.mountApp(execApp));
  const call = caller(base, ids);
  const callExec = caller(exec.base, ids);
  const work = async (application, rounds = 10) => {
    const worker = application.createWorker({ queues: ["EVENTS", "OUTBOUND"] });
    for (let index = 0; index < rounds; index += 1) {
      harness.advance(2000);
      await worker.drain({ maxTicks: 20 });
    }
  };
  const stepUp = async (key, purpose, target = call) => {
    harness.advance(31000);
    const response = await target(key, "POST", "/security/step-up", { code: totp(harness.clock), purpose });
    assert.equal(response.status, 201, response.text);
    return response.body.data.stepUpId;
  };

  // Mailboxes: one policy-scoped shared mailbox, one held mailbox.
  const archiveBox = await client.mailMailbox.create({ data: { organizationId: cf.organization.id, type: "SHARED", purpose: "GENERAL", name: "Old projects" } });
  const heldBox = await client.mailMailbox.create({ data: { organizationId: cf.organization.id, type: "SHARED", purpose: "GENERAL", name: "Litigation" } });
  const old = new Date(harness.clock().getTime() - 400 * 86400000);
  const makeThread = async (mailbox, { at = old, support = null, recipients = ["ext@partner.example"], withAttachment = true } = {}) => {
    const body = await harness.mail.store.storeBody({ html: "<p>secret body</p>", text: "secret body" });
    const thread = await client.mailThread.create({ data: { mailboxId: mailbox.id, subject: "Confidential subject", normalizedSubject: "confidential subject", lastMessageAt: at, messageCount: 1, hasOutbound: true, conversationStatus: support, participants: [{ address: "ext@partner.example" }] } });
    const message = await client.mailMessage.create({ data: { mailboxId: mailbox.id, threadId: thread.id, direction: "OUTBOUND", status: "PROVIDER_ACCEPTED", rfcMessageId: `<${crypto.randomUUID()}@cosmicforge.example>`, subject: "Confidential subject", fromAddress: "ops@cosmicforge.example", metadataSearchText: "confidential subject ext@partner.example", contentObjectKey: body.key, contentSha256: body.sha256, sizeBytes: body.sizeBytes, sentAt: at, createdAt: at } });
    for (const address of recipients) await client.mailMessageRecipient.create({ data: { messageId: message.id, type: "TO", address, status: "DELIVERED" } });
    let attachmentKey = null;
    if (withAttachment) {
      const stored = await harness.mail.store.storeAttachmentContent(Buffer.from("PDF bytes"));
      attachmentKey = stored.key;
      await client.mailAttachment.create({ data: { mailboxId: mailbox.id, messageId: message.id, filename: "contract.pdf", contentType: "application/pdf", sizeBytes: stored.sizeBytes, sha256: stored.sha256, storageKey: stored.key, scanStatus: "CLEAN", quarantined: false } });
    }
    await client.mailDeliveryEvent.create({ data: { messageId: message.id, providerMessageId: `re_${crypto.randomUUID()}`, recipient: recipients[0], eventType: "DELIVERED", occurredAt: at } });
    return { thread, message, bodyKey: body.key, attachmentKey };
  };
  const exists = async (key) => harness.backend.read(key).then(() => true, () => false);

  try {
    await t.test("retention: dry run counts only; holds, open cases and recent mail are protected", async () => {
      state.purgeable = [];
      for (let index = 0; index < 5; index += 1) state.purgeable.push(await makeThread(archiveBox));
      state.openCase = await makeThread(archiveBox, { support: "OPEN" });
      state.recent = await makeThread(archiveBox, { at: new Date(harness.clock().getTime() - 5 * 86400000) });
      state.held = await makeThread(heldBox);
      // Gap closure: the same body/attachment objects are referenced by a copy
      // in the held mailbox (as for an internal or multi-recipient message).
      // Purging the first mailbox must not destroy the held copy's content.
      const shared = state.purgeable[0];
      const sharedThread = await client.mailThread.create({ data: { mailboxId: heldBox.id, subject: "Shared copy", normalizedSubject: "shared copy", lastMessageAt: harness.clock(), messageCount: 1, hasInbound: true } });
      state.sharedCopy = await client.mailMessage.create({ data: { mailboxId: heldBox.id, threadId: sharedThread.id, direction: "INTERNAL", status: "RECEIVED", rfcMessageId: shared.message.rfcMessageId, subject: "Shared copy", fromAddress: "ops@cosmicforge.example", contentObjectKey: shared.bodyKey, contentSha256: shared.message.contentSha256, sizeBytes: 1 } });
      await client.mailAttachment.create({ data: { mailboxId: heldBox.id, messageId: state.sharedCopy.id, filename: "contract.pdf", contentType: "application/pdf", sizeBytes: 1, sha256: "0".repeat(64), storageKey: shared.attachmentKey, scanStatus: "CLEAN", quarantined: false } });
      const hold = await call("ops", "POST", "/admin/legal-holds", { organizationId: cf.organization.id, mailboxId: heldBox.id, reason: "Pending litigation (test)" });
      assert.equal(hold.status, 201, hold.text);
      state.holdId = hold.body.data.id;
      // Org-scoped policy (both mailboxes), DELETE after 365 days.
      const created = await call("ops", "POST", "/admin/retention-policies", { organizationId: cf.organization.id, name: "General 1y", retainDays: 365, action: "DELETE" });
      assert.equal(created.status, 201, created.text);
      state.policyId = created.body.data.id;

      assert.equal((await call("dave", "POST", "/admin/retention/runs", { policyId: state.policyId })).status, 403, "mail admins only");
      const dry = await call("ops", "POST", "/admin/retention/runs", { policyId: state.policyId });
      assert.equal(dry.status, 201, dry.text);
      assert.equal(dry.body.data.mode, "DRY_RUN");
      assert.equal((await call("ops", "POST", "/admin/retention/runs", { policyId: state.policyId })).status, 409, "one open run per target");
      await work(harness.mail);
      const done = await call("ops", "GET", `/admin/retention/runs/${dry.body.data.id}`);
      assert.equal(done.body.data.status, "COMPLETED", JSON.stringify(done.body.data));
      const counts = done.body.data.counts;
      assert.equal(counts.candidates, 7, "5 purgeable + open case + held (recent is outside cutoff)");
      assert.equal(counts.held, 1);
      assert.equal(counts.skippedActive, 1);
      assert.equal(counts.purgedThreads || 0, 0, "dry run never changes data");
      assert.doesNotMatch(JSON.stringify(done.body.data), /secret|Confidential|partner\.example/i, "no content or addresses in run records");
      assert.equal(await client.mailMessageRecipient.count({ where: { messageId: state.purgeable[0].message.id } }), 1);
      assert.ok(await exists(state.purgeable[0].bodyKey));
      state.dryRunId = dry.body.data.id;
    });

    await t.test("retention: execution needs the flag, a fresh dry run and a step-up", async () => {
      const disabled = await call("ops", "POST", `/admin/retention/runs/${state.dryRunId}/execute`, { stepUpId: await stepUp("ops", "MAIL_RETENTION_EXECUTE") });
      assert.equal(disabled.status, 409);
      assert.match(disabled.text, /MAIL_RETENTION_EXECUTION_DISABLED/);
      const noStepUp = await callExec("ops", "POST", `/admin/retention/runs/${state.dryRunId}/execute`, {});
      assert.equal(noStepUp.status, 403, noStepUp.text);
      const wrongPurpose = await callExec("ops", "POST", `/admin/retention/runs/${state.dryRunId}/execute`, { stepUpId: await stepUp("ops", "MAIL_EXPORT", callExec) });
      assert.equal(wrongPurpose.status, 403, "step-up is purpose-bound");
      // A dry run older than the validity window must be re-run.
      const staleRun = await client.mailRetentionRun.create({ data: { policyId: state.policyId, organizationId: cf.organization.id, category: "POLICY", action: "DELETE", mode: "DRY_RUN", status: "COMPLETED", cutoff: harness.clock(), requestedBy: ids.ops, counts: { retainDays: 365 }, completedAt: new Date(harness.clock().getTime() - 25 * 3600000), createdAt: new Date(harness.clock().getTime() - 26 * 3600000) } });
      const stale = await callExec("ops", "POST", `/admin/retention/runs/${staleRun.id}/execute`, { stepUpId: await stepUp("ops", "MAIL_RETENTION_EXECUTE", callExec) });
      assert.equal(stale.status, 409);
      assert.match(stale.text, /DRY_RUN_EXPIRED/);

      const executed = await callExec("ops", "POST", `/admin/retention/runs/${state.dryRunId}/execute`, { stepUpId: await stepUp("ops", "MAIL_RETENTION_EXECUTE", callExec) });
      assert.equal(executed.status, 201, executed.text);
      assert.equal(executed.body.data.mode, "EXECUTE");
      const again = await callExec("ops", "POST", `/admin/retention/runs/${state.dryRunId}/execute`, { stepUpId: await stepUp("ops", "MAIL_RETENTION_EXECUTE", callExec) });
      assert.equal(again.status, 409, "one execution per dry run");
      state.execId = executed.body.data.id;

      // The flag-off worker never executes; it defers the run untouched.
      await work(harness.mail, 2);
      assert.equal((await client.mailRetentionRun.findUnique({ where: { id: state.execId } })).counts.purgedThreads ?? 0, 0);
      // Execution-enabled worker (after the flag-off deferral elapses): batch
      // size 2, so the run resumes across several jobs.
      harness.advance(3601000);
      await work(execApp, 12);
      const run = await client.mailRetentionRun.findUnique({ where: { id: state.execId } });
      assert.equal(run.status, "COMPLETED", JSON.stringify(run));
      assert.equal(run.counts.purgedThreads, 5);
      assert.equal(run.counts.held, 1);
      assert.equal(run.counts.skippedActive, 1);
      assert.equal(run.counts.storageObjectsRemoved, 8, "body + attachment for each purged thread, except objects still shared");
      assert.equal(run.counts.storageObjectsKeptShared, 2, "the held copy's shared body and attachment are kept");
      assert.ok(await exists(state.purgeable[0].bodyKey), "shared body still readable by the held mailbox");
      assert.ok(await exists(state.purgeable[0].attachmentKey), "shared attachment still readable");
      assert.equal((await harness.mail.store.readBody(state.sharedCopy)).text, "secret body");
      assert.equal(run.counts.storageRemoveFailed, 0);
    });

    await t.test("retention: purged threads keep only a content-free tombstone; protected ones are intact", async () => {
      for (const item of state.purgeable) {
        const message = await client.mailMessage.findUnique({ where: { id: item.message.id } });
        assert.ok(message.deletedAt);
        assert.equal(message.subject, "");
        assert.equal(message.metadataSearchText, "");
        assert.equal(message.fromAddress, "");
        assert.equal(message.contentObjectKey, null);
        assert.equal(await client.mailMessageRecipient.count({ where: { messageId: item.message.id } }), 0);
        assert.equal(await client.mailAttachment.count({ where: { messageId: item.message.id } }), 0);
        assert.equal(await client.mailDeliveryEvent.count({ where: { messageId: item.message.id } }), 0);
        if (item !== state.purgeable[0]) assert.equal(await exists(item.bodyKey), false);
        if (item !== state.purgeable[0]) assert.equal(await exists(item.attachmentKey), false);
        const thread = await client.mailThread.findUnique({ where: { id: item.thread.id } });
        assert.equal(thread.subject, "");
        assert.equal(thread.participants, null);
      }
      for (const item of [state.held, state.openCase, state.recent]) {
        const message = await client.mailMessage.findUnique({ where: { id: item.message.id } });
        assert.equal(message.deletedAt, null);
        assert.equal(message.subject, "Confidential subject");
        assert.ok(await exists(item.bodyKey));
        assert.equal(await client.mailMessageRecipient.count({ where: { messageId: item.message.id } }), 1);
      }
      const audit = await client.mailAuditEvent.findMany({ where: { targetId: state.execId } });
      assert.ok(audit.some((row) => row.action === "MAIL_RETENTION_EXECUTION_COMPLETED"));
      assert.doesNotMatch(JSON.stringify(audit), /Confidential|partner\.example|secret body/);
    });

    await t.test("retention: an org-wide hold placed later protects everything; system categories need a configured period", async () => {
      await makeThread(archiveBox);
      const orgHold = await call("ops", "POST", "/admin/legal-holds", { organizationId: cf.organization.id, reason: "Regulator request (test)" });
      assert.equal(orgHold.status, 201);
      const dry = await call("ops", "POST", "/admin/retention/runs", { policyId: state.policyId });
      await work(harness.mail);
      const run = (await call("ops", "GET", `/admin/retention/runs/${dry.body.data.id}`)).body.data;
      assert.equal(run.counts.held, run.counts.candidates, "every candidate is held");
      await call("ops", "POST", `/admin/legal-holds/${orgHold.body.data.id}/release`);

      const notConfigured = await call("ops", "POST", "/admin/retention/runs", { category: "WEBHOOK_PAYLOADS" });
      assert.equal(notConfigured.status, 409);
      assert.match(notConfigured.text, /MAIL_RETENTION_PERIOD_NOT_CONFIGURED/);
      const caps = await call("ops", "GET", "/admin/retention/capabilities");
      assert.equal(caps.body.data.executionEnabled, false);
      assert.deepEqual(caps.body.data.systemCategories.find((row) => row.category === "INTEGRATION_EVENTS"), { category: "INTEGRATION_EVENTS", action: "DELETE", retainDays: 30 });
    });

    await t.test("retention: append-only integration events are deletable only inside a purge run", async () => {
      // The earlier mailbox hold is in the same org; release it so the org is purgeable.
      await call("ops", "POST", `/admin/legal-holds/${state.holdId}/release`);
      const integration = await client.mailProductIntegration.create({ data: { product: "karryam", serviceName: "karryam-notification-service", organizationId: brands.karryam.organization.id, allowedEventTypes: ["ops.alert"], createdBy: ids.super, updatedBy: ids.super } });
      const oldEvent = await client.mailProductIntegrationEvent.create({ data: { integrationId: integration.id, eventId: "old-1", eventType: "ops.alert", eventVersion: 1, payloadSha256: "a".repeat(64), status: "ACCEPTED", receivedAt: old } });
      const newEvent = await client.mailProductIntegrationEvent.create({ data: { integrationId: integration.id, eventId: "new-1", eventType: "ops.alert", eventVersion: 1, payloadSha256: "b".repeat(64), status: "ACCEPTED", receivedAt: harness.clock() } });
      await assert.rejects(client.mailProductIntegrationEvent.delete({ where: { id: oldEvent.id } }), "direct deletes stay blocked");
      const dry = await callExec("ops", "POST", "/admin/retention/runs", { category: "INTEGRATION_EVENTS" });
      assert.equal(dry.status, 201, dry.text);
      await work(execApp, 4);
      const executed = await callExec("ops", "POST", `/admin/retention/runs/${dry.body.data.id}/execute`, { stepUpId: await stepUp("ops", "MAIL_RETENTION_EXECUTE", callExec) });
      assert.equal(executed.status, 201, executed.text);
      await work(execApp, 4);
      assert.equal(await client.mailProductIntegrationEvent.count({ where: { id: oldEvent.id } }), 0);
      assert.equal(await client.mailProductIntegrationEvent.count({ where: { id: newEvent.id } }), 1);
      assert.equal((await client.mailRetentionRun.findUnique({ where: { id: executed.body.data.id } })).counts.deleted, 1);
    });

    await t.test("usage + quotas: hard limits refuse external sends, counts are recorded, no invented prices", async () => {
      const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids.dave, address: { domainId: cf.domain.id, localPart: "dave" } });
      assert.equal(box.status, 201, box.text);
      state.daveBox = box.body.data.id;
      const limit = await call("ops", "PUT", "/admin/quotas", { organizationId: cf.organization.id, purpose: "STAFF_MAIL", dailySoftLimit: 1, dailyHardLimit: 2 });
      assert.equal(limit.status, 200, limit.text);
      assert.equal((await call("ops", "PUT", "/admin/quotas", { organizationId: cf.organization.id, purpose: "STAFF_MAIL", dailySoftLimit: 5, dailyHardLimit: 2 })).status, 400, "soft must not exceed hard");
      assert.equal((await call("dave", "PUT", "/admin/quotas", { organizationId: cf.organization.id, purpose: "STAFF_MAIL", dailyHardLimit: 100 })).status, 403);
      const send = async (to) => {
        const draft = await call("dave", "POST", `/mailboxes/${state.daveBox}/drafts`, { to, subject: "Hello", text: "hi" });
        assert.equal(draft.status, 201, draft.text);
        return call("dave", "POST", `/drafts/${draft.body.data.id}/send`, { revision: draft.body.data.revision });
      };
      assert.equal((await send(["a@partner.example", "b@partner.example"])).status, 202);
      await work(harness.mail, 3);
      const refused = await send(["c@partner.example"]);
      assert.equal(refused.status, 429, refused.text);
      assert.match(refused.text, /MAIL_QUOTA_HARD_LIMIT/);
      const report = await call("ops", "GET", `/admin/usage?organizationId=${cf.organization.id}`);
      const staff = report.body.data.summary.find((row) => row.purpose === "STAFF_MAIL");
      assert.equal(staff.accepted, 2);
      assert.equal(staff.providerRequests, 1);
      assert.equal(staff.estimatedCost, null);
      assert.equal(report.body.data.cost.currency, null, "no prices unless an operator configures them");
    });

    await t.test("emergency stop holds queued staff mail and refuses new external sends", async () => {
      await call("ops", "PUT", "/admin/quotas", { organizationId: cf.organization.id, purpose: "STAFF_MAIL", dailyHardLimit: 1000 });
      const draft = await call("dave", "POST", `/mailboxes/${state.daveBox}/drafts`, { to: ["queued@partner.example"], subject: "Queued", text: "x" });
      const sent = await call("dave", "POST", `/drafts/${draft.body.data.id}/send`, { revision: 1 });
      assert.equal(sent.status, 202, sent.text);
      const stopped = harness.build({ MAIL_EMERGENCY_STOP_ALL: "true" });
      await work(stopped, 2);
      const message = await client.mailMessage.findUnique({ where: { id: sent.body.data.messageId }, include: { recipients: true, outboxJobs: true } });
      assert.equal(message.recipients[0].status, "PENDING", "not sent, not failed");
      assert.equal(message.outboxJobs[0].lastErrorCode, "MAIL_EMERGENCY_STOP");
      const stoppedServer = await listen(harness.mountApp(stopped));
      try {
        const callStopped = caller(stoppedServer.base, ids);
        const another = await callStopped("dave", "POST", `/mailboxes/${state.daveBox}/drafts`, { to: ["x@partner.example"], subject: "New", text: "x" });
        const refused = await callStopped("dave", "POST", `/drafts/${another.body.data.id}/send`, { revision: 1 });
        assert.equal(refused.status, 503);
        assert.match(refused.text, /MAIL_EMERGENCY_STOP/);
      } finally {
        await closeServer(stoppedServer.server);
      }
      // Released: the held job is sent on the normal worker.
      harness.advance(301000);
      await work(harness.mail, 2);
      const after = await client.mailMessageRecipient.findFirst({ where: { messageId: sent.body.data.messageId } });
      assert.equal(after.status, "PROVIDER_ACCEPTED");
    });

    await t.test("alerts: evaluation opens, de-duplicates, notifies admins and auto-resolves", async () => {
      const due = new Date(harness.clock().getTime() - 3600000);
      const job = await client.mailOutboxJob.create({ data: { queue: "OUTBOUND", kind: "SEND_MESSAGE", idempotencyKey: `stall-${crypto.randomUUID()}`, status: "PENDING", nextAttemptAt: due } });
      const first = await harness.mail.services.ops.processEvaluate();
      assert.ok(first.notified >= 1, JSON.stringify(first));
      const second = await harness.mail.services.ops.processEvaluate();
      assert.equal(second.notified, 0, "repeat evaluations do not re-notify");
      const alerts = await call("ops", "GET", "/admin/ops/alerts");
      const stalled = alerts.body.data.find((alert) => alert.code === "MAIL_QUEUE_STALLED");
      assert.ok(stalled);
      assert.equal(stalled.occurrences, 2);
      assert.equal((await call("dave", "GET", "/admin/ops/alerts")).status, 403);
      const ack = await call("ops", "POST", `/admin/ops/alerts/${stalled.id}/acknowledge`);
      assert.equal(ack.status, 200);
      await client.mailOutboxJob.update({ where: { id: job.id }, data: { status: "CANCELLED" } });
      await harness.mail.services.ops.processEvaluate();
      assert.ok((await client.mailOpsAlert.findUnique({ where: { id: stalled.id } })).resolvedAt, "cleared conditions resolve");
      const notes = await client.notification.findMany({ where: { adminUserId: ids.ops, title: { contains: "MAIL_QUEUE_STALLED" } } });
      assert.equal(notes.length, 1, "mail admins were notified in-app exactly once");
    });

    await t.test("closure: inbound reconciliation recovers missed webhooks; provider, lag and reconciliation alerts; preflight quota", async () => {
      const reconcile = harness.build({ MAIL_RECONCILIATION_ENABLED: "true" });
      const minutesAgo = (minutes) => new Date(harness.clock().getTime() - minutes * 60000);
      const inbound = (id, receivedAt) => harness.adapter.addInbound(id, {
        from: { address: "partner@partner.example", name: "Partner" }, to: [{ address: cf.sender.address, name: null }], cc: [], envelopeRecipients: [],
        subject: `Reconcile ${id}`, html: "<p>hi</p>", text: "hi", rfcMessageId: `<${id}@partner.example>`, inReplyTo: null, references: [], receivedAt,
      });
      inbound("in_missed", minutesAgo(20));
      inbound("in_seen", minutesAgo(25));
      inbound("in_fresh", minutesAgo(1));
      inbound("in_old", minutesAgo(30 * 60));
      await client.mailWebhookEvent.create({ data: { provider: "resend", providerEventId: `evt_${crypto.randomUUID()}`, eventType: "email.received", payloadSha256: "0".repeat(64), payload: { type: "email.received", data: { email_id: "in_seen", to: [cf.sender.address] } }, signatureVerified: true } });

      assert.deepEqual(await harness.mail.processors.inboundReconciler.process(), { skipped: "RECONCILIATION_DISABLED" }, "off unless MAIL_RECONCILIATION_ENABLED");
      const first = await reconcile.processors.inboundReconciler.process();
      assert.equal(first.recovered, 1, JSON.stringify(first));
      assert.equal((await reconcile.processors.inboundReconciler.process()).recovered, 0, "never enqueued twice");
      const jobs = await client.mailOutboxJob.findMany({ where: { idempotencyKey: { startsWith: "inbound:reconcile:" } } });
      assert.deepEqual(jobs.map((job) => job.payload.providerEmailId), ["in_missed"], "known, too-recent and out-of-window emails are skipped");

      let snap = await reconcile.services.ops.snapshot();
      assert.equal(snap.reconciliation.enabled, true);
      assert.equal(snap.reconciliation.recovered24h, 1);
      let codes = reconcile.services.ops.evaluate(snap).map((alert) => alert.code);
      assert.ok(codes.includes("MAIL_INBOUND_WEBHOOKS_MISSED"));
      assert.ok(codes.includes("MAIL_RECONCILIATION_STALE"), "no scheduled run has succeeded yet");

      // The INBOUND worker schedules the run itself and processes the recovered email.
      await reconcile.createWorker({ queues: ["INBOUND"] }).drain({ maxTicks: 20 });
      const delivered = await client.mailMessage.findFirst({ where: { providerMessageId: "in_missed", direction: "INBOUND" } });
      assert.ok(delivered, "the missed email reached its mailbox");
      snap = await reconcile.services.ops.snapshot();
      assert.ok(snap.reconciliation.lastSuccessAt, "scheduled run recorded");
      assert.ok(!reconcile.services.ops.evaluate(snap).some((alert) => alert.code === "MAIL_RECONCILIATION_STALE"));

      // Provider degradation: many jobs backing off on 429/5xx.
      const retrying = [];
      for (let index = 0; index < 20; index += 1) retrying.push((await client.mailOutboxJob.create({ data: { queue: "OUTBOUND", kind: "SEND_MESSAGE", idempotencyKey: `retry-${crypto.randomUUID()}`, status: "RETRY_SCHEDULED", lastErrorCode: index % 2 ? "RESEND_HTTP_429" : "RESEND_HTTP_503", nextAttemptAt: new Date(harness.clock().getTime() + 3600000) } })).id);
      snap = await harness.mail.services.ops.snapshot();
      assert.equal(snap.provider.retrying, 20);
      codes = harness.mail.services.ops.evaluate(snap).map((alert) => alert.code);
      assert.ok(codes.includes("MAIL_PROVIDER_DEGRADED"));
      await client.mailOutboxJob.deleteMany({ where: { id: { in: retrying } } });
      assert.ok(harness.mail.services.ops.evaluate({ ...snap, webhookLag1h: { sample: 10, p95Seconds: 900, maxSeconds: 1200 } }).some((alert) => alert.code === "MAIL_WEBHOOK_LAG_HIGH"));

      // Process counters: auth denials and provider errors (counts only).
      assert.equal((await call("dave", "GET", "/admin/ops/snapshot")).status, 403);
      await harness.mail.adapter.fetchInboundMessage("does-not-exist").catch(() => null);
      assert.ok(harness.mail.metrics.total("auth_denials") >= 1);
      assert.ok(harness.mail.metrics.total("provider_errors", (labels) => labels.kind === "PERMANENT") >= 1);

      // Spec §13.2 step 4: preflight includes the brand's sending quota.
      const mbase = `/marketing/${cf.organization.id}`;
      const consent = () => ({ topic: "newsletter", source: "WEB_FORM", policyVersion: "2026-10", evidence: { reference: `form-${crypto.randomUUID().slice(0, 8)}` } });
      const contacts = [];
      for (const email of ["q1@reader.example", "q2@reader.example"]) contacts.push((await call("dave", "POST", `${mbase}/contacts`, { email, consent: consent() })).body.data.id);
      const audience = await call("dave", "POST", `${mbase}/audiences`, { name: "Quota audience", topic: "newsletter" });
      await call("dave", "POST", `${mbase}/audiences/${audience.body.data.id}/contacts`, { contactIds: contacts });
      const template = await call("dave", "POST", `${mbase}/templates`, { name: "Quota template" });
      const version = await call("dave", "POST", `${mbase}/templates/${template.body.data.id}/versions`, { subject: "Hi", blocks: [{ type: "text", text: "Hello" }] });
      const campaign = await call("dave", "POST", `${mbase}/campaigns`, { name: "Quota", topic: "newsletter", templateVersionId: version.body.data.id, audienceId: audience.body.data.id, senderAddressId: cf.sender.id });
      assert.equal(campaign.status, 201, campaign.text);
      assert.equal((await call("ops", "PUT", "/admin/quotas", { organizationId: cf.organization.id, purpose: "MARKETING_BROADCAST", dailyHardLimit: 1 })).status, 200);
      let preflight = await call("dave", "POST", `${mbase}/campaigns/${campaign.body.data.id}/preflight`);
      const quotaCheck = () => preflight.body.data.checks.find((check) => check.id === "quota_available");
      assert.equal(quotaCheck()?.ok, false, JSON.stringify(preflight.body.data.checks));
      assert.equal(preflight.body.data.ok, false);
      assert.equal((await call("ops", "PUT", "/admin/quotas", { organizationId: cf.organization.id, purpose: "MARKETING_BROADCAST", dailyHardLimit: 1000 })).status, 200);
      preflight = await call("dave", "POST", `${mbase}/campaigns/${campaign.body.data.id}/preflight`);
      assert.equal(quotaCheck()?.ok, true);
    });

    await t.test("metrics: token-protected Prometheus text with counts only; admin snapshot", async () => {
      assert.equal((await fetch(`${origin}/api/mail/v1/ops/metrics`)).status, 401);
      assert.equal((await fetch(`${origin}/api/mail/v1/ops/metrics`, { headers: { authorization: "Bearer wrong" } })).status, 401);
      const scrape = await fetch(`${origin}/api/mail/v1/ops/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
      assert.equal(scrape.status, 200);
      const text = await scrape.text();
      assert.match(text, /^# HELP cf_mail_jobs/m);
      assert.match(text, /cf_mail_usage_today\{organization="[0-9a-f-]+",purpose="STAFF_MAIL"\} \d+/);
      assert.doesNotMatch(text, /@|Confidential|secret/i, "no addresses or content");
      assert.match(text, /cf_mail_auth_denials_total\{status="403"\} \d+/);
      assert.match(text, /cf_mail_provider_errors_total\{channel="transactional",kind="PERMANENT",status="none"\} \d+/);
      assert.match(text, /cf_mail_inbound_reconciled_24h \d+/);
      assert.match(text, /cf_mail_webhook_processing_lag_seconds\{quantile="0.95"\} \d+/);
      const snapshot = await call("ops", "GET", "/admin/ops/snapshot");
      assert.equal(snapshot.status, 200);
      assert.ok(Array.isArray(snapshot.body.data.queue.byStatus));
      assert.equal((await call("dave", "GET", "/admin/ops/snapshot")).status, 403);
      // Without a token configured the endpoint does not exist.
      const bare = await listen(harness.mountApp(harness.build({ MAIL_METRICS_TOKEN: "" })));
      try {
        assert.equal((await fetch(`${bare.origin}/api/mail/v1/ops/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).status, 404);
      } finally {
        await closeServer(bare.server);
      }
    });
  } finally {
    await closeServer(server);
    await closeServer(exec.server);
    await db.close();
  }
});

const state = {};
