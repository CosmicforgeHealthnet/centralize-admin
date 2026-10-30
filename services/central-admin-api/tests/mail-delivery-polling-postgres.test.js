"use strict";

// Delivery-status polling on real PostgreSQL (replayed migrations, offline
// fake provider). One Resend webhook serves both deployments and points at
// the inbound owner, which drops the other deployment's delivery events. A
// deployment that sends without owning the webhook therefore polls the
// provider for its own sends and records the status through the normal
// delivery-event applier.

const test = require("node:test");
const assert = require("node:assert/strict");
const { openDatabase, seed, createHarness, listen, caller } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");
const { loadMailConfig } = require("../src/modules/mail/mail.config");
const { requestToAddresses } = require("../src/modules/mail/pipelines/delivery-status-poller");

const EXT1 = "partner@partner.example";
const EXT2 = "client@client.example";
const NOT_OWNER = { MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production", MAIL_DEPLOYMENT_ENV: "staging", MAIL_TEST_RECIPIENT_ALLOWLIST: "partner.example,client.example" };

test("delivery polling config: on only where the webhook is not owned", () => {
  const base = { MAIL_ENABLED: "true", MAIL_SENDING_ENABLED: "true" };
  assert.equal(loadMailConfig({ ...base, MAIL_DEPLOYMENT_ENV: "staging", MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production" }).deliveryPolling.enabled, true, "staging sending, production owns the webhook");
  assert.equal(loadMailConfig({ ...base, MAIL_DEPLOYMENT_ENV: "production", MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production" }).deliveryPolling.enabled, false, "the webhook owner never polls");
  assert.equal(loadMailConfig({ ...base, MAIL_DEPLOYMENT_ENV: "staging" }).deliveryPolling.enabled, false, "no declared owner: webhook assumed here");
  assert.equal(loadMailConfig({ MAIL_ENABLED: "true", MAIL_DEPLOYMENT_ENV: "staging", MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production" }).deliveryPolling.enabled, false, "not sending: nothing to poll");
  assert.equal(loadMailConfig({ ...base, MAIL_DEPLOYMENT_ENV: "staging", MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production", MAIL_DELIVERY_STATUS_POLLING_ENABLED: "false" }).deliveryPolling.enabled, false, "explicit off");
  assert.equal(loadMailConfig({ ...base, MAIL_DEPLOYMENT_ENV: "production", MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production", MAIL_DELIVERY_STATUS_POLLING_ENABLED: "true" }).deliveryPolling.enabled, true, "explicit on");
  const tuned = loadMailConfig({ ...base, MAIL_DEPLOYMENT_ENV: "staging", MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production", MAIL_DELIVERY_STATUS_POLL_INTERVAL_SECONDS: "5", MAIL_DELIVERY_STATUS_POLL_MAX_PER_RUN: "1000" }).deliveryPolling;
  assert.equal(tuned.intervalSeconds, 30, "interval clamped");
  assert.equal(tuned.maxPerRun, 200, "batch clamped");
});

test("requestToAddresses lists what the provider's own webhook would name", () => {
  const message = { providerMessageId: "p1", recipients: [
    { type: "TO", address: "a@x.example", status: "PROVIDER_ACCEPTED", providerMessageId: null },
    { type: "CC", address: "b@x.example", status: "PROVIDER_ACCEPTED", providerMessageId: null },
    { type: "TO", address: "me@cosmicforge.example", status: "INTERNAL_DELIVERED", providerMessageId: null },
    { type: "BCC", address: "c@x.example", status: "PROVIDER_ACCEPTED", providerMessageId: "p2" },
  ] };
  assert.deepEqual(requestToAddresses(message, "p1"), ["a@x.example"]);
  assert.deepEqual(requestToAddresses(message, "p2"), ["c@x.example"], "individual BCC request");
});

test("delivery polling on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client, { env: NOT_OWNER });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const owner = harness.build({ MAIL_DEPLOYMENT_ENV: "production", MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production", MAIL_TEST_RECIPIENT_ALLOWLIST: "" });
  const { server, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  t.after(async () => {
    await closeServer(server);
    await db.close();
  });
  assert.equal(harness.mail.config.deliveryPolling.enabled, true);
  assert.equal(owner.config.deliveryPolling.enabled, false);

  const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: brands.cosmicforge.organization.id, type: "PERSONAL", ownerAdminUserId: ids.dave, address: { domainId: brands.cosmicforge.domain.id, localPart: "dave" } });
  assert.equal(box.status, 201, box.text);
  async function send(to) {
    const draft = await call("dave", "POST", `/mailboxes/${box.body.data.id}/drafts`, { to, subject: "Poll", text: "hello" });
    assert.equal(draft.status, 201, draft.text);
    const sent = await call("dave", "POST", `/drafts/${draft.body.data.id}/send`, { revision: draft.body.data.revision });
    assert.equal(sent.status, 202, sent.text);
    await harness.mail.createWorker({ queues: ["OUTBOUND"] }).drain({ maxTicks: 20 });
    return client.mailMessage.findUnique({ where: { id: sent.body.data.messageId }, include: { recipients: true } });
  }
  const poller = harness.mail.processors.deliveryStatusPoller;

  await t.test("accepted but no provider outcome yet: nothing recorded", async () => {
    const message = await send([EXT1]);
    assert.equal(message.status, "PROVIDER_ACCEPTED");
    const result = await poller.process();
    assert.equal(result.recorded, 0);
    assert.ok(result.unchanged >= 1);
    assert.equal(await client.mailDeliveryEvent.count({ where: { messageId: message.id } }), 0);
  });

  await t.test("provider reports delivered: recipient and message become DELIVERED, recorded once", async () => {
    const [message] = await client.mailMessage.findMany({ where: { direction: "OUTBOUND", status: "PROVIDER_ACCEPTED" }, include: { recipients: true } });
    harness.adapter.setDeliveryStatus(message.providerMessageId, "DELIVERED");
    const result = await poller.process();
    assert.equal(result.recorded, 1);
    const after = await client.mailMessage.findUnique({ where: { id: message.id }, include: { recipients: true } });
    assert.equal(after.status, "DELIVERED");
    assert.equal(after.recipients.find((r) => r.address === EXT1).status, "DELIVERED");
    const events = await client.mailDeliveryEvent.findMany({ where: { messageId: message.id } });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "DELIVERED");
    const source = await client.mailWebhookEvent.findUnique({ where: { id: events[0].webhookEventId } });
    assert.equal(source.provider, "resend-poll");
    assert.equal(source.signatureVerified, false, "provider API evidence, not a signed webhook");
    assert.equal(source.status, "PROCESSED");
    assert.equal(source.payload.data.html, undefined, "no content stored");
    // A later poll neither re-polls a finished message nor duplicates.
    const again = await poller.process();
    assert.equal(again.recorded, 0);
    assert.equal(await client.mailDeliveryEvent.count({ where: { messageId: message.id } }), 1);
    const audit = await client.mailAuditEvent.count({ where: { action: "MAIL_DELIVERY_DELIVERED", targetId: message.id } });
    assert.equal(audit, 1);
  });

  await t.test("same status observed twice is stored once (unique provider event)", async () => {
    const message = await send([EXT2]);
    harness.adapter.setDeliveryStatus(message.providerMessageId, "DELIVERY_DELAYED");
    await poller.process();
    await poller.process();
    const after = await client.mailMessage.findUnique({ where: { id: message.id } });
    assert.equal(after.status, "DELAYED", "DELAYED keeps it in the polled set");
    assert.equal(await client.mailDeliveryEvent.count({ where: { messageId: message.id, eventType: "DELIVERY_DELAYED" } }), 1);
    assert.equal(await client.mailWebhookEvent.count({ where: { provider: "resend-poll", providerEventId: `poll:${message.providerMessageId}:DELIVERY_DELAYED` } }), 1);
    harness.adapter.setDeliveryStatus(message.providerMessageId, "DELIVERED");
    await poller.process();
    assert.equal((await client.mailMessage.findUnique({ where: { id: message.id } })).status, "DELIVERED", "delayed then delivered");
  });

  await t.test("hard failure reported by the provider: FAILED and the sender is notified", async () => {
    const message = await send([EXT1]);
    harness.adapter.setDeliveryStatus(message.providerMessageId, "FAILED");
    const notified = () => client.notification.count({ where: { adminUserId: ids.dave, title: "Email delivery failed" } });
    const before = await notified();
    await poller.process();
    const after = await client.mailMessage.findUnique({ where: { id: message.id }, include: { recipients: true } });
    assert.equal(after.status, "FAILED");
    assert.equal(after.recipients.find((r) => r.address === EXT1).status, "FAILED", "single-recipient request: attributed");
    assert.equal(await notified(), before + 1, "sender notified once");
  });

  await t.test("provider unavailable for every candidate: retryable job failure", async () => {
    const message = await send([EXT2]);
    harness.adapter.failNext("retrieveDeliveryEvents", "transient", "PROVIDER_DOWN");
    await assert.rejects(() => poller.process(), (error) => error.code === "MAIL_PROVIDER_UNAVAILABLE");
    assert.equal((await client.mailMessage.findUnique({ where: { id: message.id } })).status, "PROVIDER_ACCEPTED", "nothing recorded on failure");
  });

  await t.test("the worker schedules one poll per interval on the EVENTS queue", async () => {
    await harness.mail.createWorker({ queues: ["EVENTS"] }).drain({ maxTicks: 10 });
    const jobs = await client.mailOutboxJob.findMany({ where: { kind: "POLL_DELIVERY_STATUS" } });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].queue, "EVENTS");
    assert.equal(jobs[0].status, "SUCCEEDED");
  });

  await t.test("the webhook owner never polls", async () => {
    assert.deepEqual(await owner.processors.deliveryStatusPoller.process(), { skipped: "DELIVERY_POLLING_DISABLED" });
    const before = await client.mailOutboxJob.count({ where: { kind: "POLL_DELIVERY_STATUS" } });
    harness.advance(10 * 60 * 1000);
    await owner.createWorker({ queues: ["EVENTS"] }).drain({ maxTicks: 5 });
    assert.equal(await client.mailOutboxJob.count({ where: { kind: "POLL_DELIVERY_STATUS" } }), before);
  });
});
