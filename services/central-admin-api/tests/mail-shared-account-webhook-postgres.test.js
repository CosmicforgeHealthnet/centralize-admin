"use strict";

// One Resend account, one API key and ONE webhook shared by CA staging, CA
// production and the KarryGo Notification Service. Regression tests for the
// webhook-side guards: cf_app/cf_env tags of the other CA deployment,
// broadcasts CA never dispatched, inbound ownership, and the KarryGo /
// HealthNet sender rules on top of them. Real PostgreSQL, fake provider,
// no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, postWebhook } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");

const ALLOWLIST = "tester@gmail.example,@approved.example";

test("Shared Resend account webhook guards on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client, { env: { MAIL_TEST_RECIPIENT_ALLOWLIST: ALLOWLIST } });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const servers = [];
  const serve = async (application) => {
    const { server, base } = await listen(harness.mountApp(application));
    servers.push(server);
    return base;
  };
  const base = await serve(harness.mail);
  t.after(async () => {
    for (const server of servers) await closeServer(server);
    await db.close();
  });
  const events = () => client.mailWebhookEvent.count();

  await t.test("tags: events for the other CA deployment are acknowledged and never stored", async () => {
    const before = await events();
    for (const tags of [{ cf_app: "cosmicforge-mail", cf_env: "production" }, [{ name: "cf_app", value: "cosmicforge-mail" }, { name: "cf_env", value: "staging" }]]) {
      const response = await postWebhook(base, harness.clock, "email.delivered", { email_id: `other_${crypto.randomUUID()}`, from: "news@cosmicforge.example", to: ["tester@gmail.example"], tags });
      assert.equal(response.status, 200);
      assert.equal(response.body.reason, "OTHER_DEPLOYMENT");
    }
    assert.equal(await events(), before);
    // Our own tag, another app's tags, or no tags: processed as before.
    for (const tags of [{ cf_app: "cosmicforge-mail", cf_env: "test" }, { cf_app: "karrygo", cf_env: "production" }, undefined]) {
      const response = await postWebhook(base, harness.clock, "email.delivered", { email_id: `own_${crypto.randomUUID()}`, from: "news@cosmicforge.example", to: ["tester@gmail.example"], ...(tags ? { tags } : {}) });
      assert.equal(response.status, 200);
      assert.equal(response.body.received, true, JSON.stringify(response.body));
    }
    assert.equal(await events(), before + 3);
  });
  await t.test("marketing isolation: broadcast events CA never dispatched are not stored", async () => {
    const before = await events();
    const foreign = await postWebhook(base, harness.clock, "email.delivered", { email_id: "bc_foreign_1", broadcast_id: "dashboard-campaign-1", from: "news@karryam.example", to: ["subscriber@gmail.example"] });
    assert.equal(foreign.status, 200);
    assert.equal(foreign.body.reason, "FOREIGN_BROADCAST");
    assert.equal(await events(), before);
  });
  await t.test("inbound ownership: the webhook of a deployment that does not own inbound mail answers 503 and stores nothing", async () => {
    const elsewhere = harness.build({ MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production" });
    const elsewhereBase = await serve(elsewhere);
    const before = await events();
    const refused = await postWebhook(elsewhereBase, harness.clock, "email.received", { email_id: "in_elsewhere_1", to: ["news@cosmicforge.example"] });
    assert.equal(refused.status, 503, "not acknowledged: the provider retries / redelivers to the owner");
    assert.equal(refused.body.code, "MAIL_INBOUND_NOT_ACTIVE_HERE");
    assert.equal(await events(), before);
    // Outbound events are still classified there (the owner rule is inbound only).
    const owner = harness.build({ MAIL_INBOUND_ACTIVE_ENVIRONMENT: "test" });
    const ownerBase = await serve(owner);
    const accepted = await postWebhook(ownerBase, harness.clock, "email.received", { email_id: "in_owner_1", to: ["news@cosmicforge.example"] });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.received, true);
  });
  await t.test("KarryGo / other products: OTP events from reserved or unprovisioned senders are still ignored", async () => {
    const before = await events();
    const otp = await postWebhook(base, harness.clock, "email.delivered", { email_id: "kg_otp_1", from: "Karryam <no-reply@karryam.example>", to: ["rider@gmail.example"], subject: "Your login code" });
    assert.equal(otp.body.reason, "FOREIGN_SENDER");
    const healthnet = await postWebhook(base, harness.clock, "email.bounced", { email_id: "hn_1", from: "alerts@healthnet.example", to: ["patient@gmail.example"] });
    assert.equal(healthnet.body.reason, "FOREIGN_SENDER");
    assert.equal(await events(), before);
  });
});
