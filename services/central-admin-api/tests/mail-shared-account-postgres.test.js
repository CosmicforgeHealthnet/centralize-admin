"use strict";

// One Resend account, one API key and ONE webhook shared by CA staging, CA
// production and the KarryGo Notification Service. Regression tests for the
// guards that keep them apart: test-recipient allowlist, cf_app/cf_env tags
// on sends and inbound ownership in the worker. Webhook classification of
// these cases is tested with the webhook controller changes. Real
// PostgreSQL, fake provider, no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller } = require("./helpers/mail-test-harness");
const { createFakeAdapter } = require("../src/modules/mail/adapters/fake.adapter");
const { closeServer } = require("./helpers/server-close");

const ALLOWLIST = "tester@gmail.example,@approved.example";

test("Shared Resend account guards on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client, { env: { MAIL_TEST_RECIPIENT_ALLOWLIST: ALLOWLIST } });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const servers = [];
  const serve = async (application) => {
    const { server, base } = await listen(harness.mountApp(application));
    servers.push(server);
    return base;
  };
  const base = await serve(harness.mail);
  const call = caller(base, ids);
  t.after(async () => {
    for (const server of servers) await closeServer(server);
    await db.close();
  });
  const drain = (application = harness.mail) => application.createWorker().drain();
  await client.mailMembership.create({ data: { mailboxId: cf.mailbox.id, adminUserId: ids.dave, role: "MEMBER", canSend: true, grantedBy: ids.super, reason: "shared-account tests" } });
  const draftAndSend = async (to) => {
    const draft = await call("dave", "POST", `/mailboxes/${cf.mailbox.id}/drafts`, { to, subject: "Staging test", text: "hello" });
    assert.equal(draft.status, 201, draft.text);
    return call("dave", "POST", `/drafts/${draft.body.data.id}/send`, { revision: 1 });
  };
  const sentTo = (address) => harness.adapter.state.sent.filter((request) => [...request.to, ...(request.cc || []), ...(request.bcc || [])].some((party) => party.address === address));

  await t.test("test allowlist: unapproved external recipients are refused before queueing", async () => {
    const refused = await draftAndSend(["customer@real-customer.example"]);
    assert.equal(refused.status, 422, refused.text);
    assert.equal(refused.body.errors[0].reason, "RECIPIENT_NOT_APPROVED");
    const mixed = await draftAndSend(["tester@gmail.example", "someone@real-customer.example"]);
    assert.equal(mixed.status, 422, "one unapproved recipient refuses the whole send");
    assert.equal(sentTo("customer@real-customer.example").length, 0);
  });

  await t.test("test allowlist + tags: approved recipients are sent with cf_app/cf_env tags", async () => {
    const accepted = await draftAndSend(["tester@gmail.example", "qa@approved.example"]);
    assert.equal(accepted.status, 202, accepted.text);
    await drain();
    const [request] = sentTo("qa@approved.example");
    assert.ok(request, "sent to the approved domain");
    assert.deepEqual(request.tags, [{ name: "cf_app", value: "cosmicforge-mail" }, { name: "cf_env", value: "test" }]);
  });

  await t.test("test allowlist: the provider contract refuses mail queued before the allowlist narrowed (nothing submitted)", async () => {
    const queued = await draftAndSend(["late@approved.example"]);
    assert.equal(queued.status, 202, queued.text);
    const narrowed = harness.build({ MAIL_TEST_RECIPIENT_ALLOWLIST: "tester@gmail.example" });
    await drain(narrowed);
    assert.equal(sentTo("late@approved.example").length, 0, "no provider call");
    const job = await client.mailOutboxJob.findUnique({ where: { id: queued.body.data.jobId } });
    assert.notEqual(job.status, "PENDING", "processed, not left queued");
    const status = await call("dave", "GET", `/messages/${queued.body.data.messageId}/status`);
    assert.equal(status.body.data.status, "FAILED", "a refused send is a clean failure, never unknown or sent");
  });



  await t.test("inbound ownership: a deployment that does not own inbound mail defers queued jobs and does not reconcile", async () => {
    const recAdapter = createFakeAdapter();
    const elsewhere = harness.build({ MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production", MAIL_RECONCILIATION_ENABLED: "true" }, { adapter: recAdapter });
    assert.equal(elsewhere.config.inbound.ownedHere, false);
    recAdapter.addInbound("in_elsewhere_1", { from: { address: "partner@partner.example", name: null }, to: [{ address: "news@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [], subject: "x", html: null, text: "x", rfcMessageId: "<in-elsewhere-1@partner.example>", inReplyTo: null, references: [], receivedAt: new Date(harness.clock().getTime() - 3600000) });
    const job = { id: crypto.randomUUID(), payload: { providerEmailId: "in_elsewhere_1", to: ["news@cosmicforge.example"] }, webhookEventId: null };
    const deferred = await elsewhere.processors.inbound.process(job);
    assert.equal(deferred.defer.code, "MAIL_INBOUND_NOT_ACTIVE_HERE");
    assert.deepEqual(await elsewhere.processors.inboundReconciler.process(), { skipped: "INBOUND_NOT_ACTIVE_HERE" });
    assert.equal(await client.mailMessage.count({ where: { providerMessageId: "in_elsewhere_1" } }), 0);
    // The owner processes the same mail normally.
    const owner = harness.build({ MAIL_INBOUND_ACTIVE_ENVIRONMENT: "test" }, { adapter: recAdapter });
    assert.equal(owner.config.inbound.ownedHere, true);
    const delivered = await owner.processors.inbound.process(job);
    assert.equal(delivered.delivered, 1);
  });

});
