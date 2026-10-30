"use strict";

// One Resend account, one webhook endpoint, several senders (CA staff mail,
// the KarryGo Notification Service's no-reply@karryam.com, other brands and
// HealthNet). Every signed event is classified before anything is stored:
// only CA's own outbound events and inbound mail for CA's domains are kept.
// Offline: real controller and verifier, fake database client.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { loadMailConfig } = require("../src/modules/mail/mail.config");
const { createResendWebhookHandler } = require("../src/modules/mail/webhooks/resend-webhook.controller");
const { signResendWebhook } = require("../src/modules/mail/webhooks/resend-webhook.verifier");

const SECRET = `whsec_${Buffer.from("shared-webhook-isolation-test-secret-0001").toString("base64")}`;
const NOW = Date.parse("2026-10-27T12:00:00Z");
const config = loadMailConfig({
  MAIL_DEPLOYMENT_ENV: "staging",
  MAIL_PROVIDER: "resend",
  MAIL_ENABLED: "true",
  MAIL_SENDING_ENABLED: "true",
  MAIL_RECEIVING_ENABLED: "true",
  MAIL_DOMAIN_ALLOWLIST: "karryam.com",
  MAIL_RESERVED_SENDER_ADDRESSES: "no-reply@karryam.com",
  RESEND_WEBHOOK_SECRET: SECRET,
});

function harness({ provisioned = ["support@karryam.com", "info@karryam.com"], sentIds = ["ca_sent_1"], failLookups = false } = {}) {
  const stored = [];
  const queued = [];
  const lookup = (rows, key) => async ({ where }) => {
    if (failLookups) throw Object.assign(new Error("connection lost"), { code: "P1001" });
    return rows.includes(where[key]) ? { id: `row_${where[key]}` } : null;
  };
  const client = {
    mailAddress: { findUnique: lookup(provisioned, "address") },
    mailMessage: { findFirst: lookup(sentIds, "providerMessageId") },
    mailMessageRecipient: { findFirst: lookup([], "providerMessageId") },
    marketingBroadcastRecipient: { findFirst: lookup([], "providerEmailId") },
    marketingAutomationStepRun: { findFirst: lookup([], "providerMessageId") },
    async $transaction(work) {
      return work({
        mailWebhookEvent: {
          findUnique: async () => null,
          create: async ({ data }) => {
            stored.push(data);
            return { id: `evt_${stored.length}` };
          },
        },
      });
    },
  };
  const jobs = { enqueue: async (_tx, job) => queued.push(job) };
  const handler = createResendWebhookHandler({ client, config, jobs, audit: null, logger: null, clock: () => NOW });
  async function post(type, data) {
    const id = `msg_${crypto.randomUUID()}`;
    const timestamp = Math.floor(NOW / 1000);
    const rawBody = Buffer.from(JSON.stringify({ type, created_at: new Date(NOW).toISOString(), data }));
    const headers = { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": signResendWebhook({ rawBody, secret: SECRET, id, timestamp }) };
    const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ headers, rawBody, params: {} }, res);
    return res;
  }
  return { post, stored, queued };
}

const KARRYGO_EVENTS = ["email.sent", "email.delivered", "email.delivery_delayed", "email.bounced", "email.complained", "email.failed", "email.suppressed"];

test("KarryGo no-reply events (every subscribed type, any From shape, with Cc/Bcc) are acknowledged and never stored", async () => {
  const h = harness();
  const froms = ["Karryam <no-reply@karryam.com>", "no-reply@karryam.com", '"Karryam" <NO-REPLY@KARRYAM.COM>', ["Karryam <no-reply@karryam.com>"], { email: "no-reply@karryam.com", name: "Karryam" }];
  for (const type of KARRYGO_EVENTS) {
    for (const from of froms) {
      const res = await h.post(type, { email_id: `kg_${crypto.randomUUID()}`, from, to: ["rider@gmail.example"], cc: ["ops@client.example"], bcc: ["audit@client.example"], subject: "Your login code" });
      assert.equal(res.statusCode, 200, `${type} ${JSON.stringify(from)}`);
      assert.equal(res.body.reason, "FOREIGN_SENDER");
    }
  }
  assert.equal(h.stored.length, 0);
  assert.equal(h.queued.length, 0);
});

test("other brands' and HealthNet's senders on the shared account are never stored, broadcasts included", async () => {
  const h = harness({ provisioned: ["support@karryam.com", "alerts@cosmicforge-healthnet.com"] });
  const cases = [
    ["email.delivered", { email_id: "hn_1", from: "HealthNet <alerts@cosmicforge-healthnet.com>", to: ["patient@gmail.example"] }],
    ["email.bounced", { email_id: "hn_2", from: "care@cosmicforge-healthnet.com", to: ["patient@gmail.example"], bounce: { type: "Permanent", message: "x" } }],
    ["email.delivered", { email_id: "mk_1", from: "Karryam News <news@marketing.karryam.com>", broadcast_id: "bc_other", to: ["fan@gmail.example"] }],
    ["email.complained", { email_id: "mk_2", from: "news@marketing.karryam.com", broadcast_id: "bc_other", to: ["fan@gmail.example"] }],
    ["email.delivered", { email_id: "ev_1", from: "Lookalike <support@karryam.com.evil.example>", to: ["x@gmail.example"] }],
  ];
  for (const [type, data] of cases) {
    const res = await h.post(type, data);
    assert.equal(res.statusCode, 200, data.email_id);
    assert.equal(res.body.ignored, true, data.email_id);
  }
  assert.equal(h.stored.length, 0, "a provisioned address on a non-allowlisted domain is still not CA's sender");
});

test("an event without a usable From is CA's only when CA sent that email id", async () => {
  const h = harness();
  for (const from of [undefined, null, "", "not an address", []]) {
    const res = await h.post("email.delivered", { email_id: "kg_unknown", ...(from === undefined ? {} : { from }), to: ["rider@gmail.example"] });
    assert.equal(res.statusCode, 200, JSON.stringify(from));
    assert.equal(res.body.reason, "FOREIGN_SENDER");
  }
  assert.equal(h.stored.length, 0);
  const own = await h.post("email.delivered", { email_id: "ca_sent_1", to: ["customer@client.example"] });
  assert.equal(own.statusCode, 200);
  assert.equal(own.body.received, true);
  assert.equal(h.stored.length, 1);
});

test("CA's own outbound events are stored and queued", async () => {
  const h = harness();
  const res = await h.post("email.delivered", { email_id: "ca_sent_2", from: "Karryam Support <support@karryam.com>", to: ["customer@client.example"] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.received, true);
  assert.equal(h.queued[0].kind, "PROCESS_DELIVERY_EVENT");
  const unprovisioned = await h.post("email.delivered", { email_id: "ca_sent_3", from: "sales@karryam.com", to: ["customer@client.example"] });
  assert.equal(unprovisioned.body.reason, "FOREIGN_SENDER", "an allowlisted domain alone is not enough");
});

test("an ownership lookup failure is not acknowledged and stores nothing", async () => {
  const h = harness({ failLookups: true });
  const res = await h.post("email.delivered", { email_id: "x_1", from: "support@karryam.com", to: ["customer@client.example"] });
  assert.equal(res.statusCode, 503);
  const noFrom = await h.post("email.delivered", { email_id: "x_2", to: ["customer@client.example"] });
  assert.equal(noFrom.statusCode, 503);
  assert.equal(h.stored.length, 0);
});

test("inbound: only CA-domain recipients are stored (a Bcc'd department included); other parties never are", async () => {
  const h = harness();
  const bcc = await h.post("email.received", { email_id: "in_1", from: "Client <client@partner.example>", to: ["client-team@partner.example"], cc: ["Boss <boss@partner.example>"], bcc: ["support@karryam.com"] });
  assert.equal(bcc.statusCode, 200);
  assert.deepEqual(h.stored[0].payload.data.to, ["support@karryam.com"]);
  assert.equal(h.stored[0].payload.data.cc, undefined);
  assert.equal(h.stored[0].payload.data.bcc, undefined);
  assert.deepEqual(h.queued[0].payload.to, ["support@karryam.com"]);
  // Another product's inbound mail on the shared account: no addresses are kept;
  // the inbound processor stores nothing because no CA address receives it.
  const healthnet = await h.post("email.received", { email_id: "in_2", from: "patient@gmail.example", to: ["records@cosmicforge-healthnet.com"] });
  assert.equal(healthnet.statusCode, 200);
  assert.deepEqual(h.stored[1].payload.data.to, []);
  assert.ok(!JSON.stringify(h.stored).includes("cosmicforge-healthnet.com"));
  assert.ok(!JSON.stringify(h.stored).includes("patient@"));
});

test("invalid signatures are refused before classification and store nothing", async () => {
  const h = harness();
  const handler = createResendWebhookHandler({ client: null, config, jobs: null, audit: null, logger: null, clock: () => NOW });
  const rawBody = Buffer.from(JSON.stringify({ type: "email.delivered", data: { email_id: "x", from: "no-reply@karryam.com" } }));
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ headers: { "svix-id": "msg_1", "svix-timestamp": String(Math.floor(NOW / 1000)), "svix-signature": "v1,AAAA" }, rawBody, params: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(h.stored.length, 0);
});
