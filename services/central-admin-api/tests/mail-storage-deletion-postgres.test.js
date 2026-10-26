"use strict";

// Final gap 5: durable retry of failed storage deletions (mail_storage_deletions,
// migration 37) on real PostgreSQL with the offline fake provider and an
// in-memory object store whose remove() can be made to fail:
// storage outage -> backoff -> success, crash recovery (expired lease
// reclaimed), idempotent/duplicate-safe enqueue, stale reference and legal
// hold protection, DSAR / retention / orphan sweep / inbound / compose paths
// enqueueing in the same transaction, DEAD after max attempts + step-up
// requeue, ops metrics, and the pre-37 inline fallback.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");
const { createStorageDeletionService, keyHash } = require("../src/modules/mail/ops/storage-deletion.service");

const ROLLBACK = path.join(__dirname, "..", "..", "..", "docs", "sql", "cosmicforge-mail-final-gap-closure-rollback.sql");
const outageError = () => Object.assign(new Error("storage down"), { code: "MAIL_STORAGE_UNAVAILABLE" });

test("durable storage deletions on real PostgreSQL (migration 37)", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client, { env: { MAIL_RETENTION_BATCH_SIZE: "10" } });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const execApp = harness.build({ MAIL_RETENTION_EXECUTION_ENABLED: "true" });
  const { server, base } = await listen(harness.mountApp(harness.mail));
  const exec = await listen(harness.mountApp(execApp));
  const call = caller(base, ids);
  const callExec = caller(exec.base, ids);
  t.after(async () => {
    await closeServer(server);
    await closeServer(exec.server);
    await db.close();
  });
  const deletions = harness.mail.services.storageDeletions;
  const backend = harness.backend;
  const originalRemove = backend.remove.bind(backend);
  const exists = async (key) => backend.read(key).then(() => true, () => false);
  const stepUp = async (purpose, target = call, key = "ops") => {
    harness.advance(31000);
    const response = await target(key, "POST", "/security/step-up", { code: totp(harness.clock), purpose });
    assert.equal(response.status, 201, response.text);
    return response.body.data.stepUpId;
  };
  const putObject = async (text = "object") => (await harness.mail.store.storeAttachmentContent(Buffer.from(`${text} ${crypto.randomUUID()}`))).key;
  const enqueue = (keys, meta = {}) => client.$transaction((tx) => deletions.enqueue(tx, keys, { purpose: "TEST", reason: "TEST", ...meta }));
  const rowFor = (key) => client.mailStorageDeletion.findFirst({ where: { objectKey: key }, orderBy: { createdAt: "desc" } });
  const userRow = (key) => client.adminUser.findUnique({ where: { id: ids[key] } });
  const state = {};

  await t.test("setup: dave's personal mailbox", async () => {
    const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids.dave, address: { domainId: cf.domain.id, localPart: "dave" } });
    assert.equal(box.status, 201, box.text);
    state.daveBox = box.body.data.id;
    assert.equal(await deletions.ready(), true, "migration 37 is present");
  });

  await t.test("storage outage: retries with bounded, jittered backoff, then succeeds after recovery", async () => {
    const key = await putObject("outage");
    const plan = await enqueue([key], { mailboxId: state.daveBox });
    assert.equal(plan.mode, "queued");
    backend.remove = async () => {
      throw outageError();
    };
    const first = await deletions.settle(plan);
    assert.equal(first.removed, 0);
    assert.equal(first.failed, 1);
    let row = await rowFor(key);
    assert.equal(row.status, "PENDING");
    assert.equal(row.attempts, 1);
    assert.equal(row.lastError, "MAIL_STORAGE_UNAVAILABLE");
    const delay1 = (row.nextAttemptAt.getTime() - harness.clock().getTime()) / 1000;
    assert.ok(delay1 >= 1 && delay1 <= 30, `first retry within base (got ${delay1}s)`);
    assert.equal((await deletions.processDue()).claimed, 0, "not due before the backoff elapses");

    harness.advance(31000);
    const second = await deletions.processDue();
    assert.equal(second.claimed, 1);
    assert.equal(second.retry, 1);
    row = await rowFor(key);
    assert.equal(row.attempts, 2);
    const delay2 = (row.nextAttemptAt.getTime() - harness.clock().getTime()) / 1000;
    assert.ok(delay2 >= 1 && delay2 <= 60, `second retry within 2x base (got ${delay2}s)`);
    assert.ok(await exists(key), "object kept while storage is down");

    backend.remove = originalRemove;
    harness.advance(61000);
    const third = await deletions.processDue();
    assert.equal(third.done, 1);
    row = await rowFor(key);
    assert.equal(row.status, "DONE");
    assert.ok(row.completedAt);
    assert.equal(await exists(key), false, "removed after recovery");

    // The backoff is capped (full jitter never exceeds the cap).
    const capped = createStorageDeletionService({ client, storage: harness.mail.storage, config: { storageDeletion: { baseSeconds: 30, capSeconds: 21600 } }, random: () => 0.999999 });
    assert.ok(capped.backoffSeconds(30) <= 21600);
    assert.ok(capped.backoffSeconds(1) <= 30);
  });

  await t.test("restart: a RUNNING row whose lease expired is reclaimed and finished", async () => {
    const key = await putObject("lease");
    await enqueue([key]);
    const claimed = await deletions.claim({ keys: [key] });
    assert.equal(claimed.length, 1, "a worker claims the row and then dies");
    assert.equal((await rowFor(key)).status, "RUNNING");
    assert.equal((await deletions.processDue()).claimed, 0, "a live lease is never stolen");
    harness.advance((deletions.settings.leaseSeconds + 1) * 1000);
    const recovered = await deletions.processDue();
    assert.equal(recovered.done, 1);
    assert.equal((await rowFor(key)).status, "DONE");
    assert.equal(await exists(key), false);
  });

  await t.test("idempotent: one open row per key (partial unique index), missing objects count as done", async () => {
    const key = await putObject("dupe");
    await enqueue([key]);
    await enqueue([key, key]);
    assert.equal(await client.mailStorageDeletion.count({ where: { objectKey: key } }), 1, "duplicate enqueue is a no-op");
    await assert.rejects(client.mailStorageDeletion.create({ data: { objectKey: key, purpose: "TEST", reason: "DIRECT" } }), (error) => error.code === "P2002", "the database refuses a second open row");
    assert.equal((await deletions.processDue()).done, 1);
    // Enqueued again after DONE (e.g. a replayed cleanup): the object is gone; still DONE.
    const again = await deletions.settle(await enqueue([key]));
    assert.equal(again.removed, 1);
    assert.equal(await client.mailStorageDeletion.count({ where: { objectKey: key, status: "DONE" } }), 2);
    // A 404 from the backend is success, not a retry.
    const other = await putObject("notfound");
    backend.remove = async () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    };
    const notFound = await deletions.settle(await enqueue([other]));
    backend.remove = originalRemove;
    assert.equal(notFound.removed, 1);
    assert.equal((await rowFor(other)).status, "DONE");
  });

  await t.test("stale reference: a key referenced again before execution is never deleted", async () => {
    const key = await putObject("stale");
    const plan = await enqueue([key], { mailboxId: state.daveBox });
    assert.equal(plan.keys.length, 1);
    // Re-referenced after enqueue (stale metadata / same-key replacement written by key rotation).
    await harness.mail.storage.reencrypt(key, { purpose: "mail-attachment" });
    const draft = await client.mailDraft.create({ data: { mailboxId: state.daveBox, authorAdminUserId: ids.dave } });
    await client.mailAttachment.create({ data: { mailboxId: state.daveBox, draftId: draft.id, filename: "kept.txt", contentType: "text/plain", sizeBytes: 1, sha256: "0".repeat(64), storageKey: key, scanStatus: "CLEAN", quarantined: false } });
    const result = await deletions.settle(plan);
    assert.equal(result.removed, 0);
    assert.equal(result.shared, 1);
    const row = await rowFor(key);
    assert.equal(row.status, "CANCELLED");
    assert.equal(row.lastError, "REFERENCED");
    assert.ok(await exists(key), "still-referenced object kept");
    // Enqueue never even queues a key that is referenced inside the transaction.
    const referenced = await enqueue([key]);
    assert.equal(referenced.keys.length, 0);
    assert.equal(referenced.shared, 1);
  });

  await t.test("legal hold: a held key is cancelled (HELD) and audited; requeued after release it is deleted", async () => {
    const key = await putObject("held");
    const hold = await call("ops", "POST", "/admin/legal-holds", { organizationId: cf.organization.id, mailboxId: state.daveBox, reason: "Litigation hold for test" });
    assert.equal(hold.status, 201, hold.text);
    const result = await deletions.settle(await enqueue([key], { mailboxId: state.daveBox }));
    assert.equal(result.held, 1);
    const row = await rowFor(key);
    assert.equal(row.status, "CANCELLED");
    assert.equal(row.lastError, "HELD");
    assert.ok(await exists(key), "held object kept");
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_STORAGE_DELETION_HELD", targetId: row.id } });
    assert.equal(audit.metadata.keyHash, keyHash(key));
    assert.ok(!JSON.stringify(audit).includes(key), "never the object key itself");

    assert.equal((await call("ops", "POST", `/admin/legal-holds/${hold.body.data.id}/release`)).status, 200);
    const requeued = await call("ops", "POST", `/admin/storage-deletions/${row.id}/requeue`, { reason: "Hold released by legal", stepUpId: await stepUp("MAIL_STORAGE_DELETION_REQUEUE") });
    assert.equal(requeued.status, 200, requeued.text);
    assert.equal(requeued.body.data.status, "PENDING");
    assert.equal((await deletions.processDue()).done, 1);
    assert.equal(await exists(key), false);
  });

  await t.test("DSAR erasure enqueues in the erasure transaction and removes the objects", async () => {
    const subject = "dsar.person@partner.example";
    harness.adapter.addInbound("sd_dsar_1", { from: { address: subject, name: "Subject" }, to: [{ address: "dave@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [], subject: "Personal", html: null, text: "personal text", rfcMessageId: "<sd_dsar_1@partner.example>", inReplyTo: null, references: [], receivedAt: harness.clock() });
    assert.equal((await harness.mail.processors.inbound.process({ id: crypto.randomUUID(), payload: { providerEmailId: "sd_dsar_1", to: ["dave@cosmicforge.example"] }, webhookEventId: null })).delivered, 1);
    const message = await client.mailMessage.findFirst({ where: { rfcMessageId: "<sd_dsar_1@partner.example>" } });
    const bodyKey = message.contentObjectKey;
    const erased = await call("ops", "POST", "/admin/dsar/erasure", { organizationId: cf.organization.id, email: subject, reason: "DSAR ticket #77", dryRun: false, stepUpId: await stepUp("MAIL_DSAR_ERASURE") });
    assert.equal(erased.status, 200, erased.text);
    assert.equal(erased.body.data.erased, 1);
    assert.ok(erased.body.data.objectsRemoved >= 1);
    const row = await rowFor(bodyKey);
    assert.equal(row.reason, "DSAR_ERASURE");
    assert.equal(row.status, "DONE");
    assert.equal(row.sourceId, message.id);
    assert.equal(await exists(bodyKey), false);
  });

  await t.test("inbound cleanup: objects of an undeliverable email go through the queue", async () => {
    const quotaApp = harness.build({ MAIL_MAILBOX_STORAGE_QUOTA_MB: "1", MAIL_OVER_QUOTA_POLICY: "reject" });
    const thread = await client.mailThread.create({ data: { mailboxId: state.daveBox, subject: "", normalizedSubject: "", lastMessageAt: harness.clock(), messageCount: 1 } });
    await client.mailMessage.create({ data: { mailboxId: state.daveBox, threadId: thread.id, direction: "INBOUND", status: "RECEIVED", rfcMessageId: `<${crypto.randomUUID()}@big.example>`, fromAddress: "big@big.example", sizeBytes: 2 * 1024 * 1024 } });
    const before = await client.mailStorageDeletion.count({ where: { reason: "INBOUND_ORPHAN_CLEANUP" } });
    harness.adapter.addInbound("sd_quota_1", { from: { address: "x@partner.example", name: null }, to: [{ address: "dave@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [], subject: "Too big", html: null, text: "over quota", rfcMessageId: "<sd_quota_1@partner.example>", inReplyTo: null, references: [], receivedAt: harness.clock() });
    const result = await quotaApp.processors.inbound.process({ id: crypto.randomUUID(), payload: { providerEmailId: "sd_quota_1", to: ["dave@cosmicforge.example"] }, webhookEventId: null });
    assert.equal(result.delivered, 0);
    const rows = await client.mailStorageDeletion.findMany({ where: { reason: "INBOUND_ORPHAN_CLEANUP" } });
    assert.ok(rows.length > before, "orphaned objects were queued");
    for (const row of rows) {
      assert.equal(row.status, "DONE");
      assert.equal(await exists(row.objectKey), false);
    }
  });

  await t.test("compose: removing a draft attachment and discarding a draft drop the rows and queue the objects", async () => {
    const dave = await userRow("dave");
    const compose = harness.mail.services.compose;
    const draft = await compose.createDraft(dave, state.daveBox, { to: ["partner@partner.example"], subject: "Files", text: "x" });
    const one = await compose.addAttachment(dave, draft.id, { buffer: Buffer.from("first file"), originalname: "a.txt", mimetype: "text/plain" });
    const two = await compose.addAttachment(dave, draft.id, { buffer: Buffer.from("second file"), originalname: "b.txt", mimetype: "text/plain" });
    const rowOne = await client.mailAttachment.findUnique({ where: { id: one.id } });
    const rowTwo = await client.mailAttachment.findUnique({ where: { id: two.id } });
    assert.deepEqual(await compose.removeAttachment(dave, draft.id, one.id), { removed: true });
    assert.equal(await client.mailAttachment.count({ where: { id: one.id } }), 0, "row dropped");
    assert.equal((await rowFor(rowOne.storageKey)).reason, "DRAFT_ATTACHMENT_REMOVED");
    assert.equal(await exists(rowOne.storageKey), false);
    await assert.rejects(compose.removeAttachment(dave, draft.id, one.id), (error) => error.statusCode === 404 || error.status === 404 || /Not found/.test(error.message));
    assert.deepEqual(await compose.discardDraft(dave, draft.id), { discarded: true });
    assert.equal(await client.mailAttachment.count({ where: { id: two.id } }), 0);
    assert.equal((await rowFor(rowTwo.storageKey)).reason, "DRAFT_DISCARDED");
    assert.equal(await exists(rowTwo.storageKey), false);
  });

  await t.test("retention purge and the orphan sweep enqueue their objects", async () => {
    const box = await client.mailMailbox.create({ data: { organizationId: cf.organization.id, type: "SHARED", purpose: "GENERAL", name: "Deletion queue retention" } });
    const old = new Date(harness.clock().getTime() - 400 * 86400000);
    const body = await harness.mail.store.storeBody({ html: null, text: "old text" });
    const thread = await client.mailThread.create({ data: { mailboxId: box.id, subject: "Old", normalizedSubject: "old", lastMessageAt: old, messageCount: 1, hasInbound: true } });
    const oldMessage = await client.mailMessage.create({ data: { mailboxId: box.id, threadId: thread.id, direction: "INBOUND", status: "RECEIVED", rfcMessageId: `<${crypto.randomUUID()}@old.example>`, fromAddress: "old@old.example", contentObjectKey: body.key, contentSha256: body.sha256, createdAt: old } });
    // Re-audit 7d: provider Message-ID alias and an IT quarantine decision
    // (with an attachment carrying a decision) go with the purged message.
    await client.mailMessageProviderId.create({ data: { messageId: oldMessage.id, providerRfcMessageId: `<prov-${crypto.randomUUID()}@resend.example>` } });
    const decidedKey = await putObject("decided");
    const decidedAttachment = await client.mailAttachment.create({ data: { mailboxId: box.id, messageId: oldMessage.id, filename: "d.txt", contentType: "text/plain", sizeBytes: 1, sha256: "0".repeat(64), storageKey: decidedKey, scanStatus: "CLEAN", quarantined: false, createdAt: old } });
    await client.mailQuarantineDecision.create({ data: { mailboxId: box.id, targetType: "MESSAGE", messageId: oldMessage.id, decision: "RELEASED", reason: "Released after review", decidedBy: ids.ops } });
    await client.mailQuarantineDecision.create({ data: { mailboxId: box.id, targetType: "ATTACHMENT", attachmentId: decidedAttachment.id, messageId: oldMessage.id, decision: "RESCAN_REQUESTED", reason: "Rescan requested", decidedBy: ids.ops } });
    const orphanKey = await putObject("orphan");
    await client.mailAttachment.create({ data: { mailboxId: box.id, filename: "o.txt", contentType: "text/plain", sizeBytes: 1, sha256: "0".repeat(64), storageKey: orphanKey, scanStatus: "CLEAN", quarantined: true, createdAt: old } });
    const policyRow = await call("ops", "POST", "/admin/retention-policies", { organizationId: cf.organization.id, mailboxId: box.id, name: "Queue 1y", retainDays: 365, action: "DELETE" });
    assert.equal(policyRow.status, 201, policyRow.text);
    const work = async () => {
      const worker = execApp.createWorker({ queues: ["EVENTS"] });
      for (let index = 0; index < 8; index += 1) {
        harness.advance(2000);
        await worker.drain({ maxTicks: 20 });
      }
    };
    const dry = await callExec("ops", "POST", "/admin/retention/runs", { policyId: policyRow.body.data.id });
    assert.equal(dry.status, 201, dry.text);
    await work();
    const executed = await callExec("ops", "POST", `/admin/retention/runs/${dry.body.data.id}/execute`, { stepUpId: await stepUp("MAIL_RETENTION_EXECUTE", callExec) });
    assert.equal(executed.status, 201, executed.text);
    await work();
    const run = await client.mailRetentionRun.findUnique({ where: { id: executed.body.data.id } });
    assert.equal(run.status, "COMPLETED", JSON.stringify(run));
    assert.equal(run.counts.purgedThreads, 1);
    assert.equal(run.counts.purgedOrphanAttachments, 1);
    const purge = await rowFor(body.key);
    assert.equal(purge.reason, "RETENTION_PURGE");
    // Re-audit 6: the source is the thread (subject holds re-checked at execution).
    assert.equal(purge.sourceType, "thread");
    assert.equal(purge.sourceId, thread.id);
    assert.equal(await client.mailMessageProviderId.count({ where: { messageId: oldMessage.id } }), 0, "provider Message-ID alias purged");
    assert.equal(await client.mailQuarantineDecision.count({ where: { OR: [{ messageId: oldMessage.id }, { attachmentId: decidedAttachment.id }] } }), 0, "quarantine decisions purged");
    assert.equal(await client.mailAttachment.count({ where: { id: decidedAttachment.id } }), 0, "decided attachment row removed, not tombstoned");
    assert.equal(await exists(decidedKey), false);
    // Outside a purge the decision log stays append-only (the flag was switched off).
    const keep = await client.mailQuarantineDecision.create({ data: { mailboxId: box.id, targetType: "MESSAGE", messageId: oldMessage.id, decision: "RESCAN_REQUESTED", reason: "Append-only probe", decidedBy: ids.ops } });
    await assert.rejects(client.$executeRawUnsafe(`DELETE FROM mail_quarantine_decisions WHERE id = '${keep.id}'`), /retention purge/);
    assert.equal(purge.status, "DONE");
    const sweep = await rowFor(orphanKey);
    assert.equal(sweep.reason, "RETENTION_ORPHAN_SWEEP");
    assert.equal(sweep.status, "DONE");
    assert.equal(await exists(body.key), false);
    assert.equal(await exists(orphanKey), false);
  });

  await t.test("DEAD after the attempt budget; requeue is mail-admin + step-up only; cancel keeps the object", async () => {
    const strict = createStorageDeletionService({ client, storage: harness.mail.storage, audit: harness.mail.audit, feature: { isReady: () => deletions.ready() }, archiveFeature: harness.mail.features, config: { storageDeletion: { maxAttempts: 2, baseSeconds: 1, capSeconds: 1 } }, clock: harness.clock });
    const key = await putObject("dead");
    backend.remove = async () => {
      throw outageError();
    };
    await strict.settle(await client.$transaction((tx) => strict.enqueue(tx, [key], { purpose: "TEST", reason: "TEST" })));
    harness.advance(2000);
    const deadRun = await strict.processDue();
    assert.equal(deadRun.dead, 1, JSON.stringify(deadRun));
    backend.remove = originalRemove;
    const row = await rowFor(key);
    assert.equal(row.status, "DEAD");
    assert.equal(row.attempts, 2);
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_STORAGE_DELETION_DEAD", targetId: row.id } });
    assert.equal(audit.metadata.keyHash, keyHash(key));

    // Ops metrics: depth + dead count in the snapshot, alert evaluation.
    const snap = await call("ops", "GET", "/admin/ops/snapshot");
    assert.equal(snap.status, 200, snap.text);
    assert.ok(snap.body.data.storageDeletions.dead >= 1);
    assert.equal(typeof snap.body.data.storageDeletions.depth, "number");
    const alerts = harness.mail.services.ops.evaluate(snap.body.data, {});
    assert.ok(alerts.some((alert) => alert.code === "MAIL_STORAGE_DELETIONS_DEAD"));
    assert.match(await harness.mail.services.ops.prometheus(), /cf_mail_storage_deletions\{status="DEAD"\} [1-9]/);

    // Listing: counts by status, key hash only.
    assert.equal((await call("dave", "GET", "/admin/storage-deletions")).status, 403, "mail admins only");
    const listed = await call("ops", "GET", "/admin/storage-deletions?status=DEAD");
    assert.equal(listed.status, 200, listed.text);
    assert.ok(listed.body.data.counts.DEAD >= 1);
    assert.ok(listed.body.data.items.every((item) => item.status === "DEAD"));
    assert.ok(listed.body.data.items.some((item) => item.id === row.id && item.keyHash === keyHash(key)));
    assert.ok(!listed.text.includes(key), "object keys are never returned");

    // Requeue: denied without admin, without step-up, with the wrong purpose, without a reason.
    assert.equal((await call("dave", "POST", `/admin/storage-deletions/${row.id}/requeue`, { reason: "Storage is back", stepUpId: crypto.randomUUID() })).status, 403);
    const noStepUp = await call("ops", "POST", `/admin/storage-deletions/${row.id}/requeue`, { reason: "Storage is back" });
    assert.equal(noStepUp.status, 403);
    assert.equal(noStepUp.body.code, "MAIL_STEP_UP_REQUIRED");
    assert.equal((await call("ops", "POST", `/admin/storage-deletions/${row.id}/requeue`, { reason: "Storage is back", stepUpId: await stepUp("MAIL_JOB_REQUEUE") })).status, 403, "purpose-bound");
    assert.equal((await call("ops", "POST", `/admin/storage-deletions/${row.id}/requeue`, { reason: "x", stepUpId: await stepUp("MAIL_STORAGE_DELETION_REQUEUE") })).status, 400);
    const requeued = await call("ops", "POST", `/admin/storage-deletions/${row.id}/requeue`, { reason: "Storage is back", stepUpId: await stepUp("MAIL_STORAGE_DELETION_REQUEUE") });
    assert.equal(requeued.status, 200, requeued.text);
    assert.equal(requeued.body.data.status, "PENDING");
    assert.equal(requeued.body.data.attempts, 0);
    assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MAIL_STORAGE_DELETION_REQUEUED", targetId: row.id, actorAdminUserId: ids.ops } }));
    const notDead = await call("ops", "POST", `/admin/storage-deletions/${row.id}/requeue`, { reason: "Again please", stepUpId: await stepUp("MAIL_STORAGE_DELETION_REQUEUE") });
    assert.equal(notDead.status, 409, "only DEAD / hold-cancelled rows are requeueable");

    // Cancel a PENDING row: the object stays.
    const cancelled = await call("ops", "POST", `/admin/storage-deletions/${row.id}/cancel`, { reason: "Keep for investigation", stepUpId: await stepUp("MAIL_STORAGE_DELETION_CANCEL") });
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.equal(cancelled.body.data.status, "CANCELLED");
    assert.equal(cancelled.body.data.lastError, "CANCELLED_BY_ADMIN");
    assert.equal((await deletions.processDue()).claimed, 0);
    assert.ok(await exists(key));
  });

  await t.test("re-audit 2: concurrent drops of the last two references queue the object exactly once", async () => {
    const key = await putObject("race");
    const reference = () => client.mailAttachment.create({ data: { mailboxId: state.daveBox, filename: "r.txt", contentType: "text/plain", sizeBytes: 1, sha256: "0".repeat(64), storageKey: key, scanStatus: "CLEAN", quarantined: true } });
    const a = await reference();
    const b = await reference();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let checkedA;
    const checked = new Promise((resolve) => (checkedA = resolve));
    // A drops its reference and checks (sees B's row) but has not committed yet.
    const txA = client.$transaction(async (tx) => {
      await tx.mailAttachment.delete({ where: { id: a.id } });
      const plan = await deletions.enqueue(tx, [key], { purpose: "TEST", reason: "RACE_A" });
      checkedA();
      await gate;
      return plan;
    }, { maxWait: 10000, timeout: 20000 });
    await checked;
    // B drops the last other reference concurrently (would see A's row before A commits).
    const txB = client.$transaction(async (tx) => {
      await tx.mailAttachment.delete({ where: { id: b.id } });
      return deletions.enqueue(tx, [key], { purpose: "TEST", reason: "RACE_B" });
    }, { maxWait: 10000, timeout: 20000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    const [planA, planB] = await Promise.all([txA, txB]);
    assert.equal(planA.keys.length, 0, "A still saw B's reference");
    assert.deepEqual(planB.keys, [key], "B waited for A and saw no reference left");
    const rows = await client.mailStorageDeletion.findMany({ where: { objectKey: key } });
    assert.equal(rows.length, 1, "queued exactly once, never orphaned");
    assert.equal(rows[0].reason, "RACE_B");
    await deletions.settle(planB);
    assert.equal(await exists(key), false);
  });

  await t.test("re-audit 6: subject holds on thread senders and unscoped rows are re-checked at execution", async () => {
    const thread = await client.mailThread.create({ data: { mailboxId: state.daveBox, subject: "", normalizedSubject: "", lastMessageAt: harness.clock(), messageCount: 1 } });
    const message = await client.mailMessage.create({ data: { mailboxId: state.daveBox, threadId: thread.id, direction: "OUTBOUND", status: "DELIVERED", rfcMessageId: `<${crypto.randomUUID()}@cosmicforge.example>`, fromAddress: "erin@cosmicforge.example", sentByAdminUserId: ids.erin } });
    // erin sent mail in dave's mailbox; she owns no mailbox, so only the thread links her.
    const subjectHold = await client.mailLegalHold.create({ data: { organizationId: cf.organization.id, subjectAdminUserId: ids.erin, reason: "Subject hold for erin", createdBy: ids.ops } });
    for (const [sourceType, sourceId] of [["thread", thread.id], ["message", message.id]]) {
      const key = await putObject(`subject-${sourceType}`);
      const result = await deletions.settle(await enqueue([key], { organizationId: cf.organization.id, mailboxId: state.daveBox, sourceType, sourceId }));
      assert.equal(result.held, 1, `${sourceType} source is held by the sender's subject hold`);
      const row = await rowFor(key);
      assert.deepEqual([row.status, row.lastError], ["CANCELLED", "HELD"]);
      assert.ok(await exists(key));
    }
    await client.mailLegalHold.update({ where: { id: subjectHold.id }, data: { releasedAt: harness.clock(), releasedBy: ids.ops } });
    const free = await putObject("subject-released");
    assert.equal((await deletions.settle(await enqueue([free], { organizationId: cf.organization.id, mailboxId: state.daveBox, sourceType: "thread", sourceId: thread.id }))).removed, 1);

    // A row with no organization and no mailbox: any org-wide hold (even in another brand) keeps it.
    const orgHold = await client.mailLegalHold.create({ data: { organizationId: brands.karryam.organization.id, reason: "Org-wide hold elsewhere", createdBy: ids.ops } });
    const unscoped = await putObject("unscoped");
    assert.equal((await deletions.settle(await enqueue([unscoped]))).held, 1, "conservative: unscoped rows honour every org-wide hold");
    assert.ok(await exists(unscoped));
    await client.mailLegalHold.update({ where: { id: orgHold.id }, data: { releasedAt: harness.clock(), releasedBy: ids.ops } });
    const unscoped2 = await putObject("unscoped-after");
    assert.equal((await deletions.settle(await enqueue([unscoped2]))).removed, 1);
  });

  await t.test("lead: DSAR / quarantine / retention deletions cannot be cancelled; cancel needs a step-up; admin-cancelled rows can be requeued", async () => {
    const pending = async (purpose) => {
      const key = await putObject(`cancel-${purpose}`);
      backend.remove = async () => {
        throw outageError();
      };
      await deletions.settle(await enqueue([key], { purpose }));
      backend.remove = originalRemove;
      const row = await rowFor(key);
      assert.equal(row.status, "PENDING");
      return { key, row };
    };
    for (const purpose of ["DSAR", "QUARANTINE", "RETENTION"]) {
      const { key, row } = await pending(purpose);
      const refused = await call("ops", "POST", `/admin/storage-deletions/${row.id}/cancel`, { reason: "Keep this object", stepUpId: await stepUp("MAIL_STORAGE_DELETION_CANCEL") });
      assert.equal(refused.status, 409, refused.text);
      assert.match(refused.text, /PROTECTED_DELETION/);
      assert.equal((await rowFor(key)).status, "PENDING", `${purpose} deletion still queued`);
    }
    const { key, row } = await pending("COMPOSE");
    const url = `/admin/storage-deletions/${row.id}/cancel`;
    const noStepUp = await call("ops", "POST", url, { reason: "Keep for investigation" });
    assert.equal(noStepUp.status, 403, noStepUp.text);
    assert.equal(noStepUp.body.code, "MAIL_STEP_UP_REQUIRED");
    assert.equal((await call("ops", "POST", url, { reason: "Keep for investigation", stepUpId: await stepUp("MAIL_STORAGE_DELETION_REQUEUE") })).status, 403, "purpose-bound");
    assert.equal((await rowFor(key)).status, "PENDING");
    const cancelled = await call("ops", "POST", url, { reason: "Keep for investigation", stepUpId: await stepUp("MAIL_STORAGE_DELETION_CANCEL") });
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.equal(cancelled.body.data.lastError, "CANCELLED_BY_ADMIN");
    assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MAIL_STORAGE_DELETION_CANCELLED", targetId: row.id, actorAdminUserId: ids.ops } }));
    const requeued = await call("ops", "POST", `/admin/storage-deletions/${row.id}/requeue`, { reason: "Investigation finished", stepUpId: await stepUp("MAIL_STORAGE_DELETION_REQUEUE") });
    assert.equal(requeued.status, 200, requeued.text);
    assert.equal(requeued.body.data.status, "PENDING");
    harness.advance(120000);
    await deletions.processDue();
    assert.equal((await rowFor(key)).status, "DONE");
    assert.equal(await exists(key), false);
  });

  await t.test("re-audit 1: a send never copies a file removed or re-judged after its first read", async () => {
    const erinBox = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids.erin, address: { domainId: cf.domain.id, localPart: "erin" } });
    assert.equal(erinBox.status, 201, erinBox.text);
    const dave = await userRow("dave");
    const compose = harness.mail.services.compose;
    const store = harness.mail.store;
    const originalStoreBody = store.storeBody;
    // Runs `fn` after the send's first attachment read, before its transaction.
    const between = (fn) => {
      store.storeBody = async (...args) => {
        store.storeBody = originalStoreBody;
        await fn();
        return originalStoreBody.apply(store, args);
      };
    };
    const draftWithFile = async (subject) => {
      const draft = await compose.createDraft(dave, state.daveBox, { to: ["erin@cosmicforge.example"], subject, text: "see file" });
      const file = await compose.addAttachment(dave, draft.id, { buffer: Buffer.from(`${subject} ${crypto.randomUUID()}`), originalname: "f.txt", mimetype: "text/plain" });
      const row = await client.mailAttachment.findUnique({ where: { id: file.id } });
      return { draft, file, key: row.storageKey };
    };
    try {
      // (a) removal commits between the send's read and its transaction.
      const a = await draftWithFile("Race remove");
      between(() => compose.removeAttachment(dave, a.draft.id, a.file.id));
      await assert.rejects(compose.sendDraft(dave, a.draft.id, { revision: a.draft.revision }), (error) => error.code === "MAIL_DRAFT_REVISION_CONFLICT");
      assert.equal(await client.mailAttachment.count({ where: { storageKey: a.key } }), 0, "no copy points at the deleted object");
      assert.equal(await exists(a.key), false);
      assert.equal((await client.mailDraft.findUnique({ where: { id: a.draft.id } })).status, "ACTIVE", "send rolled back");
      const resent = await compose.sendDraft(dave, a.draft.id, { revision: a.draft.revision });
      assert.ok(resent.messageId, "retry sends without the removed file");
      assert.equal(await client.mailAttachment.count({ where: { message: { rfcMessageId: (await client.mailMessage.findUnique({ where: { id: resent.messageId } })).rfcMessageId } } }), 0);

      // (b) the verdict changes (rescan -> INFECTED) between read and transaction.
      const b = await draftWithFile("Race verdict");
      between(() => client.mailAttachment.update({ where: { id: b.file.id }, data: { scanStatus: "INFECTED", scanDetail: "Test.Infected", quarantined: true } }));
      await assert.rejects(compose.sendDraft(dave, b.draft.id, { revision: b.draft.revision }), (error) => error.code === "MAIL_ATTACHMENT_NOT_CLEAN");
      assert.equal(await client.mailAttachment.count({ where: { storageKey: b.key } }), 1, "no CLEAN internal copy was created");
      assert.equal(await client.mailMessage.count({ where: { subject: "Race verdict" } }), 0);

      // (c) a send that already claimed the draft blocks the removal (no deletion of a file being sent).
      const c = await draftWithFile("Race claimed");
      await client.mailDraft.update({ where: { id: c.draft.id }, data: { status: "SENDING" } });
      await assert.rejects(compose.removeAttachment(dave, c.draft.id, c.file.id), (error) => error.code === "MAIL_DRAFT_REVISION_CONFLICT");
      assert.equal(await client.mailAttachment.count({ where: { id: c.file.id } }), 1);
      assert.ok(await exists(c.key));
      assert.equal(await client.mailStorageDeletion.count({ where: { objectKey: c.key } }), 0);
      await client.mailDraft.update({ where: { id: c.draft.id }, data: { status: "ACTIVE" } });
    } finally {
      store.storeBody = originalStoreBody;
    }
  });

  await t.test("the worker schedules and runs STORAGE_DELETION_RUN only when work is due", async () => {
    const key = await putObject("worker");
    backend.remove = async () => {
      throw outageError();
    };
    await deletions.settle(await enqueue([key]));
    backend.remove = originalRemove;
    harness.advance(31000);
    assert.equal(await deletions.hasDue(), true);
    await harness.mail.createWorker({ queues: ["EVENTS"] }).drain({ maxTicks: 5 });
    assert.equal((await rowFor(key)).status, "DONE");
    assert.equal(await exists(key), false);
    assert.ok(await client.mailOutboxJob.count({ where: { kind: "STORAGE_DELETION_RUN", status: "SUCCEEDED" } }) >= 1);
    assert.equal(await deletions.hasDue(), false);
  });
});

test("storage deletions before migration 37: inline best-effort fallback, admin endpoints 503", { timeout: 240000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  await client.$executeRawUnsafe(fs.readFileSync(ROLLBACK, "utf8"));
  const harness = createHarness(client);
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const { server, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  t.after(async () => {
    await closeServer(server);
    await db.close();
  });
  const deletions = harness.mail.services.storageDeletions;
  const exists = async (key) => harness.backend.read(key).then(() => true, () => false);
  assert.equal(await deletions.ready(), false);

  const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids.dave, address: { domainId: cf.domain.id, localPart: "dave" } });
  assert.equal(box.status, 201, box.text);

  // Enqueue never touches the missing table; settle removes inline.
  const key = (await harness.mail.store.storeAttachmentContent(Buffer.from("pre37"))).key;
  const plan = await client.$transaction((tx) => deletions.enqueue(tx, [key], { reason: "TEST" }));
  assert.equal(plan.mode, "inline");
  const settled = await deletions.settle(plan);
  assert.equal(settled.removed, 1);
  assert.equal(await exists(key), false);

  // A failing backend is logged, never thrown.
  const original = harness.backend.remove.bind(harness.backend);
  harness.backend.remove = async () => {
    throw Object.assign(new Error("down"), { code: "MAIL_STORAGE_UNAVAILABLE" });
  };
  const key2 = (await harness.mail.store.storeAttachmentContent(Buffer.from("pre37 b"))).key;
  const failed = await deletions.settle(await client.$transaction((tx) => deletions.enqueue(tx, [key2], { reason: "TEST" })));
  harness.backend.remove = original;
  assert.equal(failed.failed, 1);
  assert.ok(await exists(key2));

  // Compose keeps the pre-37 behaviour (unlink; the retention sweep removes it later).
  const dave = await client.adminUser.findUnique({ where: { id: ids.dave } });
  const draft = await harness.mail.services.compose.createDraft(dave, box.body.data.id, { to: ["partner@partner.example"], subject: "Files", text: "x" });
  const attachment = await harness.mail.services.compose.addAttachment(dave, draft.id, { buffer: Buffer.from("file"), originalname: "a.txt", mimetype: "text/plain" });
  assert.deepEqual(await harness.mail.services.compose.removeAttachment(dave, draft.id, attachment.id), { removed: true });
  const unlinked = await client.mailAttachment.findUnique({ where: { id: attachment.id } });
  assert.equal(unlinked.draftId, null);
  assert.equal(unlinked.quarantined, true);

  // Inbound cleanup and DSAR erasure still work inline.
  harness.adapter.addInbound("pre37_dsar", { from: { address: "pre.subject@partner.example", name: null }, to: [{ address: "dave@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [], subject: "Hi", html: null, text: "hello", rfcMessageId: "<pre37_dsar@partner.example>", inReplyTo: null, references: [], receivedAt: harness.clock() });
  assert.equal((await harness.mail.processors.inbound.process({ id: crypto.randomUUID(), payload: { providerEmailId: "pre37_dsar", to: ["dave@cosmicforge.example"] }, webhookEventId: null })).delivered, 1);
  const message = await client.mailMessage.findFirst({ where: { rfcMessageId: "<pre37_dsar@partner.example>" } });
  harness.advance(31000);
  const step = await call("ops", "POST", "/security/step-up", { code: totp(harness.clock), purpose: "MAIL_DSAR_ERASURE" });
  assert.equal(step.status, 201, step.text);
  const erased = await call("ops", "POST", "/admin/dsar/erasure", { organizationId: cf.organization.id, email: "pre.subject@partner.example", reason: "DSAR ticket #1", dryRun: false, stepUpId: step.body.data.stepUpId });
  assert.equal(erased.status, 200, erased.text);
  assert.equal(erased.body.data.erased, 1);
  assert.equal(await exists(message.contentObjectKey), false, "removed inline");

  // Admin endpoints answer an honest, retryable 503; the ops snapshot has no queue section.
  for (const [method, url, body] of [["GET", "/admin/storage-deletions"], ["POST", `/admin/storage-deletions/${crypto.randomUUID()}/requeue`, { reason: "Storage is back" }], ["POST", `/admin/storage-deletions/${crypto.randomUUID()}/cancel`, { reason: "Storage is back" }]]) {
    const response = await call("ops", method, url, body);
    assert.equal(response.status, 503, `${method} ${url}: ${response.text}`);
    assert.equal(response.body.code, "MAIL_FEATURE_NOT_READY");
    assert.equal(response.body.retryable, true);
  }
  const snap = await call("ops", "GET", "/admin/ops/snapshot");
  assert.equal(snap.status, 200, snap.text);
  assert.equal(snap.body.data.storageDeletions, null);
  assert.equal(await deletions.hasDue(), false, "the worker schedules nothing");
});
