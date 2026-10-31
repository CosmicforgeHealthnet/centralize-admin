"use strict";

// Inbound routing and domain lifecycle regressions (spec §18 per-domain
// receiving behaviour, §19.8 domain/DNS, §20 inbound/address state machines)
// on real PostgreSQL. Providers are offline fakes; no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp } = require("./helpers/mail-test-harness");
const { createFakeAdapter } = require("../src/modules/mail/adapters/fake.adapter");
const { MailProviderError } = require("../src/modules/mail/adapters/mail-provider.contract");
const { externalSendBlockReason, SEND_BLOCK_REASONS } = require("../src/modules/mail/authz/sending-gate");
const { closeServer } = require("./helpers/server-close");

const reasonOf = (response) => response.body?.errors?.[0]?.reason;

test("Mail inbound routing + domain lifecycle on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client);
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const servers = [];
  const serve = async (application) => {
    const { server, base } = await listen(harness.mountApp(application));
    servers.push(server);
    return caller(base, ids);
  };
  const call = await serve(harness.mail);
  t.after(async () => {
    for (const server of servers) await closeServer(server);
    await db.close();
  });
  const stepUp = async (caller_, key, purpose) => {
    harness.advance(31000); // per-user TOTP time-step replay guard
    const response = await caller_(key, "POST", "/security/step-up", { code: totp(harness.clock), purpose });
    assert.equal(response.status, 201, response.text);
    return response.body.data.stepUpId;
  };
  const user = (key) => client.adminUser.findUnique({ where: { id: ids[key] } });
  const setDomain = (data) => client.mailDomain.update({ where: { id: cf.domain.id }, data });
  const restoreDomain = () => setDomain({ status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "VERIFIED" });

  const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids.dave, address: { domainId: cf.domain.id, localPart: "dave" } });
  assert.equal(box.status, 201, box.text);
  const daveBox = box.body.data.id;
  const inbound = (adapter, id, to, extra = {}, attachments = []) => {
    adapter.addInbound(id, { from: { address: "partner@partner.example", name: null }, to: to.map((address) => ({ address, name: null })), cc: [], envelopeRecipients: [], subject: `Inbound ${id}`, html: null, text: "hello", rfcMessageId: `<${id}@partner.example>`, inReplyTo: null, references: [], receivedAt: harness.clock(), ...extra }, attachments);
    return { id: crypto.randomUUID(), payload: { providerEmailId: id, to }, webhookEventId: null };
  };

  await t.test("defect 1: a domain FAILED on sending records still receives; a non-receiving domain holds mail (FAILED, never processed)", async () => {
    await setDomain({ status: "FAILED", sendingStatus: "FAILED", receivingStatus: "VERIFIED" });
    const result = await harness.mail.processors.inbound.process(inbound(harness.adapter, "dkim_failed_1", ["dave@cosmicforge.example"]));
    assert.equal(result.delivered, 1, "DKIM failing never loses inbound mail");
    assert.equal(await client.mailMessage.count({ where: { mailboxId: daveBox, providerMessageId: "dkim_failed_1" } }), 1);

    for (const state of [{ status: "SUSPENDED", receivingStatus: "VERIFIED" }, { status: "VERIFIED", receivingStatus: "DISABLED" }]) {
      await setDomain(state);
      const id = `held_${state.status}_${state.receivingStatus}`;
      await assert.rejects(harness.mail.processors.inbound.process(inbound(harness.adapter, id, ["dave@cosmicforge.example"])), (error) => error.code === "INBOUND_DOMAIN_NOT_RECEIVING" && error.retryable === false);
      assert.equal(await client.mailMessage.count({ where: { providerMessageId: id } }), 0);
    }
    assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MAIL_INBOUND_DOMAIN_NOT_RECEIVING" } }));
    await restoreDomain();
  });

  await t.test("defect 1 (reconciler): mail held for a non-receiving domain is reported unrecovered, not processed", async () => {
    const recAdapter = createFakeAdapter();
    const rec = harness.build({ MAIL_RECONCILIATION_ENABLED: "true", MAIL_INBOUND_RECONCILE_GRACE_SECONDS: "60" }, { adapter: recAdapter });
    await setDomain({ status: "SUSPENDED" });
    inbound(recAdapter, "rec_held_1", ["dave@cosmicforge.example"], { receivedAt: new Date(harness.clock().getTime() - 20 * 60000) });
    const first = await rec.processors.inboundReconciler.process();
    assert.equal(first.recovered, 1);
    await rec.createWorker().drain();
    const job = await client.mailOutboxJob.findUnique({ where: { idempotencyKey: "inbound:reconcile:rec_held_1" } });
    assert.equal(job.status, "FAILED");
    assert.equal(job.lastErrorCode, "INBOUND_DOMAIN_NOT_RECEIVING");
    const second = await rec.processors.inboundReconciler.process();
    assert.equal(second.unrecovered, 1, JSON.stringify(second));
    assert.equal(second.domainHeld, 1);
    await restoreDomain();
    // After the domain receives again an operator requeue delivers it.
    await client.mailOutboxJob.update({ where: { id: job.id }, data: { status: "PENDING", attemptCount: 0, nextAttemptAt: harness.clock() } });
    await rec.createWorker().drain();
    assert.equal(await client.mailMessage.count({ where: { mailboxId: daveBox, providerMessageId: "rec_held_1" } }), 1);
  });

  await t.test("defect 2: re-verifying a SUSPENDED domain stores provider results but keeps the suspension", async () => {
    const ops = await user("ops");
    harness.adapter.state.domains.set(cf.domain.providerDomainId, { status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "VERIFIED", records: [{ record: "SPF", type: "TXT", name: "send", value: "v=spf1", status: "verified" }, { record: "DKIM", type: "TXT", name: "resend._domainkey", value: "p=x", status: "verified" }] });
    await setDomain({ status: "SUSPENDED", sendingStatus: "DISABLED" });
    const row = await harness.mail.services.admin.verifyDomain(ops, cf.domain.id, {});
    assert.equal(row.status, "SUSPENDED");
    assert.equal(row.sendingStatus, "VERIFIED", "provider result stored");
    assert.equal(row.checks.spf, "VERIFIED");
    assert.equal(row.checks.dmarc, "NOT_REPORTED");
    assert.equal(row.checks.receivesMail, false);
    const stored = await client.mailDomain.findUnique({ where: { id: cf.domain.id }, include: { organization: true } });
    assert.equal(stored.status, "SUSPENDED");
    assert.equal(externalSendBlockReason({ config: harness.mail.config, providerReady: () => true, domain: stored }), SEND_BLOCK_REASONS.SENDING_SUSPENDED, "the kill-switch stays on");
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_DOMAIN_VERIFICATION_CHECKED", targetId: cf.domain.id }, orderBy: { createdAt: "desc" } });
    assert.equal(audit.metadata.suspended, true);
    assert.equal(audit.metadata.providerStatus, "VERIFIED");
    await restoreDomain();
    const unsuspended = await harness.mail.services.admin.verifyDomain(ops, cf.domain.id, {});
    assert.equal(unsuspended.status, "VERIFIED", "non-suspended domains follow the provider");
  });

  await t.test("defect 3: narrowing the external forwarding allow-list stops existing ACTIVE external rules", async () => {
    const rule = await client.mailForwardingRule.create({ data: { mailboxId: daveBox, organizationId: cf.organization.id, targetAddress: "assistant@partner.example", targetKind: "EXTERNAL", reason: "Assistant handles partner mail", requestedBy: ids.dave, requestedAt: harness.clock(), status: "ACTIVE", decidedBy: ids.ops, decidedAt: harness.clock() } });
    const narrowed = harness.build({ MAIL_FORWARDING_EXTERNAL_ALLOWED_DOMAINS: "" });
    const result = await narrowed.processors.inbound.process(inbound(harness.adapter, "fwd_narrowed_1", ["dave@cosmicforge.example"]));
    assert.equal(result.delivered, 1);
    const skipped = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_FORWARD_SKIPPED", targetId: rule.id } });
    assert.equal(skipped?.metadata?.reason, "EXTERNAL_DOMAIN_NOT_ALLOWED");
    assert.equal(await client.mailMessage.count({ where: { mailboxId: daveBox, idempotencyKey: { startsWith: `fwd:` } } }), 0, "nothing forwarded");
    const key = `fwd:1:${rule.id}:${crypto.randomUUID()}`;
    assert.equal(await narrowed.services.forwarding.ruleStillActive(key), false, "queued forwards are stopped at dispatch too");
    const allowing = harness.build({ MAIL_FORWARDING_EXTERNAL_ALLOWED_DOMAINS: "partner.example" });
    assert.equal(await allowing.services.forwarding.ruleStillActive(key), true);
    await client.mailForwardingRule.update({ where: { id: rule.id }, data: { status: "DISABLED", disabledAt: harness.clock(), disabledReason: "TEST" } });
  });

  await t.test("defect 4: quarantine policy holds the unknown recipients of a mixed message without delivering to them", async () => {
    const q = harness.build({ MAIL_UNKNOWN_RECIPIENT_POLICY: "quarantine" });
    const job = inbound(harness.adapter, "mixed_q_1", ["dave@cosmicforge.example", "newhire@cosmicforge.example"]);
    const result = await q.processors.inbound.process(job);
    assert.equal(result.delivered, 1);
    assert.equal(result.heldUnknown, 1);
    const hold = await client.mailOutboxJob.findUnique({ where: { idempotencyKey: "inbound:unknown-hold:mixed_q_1" } });
    assert.ok(hold, "the unknown recipients are held in their own job");
    assert.deepEqual(hold.payload.onlyRecipients, ["newhire@cosmicforge.example"]);
    // Replays never create a second hold job.
    await q.processors.inbound.process({ ...job, id: crypto.randomUUID() });
    assert.equal(await client.mailOutboxJob.count({ where: { idempotencyKey: { startsWith: "inbound:unknown-hold:mixed_q_1" } } }), 1);
    await assert.rejects(q.processors.inbound.process(hold), (error) => error.code === "INBOUND_UNKNOWN_RECIPIENT_QUARANTINED" && error.retryable === false);
    assert.equal(await client.mailMessage.count({ where: { providerMessageId: "mixed_q_1" } }), 1, "unknown recipients get nothing");
    // After provisioning, the held job delivers only to the new mailbox.
    const erinBox = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids.erin, address: { domainId: cf.domain.id, localPart: "newhire" } });
    assert.equal(erinBox.status, 201, erinBox.text);
    const retried = await q.processors.inbound.process(hold);
    assert.equal(retried.delivered, 1);
    assert.equal(await client.mailMessage.count({ where: { providerMessageId: "mixed_q_1", mailboxId: erinBox.body.data.id } }), 1);
    assert.equal(await client.mailMessage.count({ where: { providerMessageId: "mixed_q_1", mailboxId: daveBox } }), 1);
    // reject policy (default): unknown recipients of a mixed message are dropped, no hold job.
    await harness.mail.processors.inbound.process(inbound(harness.adapter, "mixed_r_1", ["dave@cosmicforge.example", "nobody@cosmicforge.example"]));
    assert.equal(await client.mailOutboxJob.count({ where: { idempotencyKey: "inbound:unknown-hold:mixed_r_1" } }), 0);
  });

  await t.test("defect 5: receiving disabled defers inbound jobs without consuming attempts", async () => {
    const off = harness.build({ MAIL_RECEIVING_ENABLED: "false" });
    inbound(harness.adapter, "defer_1", ["dave@cosmicforge.example"]);
    assert.deepEqual(await off.processors.inbound.process({ payload: { providerEmailId: "defer_1" } }), { defer: { seconds: 300, code: "MAIL_RECEIVING_DISABLED", message: "receiving disabled" } });
    const { job } = await off.jobs.enqueue(null, { queue: "INBOUND", kind: "PROCESS_INBOUND", idempotencyKey: "inbound:test:defer_1", payload: { providerEmailId: "defer_1", to: ["dave@cosmicforge.example"] }, maxAttempts: 2 });
    // Backend-managed core queues: with receiving off the worker does not
    // serve INBOUND at all (paused, reported in its heartbeat), so the job
    // keeps every attempt and is never dead-lettered.
    let worker = null;
    for (let i = 0; i < 3; i += 1) {
      worker = off.createWorker({ heartbeat: false });
      await worker.drain();
      await client.mailOutboxJob.update({ where: { id: job.id }, data: { nextAttemptAt: harness.clock() } });
    }
    assert.deepEqual(worker.metrics.pausedQueues.find((entry) => entry.queue === "INBOUND"), { queue: "INBOUND", reason: "RECEIVING_DISABLED" });
    const after = await client.mailOutboxJob.findUnique({ where: { id: job.id } });
    assert.ok(["PENDING", "RETRY_SCHEDULED"].includes(after.status), "never dead-lettered");
    assert.equal(after.attemptCount, 0);
    await client.mailOutboxJob.update({ where: { id: job.id }, data: { status: "CANCELLED" } });
  });

  await t.test("expired attachment links retry, and the final attempt delivers with the attachment marked failed", async () => {
    const expiring = { ...harness.adapter, fetchInboundAttachments: async (id) => (await harness.adapter.fetchInboundAttachments(id)).map((attachment) => ({ ...attachment, download: async () => { throw new MailProviderError("RETRYABLE", "ATTACHMENT_URL_EXPIRED", "signed link expired"); } })) };
    const app = harness.build({}, { adapter: expiring });
    const job = inbound(harness.adapter, "att_expired_1", ["dave@cosmicforge.example"], {}, [{ filename: "report.pdf", contentType: "application/pdf", content: "%PDF-1.4 test" }]);
    await assert.rejects(app.processors.inbound.process({ ...job, attemptCount: 1, maxAttempts: 6 }), (error) => error.code === "ATTACHMENT_DOWNLOAD_RETRY" && error.retryable === true);
    assert.equal(await client.mailMessage.count({ where: { providerMessageId: "att_expired_1" } }), 0);
    const last = await app.processors.inbound.process({ ...job, attemptCount: 6, maxAttempts: 6 });
    assert.equal(last.delivered, 1, "never lost on the last attempt");
    const message = await client.mailMessage.findFirst({ where: { providerMessageId: "att_expired_1" }, include: { attachments: true } });
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].scanStatus, "SCAN_FAILED");
    assert.equal(message.attachments[0].scanDetail, "ATTACHMENT_URL_EXPIRED");
    assert.equal(message.attachments[0].quarantined, true);
  });

  await t.test("defect 7: domain registration fails closed with an empty allowlist", async () => {
    const ops = await user("ops");
    const empty = harness.build({ MAIL_DOMAIN_ALLOWLIST: "" });
    await assert.rejects(empty.services.admin.createDomain(ops, { organizationId: cf.organization.id, domain: "anything.example" }, {}), (error) => error.errors?.[0]?.reason === "ALLOWLIST_EMPTY");
    assert.equal(await client.mailDomain.count({ where: { domain: "anything.example" } }), 0);
  });

  await t.test("defect 6: provider domain registration / verification trigger (flag, allowlist, step-up, link-not-create)", async () => {
    // Flag off (default): clear refusal.
    const offRegister = await call("ops", "POST", `/admin/domains/${cf.domain.id}/provider-registration`, { stepUpId: "x" });
    assert.equal(offRegister.status, 409, offRegister.text);
    assert.equal(offRegister.body.code, "MAIL_FEATURE_DISABLED");
    assert.equal(reasonOf(offRegister), "MAIL_PROVIDER_DOMAIN_MANAGEMENT_DISABLED");
    const offTrigger = await call("ops", "POST", `/admin/domains/${cf.domain.id}/verify`, { trigger: true });
    assert.equal(offTrigger.status, 409);

    const domAdapter = createFakeAdapter();
    const calls = { create: 0, verify: 0 };
    const failOnce = new Map([["ambiguous.example", "create-then-fail"], ["unknown-outcome.example", "fail-only"]]);
    const managed = {
      ...domAdapter,
      async createDomain(args) {
        calls.create += 1;
        const mode = failOnce.get(args.name);
        failOnce.delete(args.name);
        if (mode === "create-then-fail") await domAdapter.createDomain(args);
        if (mode) throw new MailProviderError("AMBIGUOUS", "RESEND_TIMEOUT", "timed out", { category: "OUTCOME_UNKNOWN" });
        return domAdapter.createDomain(args);
      },
      async verifyDomain(id) {
        calls.verify += 1;
        return domAdapter.verifyDomain(id);
      },
    };
    const allowlist = "cosmicforge.example,karryam.example,new-brand.example,linked-brand.example,ambiguous.example,unknown-outcome.example,lookup.example";
    const dm = harness.build({ MAIL_PROVIDER_DOMAIN_MANAGEMENT_ENABLED: "true", MAIL_DOMAIN_ALLOWLIST: allowlist }, { adapter: managed });
    const dmCall = await serve(dm);
    const ops = await user("ops");
    const local = async (name, app = dm) => app.services.admin.createDomain(ops, { organizationId: cf.organization.id, domain: name }, {});

    const fresh = await local("new-brand.example");
    const noStepUp = await dmCall("ops", "POST", `/admin/domains/${fresh.id}/provider-registration`, {});
    assert.equal(noStepUp.status, 403);
    assert.equal(noStepUp.body.code, "MAIL_STEP_UP_REQUIRED");
    assert.equal((await dmCall("mailAdmin", "POST", `/admin/domains/${fresh.id}/provider-registration`, { stepUpId: "x" })).status, 403, "no MFA, no registration");
    assert.equal((await dmCall("dave", "POST", `/admin/domains/${fresh.id}/provider-registration`, { stepUpId: "x" })).status, 403, "mail admin only");
    const created = await dmCall("ops", "POST", `/admin/domains/${fresh.id}/provider-registration`, { stepUpId: await stepUp(dmCall, "ops", "MAIL_DOMAIN_PROVIDER_MANAGE"), receiving: true, region: "eu-west-1" });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.body.data.registration, "CREATED");
    assert.match(created.body.data.providerDomainId, /^fake_dom_/);
    assert.equal(created.body.data.receivingStatus, "PENDING");
    assert.ok(created.body.data.checks);
    assert.equal(calls.create, 1);
    const again = await dmCall("ops", "POST", `/admin/domains/${fresh.id}/provider-registration`, { stepUpId: await stepUp(dmCall, "ops", "MAIL_DOMAIN_PROVIDER_MANAGE") });
    assert.equal(again.status, 409);
    assert.equal(reasonOf(again), "PROVIDER_DOMAIN_ALREADY_LINKED");
    assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MAIL_DOMAIN_PROVIDER_REGISTERED", targetId: fresh.id } }));

    // Already at the provider: linked, never created twice.
    await domAdapter.createDomain({ name: "linked-brand.example" });
    const linkedLocal = await local("linked-brand.example");
    const linked = await dmCall("ops", "POST", `/admin/domains/${linkedLocal.id}/provider-registration`, { stepUpId: await stepUp(dmCall, "ops", "MAIL_DOMAIN_PROVIDER_MANAGE") });
    assert.equal(linked.status, 200, linked.text);
    assert.equal(linked.body.data.registration, "LINKED_EXISTING");
    assert.equal(calls.create, 1);

    // Ambiguous create that did happen: looked up by name, linked.
    const ambiguous = await local("ambiguous.example");
    const ambiguousResult = await dmCall("ops", "POST", `/admin/domains/${ambiguous.id}/provider-registration`, { stepUpId: await stepUp(dmCall, "ops", "MAIL_DOMAIN_PROVIDER_MANAGE") });
    assert.equal(ambiguousResult.status, 200, ambiguousResult.text);
    assert.equal(ambiguousResult.body.data.registration, "LINKED_AFTER_AMBIGUOUS_CREATE");
    assert.equal([...domAdapter.state.domains.values()].filter((entry) => entry.name === "ambiguous.example").length, 1);

    // Ambiguous create that did not happen: reported, nothing linked; the retry creates.
    const unknown = await local("unknown-outcome.example");
    const unknownResult = await dmCall("ops", "POST", `/admin/domains/${unknown.id}/provider-registration`, { stepUpId: await stepUp(dmCall, "ops", "MAIL_DOMAIN_PROVIDER_MANAGE") });
    assert.equal(unknownResult.status, 503);
    assert.equal(reasonOf(unknownResult), "OUTCOME_UNKNOWN");
    assert.equal((await client.mailDomain.findUnique({ where: { id: unknown.id } })).providerDomainId, null);
    const retry = await dmCall("ops", "POST", `/admin/domains/${unknown.id}/provider-registration`, { stepUpId: await stepUp(dmCall, "ops", "MAIL_DOMAIN_PROVIDER_MANAGE") });
    assert.equal(retry.body.data.registration, "CREATED");

    // Not on the allowlist of the running config.
    const wider = harness.build({ MAIL_DOMAIN_ALLOWLIST: `${allowlist},wider-only.example` });
    const widerDomain = await local("wider-only.example", wider);
    const refused = await dmCall("ops", "POST", `/admin/domains/${widerDomain.id}/provider-registration`, { stepUpId: await stepUp(dmCall, "ops", "MAIL_DOMAIN_PROVIDER_MANAGE") });
    assert.equal(refused.status, 400);
    assert.equal(reasonOf(refused), "NOT_ALLOWLISTED");

    // Verify without a stored provider id: read-only lookup by name links it;
    // per-record results come back (DKIM failing, receiving fine).
    const lookupLocal = await local("lookup.example");
    const existing = await domAdapter.createDomain({ name: "lookup.example", receiving: true });
    Object.assign(domAdapter.state.domains.get(existing.providerDomainId), { status: "FAILED", sendingStatus: "FAILED", receivingStatus: "VERIFIED", spfStatus: "VERIFIED", dkimStatus: "FAILED", records: [{ record: "SPF", type: "TXT", name: "send", value: "v=spf1", status: "verified" }, { record: "DKIM", type: "TXT", name: "resend._domainkey", value: "p=x", status: "failed" }] });
    const verified = await dmCall("ops", "POST", `/admin/domains/${lookupLocal.id}/verify`, {});
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.body.data.providerLinked, true);
    assert.equal(verified.body.data.providerDomainId, existing.providerDomainId);
    assert.deepEqual({ spf: verified.body.data.checks.spf, dkim: verified.body.data.checks.dkim, dmarc: verified.body.data.checks.dmarc, receiving: verified.body.data.checks.receiving, receivesMail: verified.body.data.checks.receivesMail }, { spf: "VERIFIED", dkim: "FAILED", dmarc: "NOT_REPORTED", receiving: "VERIFIED", receivesMail: true });
    assert.ok(Array.isArray(verified.body.data.dnsRecords), "dnsRecords stays an array");
    const listed = await dmCall("ops", "GET", "/admin/domains");
    assert.equal(listed.body.data.find((row) => row.id === lookupLocal.id).checks.dkim, "FAILED");
    // Trigger a provider re-check (step-up).
    assert.equal((await dmCall("ops", "POST", `/admin/domains/${lookupLocal.id}/verify`, { trigger: true })).body.code, "MAIL_STEP_UP_REQUIRED");
    const triggered = await dmCall("ops", "POST", `/admin/domains/${lookupLocal.id}/verify?trigger=true`, { stepUpId: await stepUp(dmCall, "ops", "MAIL_DOMAIN_PROVIDER_MANAGE") });
    assert.equal(triggered.status, 200, triggered.text);
    assert.equal(triggered.body.data.verificationTriggered, true);
    assert.equal(calls.verify, 1);

    // A provider without the lifecycle methods: NOT_SUPPORTED.
    const bare = { ...domAdapter };
    delete bare.createDomain;
    delete bare.findDomainByName;
    delete bare.verifyDomain;
    const bareApp = harness.build({ MAIL_PROVIDER_DOMAIN_MANAGEMENT_ENABLED: "true", MAIL_DOMAIN_ALLOWLIST: allowlist }, { adapter: bare });
    await assert.rejects(bareApp.services.admin.registerProviderDomain(ops, unknown.id, { stepUpId: "x" }, {}), (error) => error.statusCode === 501 && error.errors?.[0]?.reason === "NOT_SUPPORTED");
  });

  await t.test("defect 9: address status transition table", async () => {
    const alias = await call("ops", "POST", "/admin/addresses", { domainId: cf.domain.id, localPart: "dave.alias", kind: "ALIAS", mailboxId: daveBox, aliasOfAddressId: (await client.mailAddress.findFirst({ where: { mailboxId: daveBox, kind: "PRIMARY" } })).id });
    assert.equal(alias.status, 201, alias.text);
    const id = alias.body.data.id;
    const patch = (status) => call("ops", "PATCH", `/admin/addresses/${id}`, { status });
    const noop = await patch("ACTIVE");
    assert.equal(noop.status, 409);
    assert.equal(reasonOf(noop), "NO_OP");
    assert.equal((await patch("SUSPENDED")).status, 200);
    assert.equal((await patch("SUSPENDED")).status, 409);
    assert.equal((await patch("ACTIVE")).status, 200);
    assert.equal((await patch("SUSPENDED")).status, 200);
    await setDomain({ status: "SUSPENDED" });
    const blocked = await patch("ACTIVE");
    assert.equal(blocked.status, 409);
    assert.equal(reasonOf(blocked), "DOMAIN_SUSPENDED");
    await restoreDomain();
    assert.equal((await patch("RETIRED")).status, 200);
    assert.equal((await patch("ACTIVE")).status, 409, "RETIRED is terminal");
    assert.equal((await patch("BOGUS")).status, 400);
  });

  await t.test("membership: nobody grants themselves shared-mailbox access; admin grants need step-up; managers unchanged", async () => {
    const shared = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "SHARED", purpose: "SUPPORT", name: "Help", address: { domainId: cf.domain.id, localPart: "help" } });
    assert.equal(shared.status, 201, shared.text);
    const members = `/mailboxes/${shared.body.data.id}/members`;
    const superSelf = await call("super", "POST", members, { adminUserId: ids.super, role: "MANAGER", canSend: true });
    assert.equal(superSelf.status, 403);
    assert.equal(reasonOf(superSelf), "SELF_GRANT_NOT_ALLOWED");
    const adminSelf = await call("mailAdmin", "POST", members, { adminUserId: ids.mailAdmin, role: "READER" });
    assert.equal(adminSelf.status, 403);
    assert.equal(reasonOf(adminSelf), "SELF_GRANT_NOT_ALLOWED");
    const opsSelf = await call("ops", "POST", members, { adminUserId: ids.ops, role: "MANAGER", stepUpId: await stepUp(call, "ops", "MAIL_MEMBERSHIP_GRANT") });
    assert.equal(opsSelf.status, 403, "a step-up does not make self-approval acceptable");
    assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MAIL_MEMBERSHIP_SELF_GRANT_REFUSED" } }));
    const noStepUp = await call("ops", "POST", members, { adminUserId: ids.erin, role: "MANAGER", canSend: true });
    assert.equal(noStepUp.status, 403);
    assert.equal(noStepUp.body.code, "MAIL_STEP_UP_REQUIRED");
    assert.equal(await client.mailMembership.count({ where: { mailboxId: shared.body.data.id, revokedAt: null } }), 0);
    const granted = await call("ops", "POST", members, { adminUserId: ids.erin, role: "MANAGER", canSend: true, stepUpId: await stepUp(call, "ops", "MAIL_MEMBERSHIP_GRANT") });
    assert.equal(granted.status, 201, granted.text);
    // The manager adds someone else without a step-up (unchanged flow) ...
    const byManager = await call("erin", "POST", members, { adminUserId: ids.dave, role: "MEMBER", canSend: true });
    assert.equal(byManager.status, 201, byManager.text);
    // ... but cannot re-grant or elevate their own membership.
    assert.equal((await call("erin", "POST", members, { adminUserId: ids.erin, role: "MANAGER", canSend: true })).status, 403);
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_MEMBERSHIP_GRANTED", targetId: granted.body.data.id } });
    assert.equal(audit.metadata.via, "admin");
    assert.equal(audit.metadata.stepUp, true);
  });
});
