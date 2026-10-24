"use strict";

// CosmicForge Mail M1-M6 integration tests against a disposable PostgreSQL
// database built by replaying the reviewed manual migrations (including the
// PostgreSQL-only triggers/partial indexes). The provider is the offline fake
// adapter, storage is encrypted in-memory, scanning is the test signature
// scanner. No external network calls are made.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const { PrismaClient } = require("../src/generated/admin-client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { replayVerify, dropDatabase } = require("../scripts/social-operations/db-replay-verify");
const { createMailApplication } = require("../src/modules/mail/application");
const { createMailRouter } = require("../src/modules/mail/http/mail.routes");
const { loadMailConfig } = require("../src/modules/mail/mail.config");
const { createFakeAdapter } = require("../src/modules/mail/adapters/fake.adapter");
const { memoryBackend } = require("../src/modules/mail/storage/mail-storage");
const { signatureScanner, EICAR } = require("../src/modules/mail/scanning/attachment-scanner");
const { signResendWebhook } = require("../src/modules/mail/webhooks/resend-webhook.verifier");
const { totpAt, decodeBase32 } = require("../src/modules/mail/authz/step-up.service");
const { errorHandler } = require("../src/shared/middlewares/error.middleware");
const { closeServer } = require("./helpers/server-close");

const BASE_DATABASE_URL = process.env.DATABASE_URL;
const WEBHOOK_SECRET = `whsec_${crypto.randomBytes(24).toString("base64")}`;
const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

const USERS = {
  super: { tier: "SUPER", name: "Super Admin" },
  mailAdmin: { tier: "ADMIN", name: "Mail Admin" },
  alice: { tier: "EMPLOYEE", name: "Alice Okafor" },
  bob: { tier: "EMPLOYEE", name: "Bob Mensah" },
  carol: { tier: "EMPLOYEE", name: "Carol Support" },
  dan: { tier: "EMPLOYEE", name: "Dan Support" },
  mallory: { tier: "EMPLOYEE", name: "Mallory Pending", status: "PENDING" },
  frank: { tier: "ADMIN", name: "Frank Investigator", twoFactor: true },
  grace: { tier: "EXECUTIVE", name: "Grace Approver", twoFactor: true },
  dave: { tier: "EMPLOYEE", name: "Dave Marketer", twoFactor: true },
  erin: { tier: "EMPLOYEE", name: "Erin Reviewer", twoFactor: true },
};

function uid(index) {
  return `c0000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function seedUsers(client) {
  const ids = {};
  let index = 1;
  for (const [key, spec] of Object.entries(USERS)) {
    ids[key] = uid(index++);
    await client.adminUser.create({
      data: {
        id: ids[key], email: `${key}@staff.example.invalid`, password: "test-only-hash", name: spec.name, tier: spec.tier,
        status: spec.status || "ACTIVE", mustChangePassword: false,
        twoFactorEnabled: Boolean(spec.twoFactor), twoFactorSecret: spec.twoFactor ? TOTP_SECRET : null,
      },
    });
  }
  const grant = (adminUserId, module, section, mode = "EDIT") => client.adminSectionGrant.create({ data: { adminUserId, module, section, mode, grantedBy: ids.super } });
  await grant(ids.mailAdmin, "mail", "admin");
  await grant(ids.frank, "mail", "break-glass-request");
  await grant(ids.grace, "mail", "break-glass-approve");
  return ids;
}

function createHarness(client) {
  let offsetMs = 0;
  const clock = () => new Date(Date.now() + offsetMs);
  const adapter = createFakeAdapter();
  const config = loadMailConfig({
    MAIL_ENABLED: "true", MAIL_SENDING_ENABLED: "true", MAIL_RECEIVING_ENABLED: "true", MAIL_MARKETING_ENABLED: "true", MAIL_WORKER_ENABLED: "true",
    MAIL_PROVIDER: "fake", RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET, MAIL_ENCRYPTION_KEYS: `v1:${crypto.randomBytes(32).toString("base64")}`,
    MAIL_WORKER_MAX_ATTEMPTS: "4", MAIL_UNKNOWN_RECIPIENT_POLICY: "reject",
  });
  const mail = createMailApplication({ client, config, adapter, storageBackend: memoryBackend(), scanner: signatureScanner(), logger: { info() {}, warn() {}, error() {} }, clock });
  const authenticate = async (req, res, next) => {
    try {
      const id = req.get("x-test-user");
      if (!id) return res.status(401).json({ success: false, message: "No token provided" });
      const user = await client.adminUser.findUnique({ where: { id }, select: { id: true, email: true, name: true, tier: true, status: true, twoFactorEnabled: true } });
      if (!user) return res.status(401).json({ success: false });
      if (user.status === "INACTIVE" || user.status === "LOCKED") return res.status(403).json({ success: false });
      req.adminUser = user;
      return next();
    } catch (error) {
      return next(error);
    }
  };
  const app = express();
  app.post("/api/mail/v1/webhooks/resend", express.raw({ type: "*/*", limit: "256kb" }), (req, res, next) => {
    req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    next();
  }, mail.webhookHandler);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/mail/v1", createMailRouter({ mail, authenticate, rateLimitMax: 10000 }));
  app.use(errorHandler);
  const worker = mail.createWorker();
  return { mail, app, adapter, worker, clock, advance: (ms) => { offsetMs += ms; } };
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}/api/mail/v1` };
}

function totp(clock) {
  return totpAt(decodeBase32(TOTP_SECRET), Math.floor(clock().getTime() / 30000));
}

test("CosmicForge Mail M1-M6 on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(BASE_DATABASE_URL, "DATABASE_URL is required");
  const replay = await replayVerify({ keep: true });
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: replay.replayUrl }) });
  await client.$connect();
  const harness = createHarness(client);
  const { server, base } = await listen(harness.app);
  const ids = await seedUsers(client);

  async function call(userKey, method, path, body, headers = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(userKey ? { "x-test-user": ids[userKey] } : {}), ...(body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, body: json, text, headers: response.headers };
  }

  async function webhook(type, data, { id = `msg_${crypto.randomUUID()}`, secret = WEBHOOK_SECRET } = {}) {
    const timestamp = Math.floor(harness.clock().getTime() / 1000);
    const rawBody = Buffer.from(JSON.stringify({ type, created_at: harness.clock().toISOString(), data }));
    const response = await fetch(`${base}/webhooks/resend`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": signResendWebhook({ id, timestamp, rawBody, secret }) },
      body: rawBody,
    });
    return { status: response.status, body: await response.json(), id };
  }

  async function drain() {
    harness.advance(4 * 3600 * 1000); // makes scheduled retries eligible
    await harness.worker.drain();
  }

  const state = {};
  try {
    await t.test("M1/M3: administration provisions organization, verified domain, mailboxes and addresses", async () => {
      const org = await call("mailAdmin", "POST", "/admin/organizations", { slug: "cosmicforge", name: "CosmicForge", kind: "COMPANY" });
      assert.equal(org.status, 201, org.text);
      state.orgId = org.body.data.id;
      const org2 = await call("mailAdmin", "POST", "/admin/organizations", { slug: "karryam", name: "Karryam Go" });
      state.org2Id = org2.body.data.id;
      assert.equal((await call("alice", "POST", "/admin/organizations", { slug: "evil", name: "Evil" })).status, 403);
      const domain = await call("mailAdmin", "POST", "/admin/domains", { organizationId: state.orgId, domain: "CosmicForge.Example", providerDomainId: "dom_1" });
      assert.equal(domain.status, 201, domain.text);
      assert.equal(domain.body.data.domain, "cosmicforge.example");
      state.domainId = domain.body.data.id;
      harness.adapter.state.domains.set("dom_1", { status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "VERIFIED", records: [] });
      const verified = await call("mailAdmin", "POST", `/admin/domains/${state.domainId}/verify`);
      assert.equal(verified.body.data.status, "VERIFIED");
      const domain2 = await call("mailAdmin", "POST", "/admin/domains", { organizationId: state.org2Id, domain: "karryam.example" });
      state.domain2Id = domain2.body.data.id;

      const make = async (body) => {
        const result = await call("mailAdmin", "POST", "/admin/mailboxes", body);
        assert.equal(result.status, 201, result.text);
        return result.body.data;
      };
      state.aliceBox = (await make({ organizationId: state.orgId, type: "PERSONAL", ownerAdminUserId: ids.alice, address: { domainId: state.domainId, localPart: "alice", displayName: "Alice Okafor" } })).id;
      state.bobBox = (await make({ organizationId: state.orgId, type: "PERSONAL", ownerAdminUserId: ids.bob, address: { domainId: state.domainId, localPart: "bob" } })).id;
      state.supportBox = (await make({ organizationId: state.orgId, type: "SHARED", purpose: "SUPPORT", name: "Help & Support", slaFirstResponseMinutes: 60, address: { domainId: state.domainId, localPart: "support", displayName: "CosmicForge Support" } })).id;
      state.newsBox = (await make({ organizationId: state.orgId, type: "SHARED", purpose: "MARKETING", name: "News", address: { domainId: state.domainId, localPart: "news" } })).id;

      const duplicate = await call("mailAdmin", "POST", "/admin/addresses", { domainId: state.domainId, localPart: "ALICE", kind: "ALIAS", mailboxId: state.bobBox, aliasOfAddressId: crypto.randomUUID() });
      assert.equal(duplicate.status, 400, "alias target must exist");
      const addresses = await call("mailAdmin", "GET", "/admin/addresses");
      state.addr = Object.fromEntries(addresses.body.data.map((row) => [row.localPart, row]));
      const taken = await call("mailAdmin", "POST", "/admin/addresses", { domainId: state.domainId, localPart: "Alice", kind: "ALIAS", mailboxId: state.aliceBox, aliasOfAddressId: state.addr.alice.id });
      assert.equal(taken.status, 409, "normalized address cannot be assigned twice");
      const alias = await call("mailAdmin", "POST", "/admin/addresses", { domainId: state.domainId, localPart: "a.okafor", kind: "ALIAS", mailboxId: state.aliceBox, aliasOfAddressId: state.addr.alice.id });
      assert.equal(alias.status, 201, alias.text);
      const aliasOfAlias = await call("mailAdmin", "POST", "/admin/addresses", { domainId: state.domainId, localPart: "ao", kind: "ALIAS", mailboxId: state.aliceBox, aliasOfAddressId: alias.body.data.id });
      assert.equal(aliasOfAlias.status, 409);
      assert.equal(aliasOfAlias.body.code, "MAIL_ALIAS_LOOP");
      const addCarol = await call("mailAdmin", "POST", `/mailboxes/${state.supportBox}/members`, { adminUserId: ids.carol, role: "MEMBER", canSend: true });
      assert.equal(addCarol.status, 201, addCarol.text);
      state.danMembership = (await call("mailAdmin", "POST", `/mailboxes/${state.supportBox}/members`, { adminUserId: ids.dan, role: "MEMBER", canSend: true })).body.data.id;
    });

    await t.test("M1: SUPER and mail admins never gain private mailbox access; inactive identities are rejected", async () => {
      const superBoxes = await call("super", "GET", "/me/mailboxes");
      assert.equal(superBoxes.status, 200);
      assert.deepEqual(superBoxes.body.data, []);
      assert.equal((await call("super", "GET", `/mailboxes/${state.aliceBox}`)).status, 404);
      assert.equal((await call("super", "GET", `/mailboxes/${state.aliceBox}/threads`)).status, 404);
      assert.equal((await call("mailAdmin", "GET", `/mailboxes/${state.aliceBox}/threads`)).status, 404);
      const selfAdd = await call("mailAdmin", "POST", `/mailboxes/${state.aliceBox}/members`, { adminUserId: ids.mailAdmin, role: "READER" });
      assert.equal(selfAdd.status, 403, "admins cannot join personal mailboxes");
      assert.equal((await call("super", "POST", `/mailboxes/${state.aliceBox}/members`, { adminUserId: ids.super, role: "READER" })).status, 403);
      const pending = await call("mallory", "GET", "/me/mailboxes");
      assert.equal(pending.status, 403);
      assert.equal(pending.body.code, "MAIL_IDENTITY_INACTIVE");
      assert.equal((await call(null, "GET", "/me/mailboxes")).status, 401);
      const entitlements = await call("alice", "GET", "/me/entitlements");
      assert.equal(entitlements.body.data.mailboxes.length, 1);
      assert.equal(entitlements.body.data.canManageDomains, false);
    });

    await t.test("M3: drafts use optimistic concurrency and From is server-authorized", async () => {
      const mailbox = await call("alice", "GET", `/mailboxes/${state.aliceBox}`);
      assert.deepEqual(mailbox.body.data.senderIdentities.map((identity) => identity.address).sort(), ["a.okafor@cosmicforge.example", "alice@cosmicforge.example"]);
      const draft = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["bob@cosmicforge.example", '"Ext" <ext@partner.example>'], bcc: ["hidden@partner.example"], subject: "Quarterly report", html: "<p>Numbers attached & <b>bold</b><script>alert(1)</script></p>" });
      assert.equal(draft.status, 201, draft.text);
      assert.ok(!draft.body.data.html.includes("<script"));
      state.draftId = draft.body.data.id;
      const updated = await call("alice", "PATCH", `/drafts/${state.draftId}`, { revision: 1, subject: "Quarterly report Q3" });
      assert.equal(updated.body.data.revision, 2);
      const stale = await call("alice", "PATCH", `/drafts/${state.draftId}`, { revision: 1, subject: "overwrite" });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, "MAIL_DRAFT_REVISION_CONFLICT");
      const spoof = await call("alice", "PATCH", `/drafts/${state.draftId}`, { revision: 2, senderAddressId: state.addr.bob.id });
      assert.equal(spoof.status, 403);
      assert.equal(spoof.body.code, "MAIL_SENDER_NOT_AUTHORIZED");
      assert.equal((await call("bob", "GET", `/drafts/${state.draftId}`)).status, 404, "drafts are private");
      const injection = await call("alice", "PATCH", `/drafts/${state.draftId}`, { revision: 2, to: ["victim@x.example\r\nBcc: other@x.example"] });
      assert.equal(injection.status, 400);
      const file = new FormData();
      file.append("file", new Blob([Buffer.from("quarterly numbers")], { type: "text/plain" }), "q3.txt");
      const attachment = await call("alice", "POST", `/drafts/${state.draftId}/attachments`, file);
      assert.equal(attachment.status, 201, attachment.text);
      assert.equal(attachment.body.data.scanStatus, "CLEAN");
    });

    await t.test("M2/M3: send returns 202 with durable job; internal copies hide BCC; worker never double-sends", async () => {
      const sent = await call("alice", "POST", `/drafts/${state.draftId}/send`, { revision: 2 }, { "Idempotency-Key": "client-key-0001" });
      assert.equal(sent.status, 202, sent.text);
      assert.equal(sent.body.data.status, "QUEUED");
      assert.ok(sent.body.data.jobId);
      state.sentMessageId = sent.body.data.messageId;
      state.aliceThreadId = sent.body.data.threadId;
      const replayed = await call("alice", "POST", `/drafts/${state.draftId}/send`, { revision: 2 }, { "Idempotency-Key": "client-key-0001" });
      assert.equal(replayed.body.data.messageId, state.sentMessageId, "client idempotency key returns the same message");
      const bobThreads = await call("bob", "GET", `/mailboxes/${state.bobBox}/threads?view=inbox`);
      assert.equal(bobThreads.body.data.length, 1);
      assert.equal(bobThreads.body.data[0].isRead, false);
      const bobMessages = await call("bob", "GET", `/threads/${bobThreads.body.data[0].id}/messages`);
      assert.ok(!bobMessages.body.data[0].recipients.some((recipient) => recipient.type === "BCC"), "BCC must not leak to recipients");
      assert.equal(bobMessages.body.data[0].attachments.length, 1);
      const aliceMessages = await call("alice", "GET", `/threads/${state.aliceThreadId}/messages`);
      assert.ok(aliceMessages.body.data[0].recipients.some((recipient) => recipient.type === "BCC" && recipient.address === "hidden@partner.example"));
      assert.equal(aliceMessages.body.data[0].status, "QUEUED");

      await drain();
      await drain();
      assert.equal(harness.adapter.state.sent.length, 1, "exactly one provider send");
      const request = harness.adapter.state.sent[0];
      assert.equal(request.from.address, "alice@cosmicforge.example");
      assert.deepEqual(request.bcc.map((party) => party.address), ["hidden@partner.example"]);
      assert.equal(request.attachments.length, 1);
      assert.equal(request.attachments[0].content.toString(), "quarterly numbers");
      const status = await call("alice", "GET", `/messages/${state.sentMessageId}/status`);
      assert.equal(status.body.data.status, "PROVIDER_ACCEPTED", "provider acceptance is not delivery");
      state.providerMessageId = request.providerMessageId;
      state.rfcMessageId = (await client.mailMessage.findUnique({ where: { id: state.sentMessageId } })).rfcMessageId;
      assert.equal((await call("bob", "GET", `/messages/${state.sentMessageId}/status`)).status, 404);
    });

    await t.test("M2: ambiguous provider timeout reconciles with the same idempotency key; crashed leases recover", async () => {
      const draft = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["timeout@partner.example"], subject: "Ambiguous", text: "hello" });
      harness.adapter.failNext("sendMessage", "AMBIGUOUS", "PROVIDER_TIMEOUT", { acceptBeforeFailing: true });
      const sent = await call("alice", "POST", `/drafts/${draft.body.data.id}/send`, { revision: 1 });
      assert.equal(sent.status, 202);
      await harness.worker.drain({ maxTicks: 1 });
      let job = await client.mailOutboxJob.findUnique({ where: { id: sent.body.data.jobId } });
      assert.equal(job.status, "RECONCILING");
      const before = harness.adapter.state.sent.length;
      await drain();
      job = await client.mailOutboxJob.findUnique({ where: { id: sent.body.data.jobId } });
      assert.equal(job.status, "SUCCEEDED");
      assert.equal(harness.adapter.state.sent.length, before, "no duplicate provider email after ambiguous timeout");

      const draft2 = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["crash@partner.example"], subject: "Crash", text: "x" });
      const sent2 = await call("alice", "POST", `/drafts/${draft2.body.data.id}/send`, { revision: 1 });
      await client.mailOutboxJob.update({ where: { id: sent2.body.data.jobId }, data: { status: "LEASED", leaseOwner: "dead-worker", leaseExpiresAt: new Date(harness.clock().getTime() - 1000), attemptCount: 1 } });
      await drain();
      const recovered = await client.mailOutboxJob.findUnique({ where: { id: sent2.body.data.jobId } });
      assert.equal(recovered.status, "SUCCEEDED");
      assert.equal(harness.adapter.state.sent.filter((entry) => entry.to.some((party) => party.address === "crash@partner.example")).length, 1);

      const draft3 = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["reject@partner.example"], subject: "Permanent", text: "x" });
      harness.adapter.failNext("sendMessage", "PERMANENT", "RESEND_HTTP_422");
      const sent3 = await call("alice", "POST", `/drafts/${draft3.body.data.id}/send`, { revision: 1 });
      await drain();
      assert.equal((await call("alice", "GET", `/messages/${sent3.body.data.messageId}/status`)).body.data.status, "FAILED");
      const notices = await client.notification.findMany({ where: { adminUserId: ids.alice, title: "Email could not be sent" } });
      assert.equal(notices.length, 1);

      const outage = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["outage@partner.example"], subject: "Outage", text: "x" });
      for (let index = 0; index < 4; index += 1) harness.adapter.failNext("sendMessage", "RETRYABLE", "RESEND_HTTP_503");
      const sent4 = await call("alice", "POST", `/drafts/${outage.body.data.id}/send`, { revision: 1 });
      for (let index = 0; index < 5; index += 1) await drain();
      const dead = await client.mailOutboxJob.findUnique({ where: { id: sent4.body.data.jobId } });
      assert.equal(dead.status, "DEAD_LETTER", "provider outage exhausts to dead letter, never silent success");
      assert.equal((await call("alice", "GET", `/messages/${sent4.body.data.messageId}/status`)).body.data.status, "FAILED");
    });

    await t.test("M2: signed webhooks are durable and deduplicated; delivery events update honest status", async () => {
      const bad = await webhook("email.delivered", { email_id: state.providerMessageId, to: ["ext@partner.example"] }, { secret: `whsec_${crypto.randomBytes(24).toString("base64")}` });
      assert.equal(bad.status, 401);
      const delivered = await webhook("email.delivered", { email_id: state.providerMessageId, to: ["ext@partner.example"] });
      assert.equal(delivered.status, 200);
      assert.equal(delivered.body.duplicate, false);
      const replayed = await webhook("email.delivered", { email_id: state.providerMessageId, to: ["ext@partner.example"] }, { id: delivered.id });
      assert.equal(replayed.body.duplicate, true);
      assert.equal(await client.mailWebhookEvent.count({ where: { providerEventId: delivered.id } }), 1);
      await drain();
      let status = (await call("alice", "GET", `/messages/${state.sentMessageId}/status`)).body.data;
      assert.equal(status.recipients.find((recipient) => recipient.address === "ext@partner.example").status, "DELIVERED");
      assert.equal(status.status, "PROVIDER_ACCEPTED", "not every external recipient is delivered yet");
      await webhook("email.bounced", { email_id: state.providerMessageId, to: ["hidden@partner.example"], bounce: { type: "Permanent", message: "mailbox unknown" } });
      await drain();
      status = (await call("alice", "GET", `/messages/${state.sentMessageId}/status`)).body.data;
      assert.equal(status.status, "BOUNCED");
      assert.equal(await client.marketingSuppression.count({ where: { email: "hidden@partner.example", reason: "BOUNCED", liftedAt: null } }), 1);
      assert.equal(status.recipients.find((recipient) => recipient.address === "bob@cosmicforge.example").status, "INTERNAL_DELIVERED");
    });

    await t.test("M2: inbound mail is routed, threaded by RFC ids, sanitized, scanned and unknown recipients rejected", async () => {
      harness.adapter.addInbound("in_support_1", {
        from: { address: "customer@client.example", name: "Customer" }, to: [{ address: "support@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [],
        subject: "Cannot log in", html: '<p onmouseover="x()">Help<script>steal()</script><img src="https://tracker.example/t.gif"></p>', text: "Help", rfcMessageId: "<cust-1@client.example>", inReplyTo: null, references: [], receivedAt: harness.clock(),
      }, [{ filename: "screenshot.txt", contentType: "text/plain", content: Buffer.from("clean evidence") }]);
      const accepted = await webhook("email.received", { email_id: "in_support_1", to: ["support@cosmicforge.example", "nobody@cosmicforge.example"] });
      assert.equal(accepted.status, 200);
      harness.adapter.addInbound("in_virus", {
        from: { address: "attacker@bad.example", name: null }, to: [{ address: "support@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [],
        subject: "Invoice", html: null, text: "open me", rfcMessageId: "<virus@bad.example>", inReplyTo: null, references: [], receivedAt: harness.clock(),
      }, [{ filename: "invoice.txt", contentType: "text/plain", content: Buffer.from(EICAR) }]);
      await webhook("email.received", { email_id: "in_virus", to: ["support@cosmicforge.example"] });
      harness.adapter.addInbound("in_reply", {
        from: { address: "ext@partner.example", name: "Ext" }, to: [{ address: "alice@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [],
        subject: "Re: Quarterly report Q3", html: "<p>Thanks</p>", text: "Thanks", rfcMessageId: "<reply-1@partner.example>", inReplyTo: state.rfcMessageId, references: [state.rfcMessageId], receivedAt: harness.clock(),
      });
      await webhook("email.received", { email_id: "in_reply", to: ["alice@cosmicforge.example"] });
      harness.adapter.addInbound("in_same_subject", {
        from: { address: "other@unrelated.example", name: null }, to: [{ address: "alice@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [],
        subject: "Re: Quarterly report Q3", html: null, text: "unrelated", rfcMessageId: "<unrelated@unrelated.example>", inReplyTo: null, references: [], receivedAt: harness.clock(),
      });
      await webhook("email.received", { email_id: "in_same_subject", to: ["alice@cosmicforge.example"] });
      // Provider echo of Alice's own send to Bob must not double-deliver.
      harness.adapter.addInbound("in_echo", {
        from: { address: "alice@cosmicforge.example", name: "Alice" }, to: [{ address: "bob@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [],
        subject: "Quarterly report Q3", html: null, text: "dup", rfcMessageId: state.rfcMessageId, inReplyTo: null, references: [], receivedAt: harness.clock(),
      });
      await webhook("email.received", { email_id: "in_echo", to: ["bob@cosmicforge.example"] });
      await drain();

      const queue = await call("carol", "GET", `/mailboxes/${state.supportBox}/queue?status=OPEN`);
      assert.equal(queue.status, 200, queue.text);
      assert.equal(queue.body.data.length, 1, "malicious message is quarantined to spam, not the queue");
      state.supportThreadId = queue.body.data[0].id;
      assert.ok(queue.body.data[0].slaDueAt, "SLA due time set from mailbox policy");
      const messages = await call("carol", "GET", `/threads/${state.supportThreadId}/messages`);
      const html = messages.body.data[0].html;
      assert.ok(!html.includes("<script") && !html.includes("onmouseover") && !html.includes("tracker.example"));
      assert.equal(messages.body.data[0].remoteImagesBlocked, 1);
      const download = await call("carol", "GET", `/attachments/${messages.body.data[0].attachments[0].id}/download`);
      assert.equal(download.status, 200);
      assert.equal(download.text, "clean evidence");
      assert.equal(download.headers.get("x-content-type-options"), "nosniff");
      assert.match(download.headers.get("content-disposition"), /^attachment;/);
      const spam = await call("carol", "GET", `/mailboxes/${state.supportBox}/threads?view=spam`);
      assert.equal(spam.body.data.length, 1);
      const virusMessages = await call("carol", "GET", `/threads/${spam.body.data[0].id}/messages`);
      assert.equal(virusMessages.body.data[0].status, "QUARANTINED");
      assert.equal(virusMessages.body.data[0].attachments[0].scanStatus, "INFECTED");
      const blocked = await call("carol", "GET", `/attachments/${virusMessages.body.data[0].attachments[0].id}/download`);
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.code, "MAIL_ATTACHMENT_QUARANTINED");
      assert.equal((await call("bob", "GET", `/attachments/${messages.body.data[0].attachments[0].id}/download`)).status, 404, "non-members cannot fetch attachments");

      assert.equal(await client.mailAuditEvent.count({ where: { action: "MAIL_INBOUND_UNKNOWN_RECIPIENT_REJECTED" } }), 1);
      const aliceThread = await call("alice", "GET", `/threads/${state.aliceThreadId}`);
      assert.equal(aliceThread.body.data.messageCount, 2, "reply threaded via In-Reply-To");
      const aliceInbox = await call("alice", "GET", `/mailboxes/${state.aliceBox}/threads?view=inbox`);
      assert.equal(aliceInbox.body.data.length, 2, "same subject without references is a separate thread");
      const bobThreads = await call("bob", "GET", `/mailboxes/${state.bobBox}/threads?view=all`);
      assert.equal(bobThreads.body.data.length, 1);
      assert.equal(bobThreads.body.data[0].messageCount, 1, "provider echo deduplicated by Message-ID");
    });

    await t.test("M3: search, labels, per-user state and bulk actions stay tenant scoped", async () => {
      const found = await call("alice", "GET", "/search?q=quarterly");
      assert.ok(found.body.data.length >= 1);
      assert.ok(found.body.data.every((thread) => thread.mailboxId === state.aliceBox));
      assert.deepEqual((await call("super", "GET", "/search?q=quarterly")).body.data, []);
      const bobSearch = await call("bob", "GET", "/search?q=quarterly");
      assert.ok(bobSearch.body.data.every((thread) => thread.mailboxId === state.bobBox));
      assert.equal((await call("bob", "GET", `/mailboxes/${state.aliceBox}/search?q=quarterly`)).status, 404);
      assert.equal((await call("alice", "GET", "/search")).status, 400);

      const label = await call("alice", "POST", `/mailboxes/${state.aliceBox}/labels`, { name: "Finance", color: "#272EA7" });
      assert.equal((await call("alice", "PUT", `/threads/${state.aliceThreadId}/labels/${label.body.data.id}`)).status, 200);
      const labelled = await call("alice", "GET", `/mailboxes/${state.aliceBox}/threads?view=all&labelId=${label.body.data.id}`);
      assert.equal(labelled.body.data.length, 1);
      assert.equal((await call("bob", "PUT", `/threads/${state.aliceThreadId}/labels/${label.body.data.id}`)).status, 404);

      const bulk = await call("bob", "POST", `/mailboxes/${state.bobBox}/threads/bulk`, { threadIds: [state.aliceThreadId], action: "trash" });
      assert.equal(bulk.body.data.updated, 0, "bulk actions cannot touch another mailbox's threads");
      await call("carol", "GET", `/threads/${state.supportThreadId}/messages`);
      const carolView = await call("carol", "GET", `/threads/${state.supportThreadId}`);
      const danView = await call("dan", "GET", `/threads/${state.supportThreadId}`);
      assert.equal(carolView.body.data.isRead, true);
      assert.equal(danView.body.data.isRead, false, "read state is per user");
      const starred = await call("dan", "PATCH", `/threads/${state.supportThreadId}/state`, { isStarred: true });
      assert.equal(starred.body.data.isStarred, true);
      assert.equal((await call("carol", "GET", `/mailboxes/${state.supportBox}/threads?view=starred`)).body.data.length, 0);
      const cursorPage = await call("alice", "GET", `/mailboxes/${state.aliceBox}/threads?view=all&limit=1`);
      assert.equal(cursorPage.body.data.length, 1);
      assert.ok(cursorPage.body.meta.nextCursor);
      const next = await call("alice", "GET", `/mailboxes/${state.aliceBox}/threads?view=all&limit=1&cursor=${cursorPage.body.meta.nextCursor}`);
      assert.notEqual(next.body.data[0].id, cursorPage.body.data[0].id);
    });

    await t.test("M5: shared support assignment, notes, status revision, collision lock and revocation", async () => {
      const assigned = await call("carol", "POST", `/threads/${state.supportThreadId}/assign`, { assigneeAdminUserId: ids.carol });
      assert.equal(assigned.body.data.assignedTo.id, ids.carol);
      assert.equal((await call("carol", "POST", `/threads/${state.supportThreadId}/assign`, { assigneeAdminUserId: ids.bob })).status, 400, "assignee must be a member");
      const thread = (await call("carol", "GET", `/threads/${state.supportThreadId}`)).body.data;
      const stale = await call("dan", "POST", `/threads/${state.supportThreadId}/status`, { status: "RESOLVED", revision: thread.revision - 1 });
      assert.equal(stale.status, 409);
      const pending = await call("carol", "POST", `/threads/${state.supportThreadId}/status`, { status: "PENDING", revision: thread.revision });
      assert.equal(pending.body.data.conversationStatus, "PENDING");
      const note = await call("carol", "POST", `/threads/${state.supportThreadId}/notes`, { body: "Customer verified via phone", mentions: [ids.dan, ids.bob] });
      assert.deepEqual(note.body.data.mentions, [ids.dan], "only members can be mentioned");
      assert.equal((await call("dan", "GET", `/threads/${state.supportThreadId}/notes`)).body.data.length, 1);
      assert.equal((await call("bob", "GET", `/threads/${state.supportThreadId}/notes`)).status, 404);

      assert.equal((await call("carol", "POST", `/threads/${state.supportThreadId}/lock`)).status, 200);
      const collision = await call("dan", "POST", `/threads/${state.supportThreadId}/lock`);
      assert.equal(collision.status, 409);
      assert.equal(collision.body.errors[0].lockedBy.id, ids.carol);
      const lockedView = await call("dan", "GET", `/threads/${state.supportThreadId}`);
      assert.equal(lockedView.body.data.lockedBy.name, "Carol Support");
      const firstMessage = (await call("dan", "GET", `/threads/${state.supportThreadId}/messages`)).body.data[0];
      const danDraft = await call("dan", "POST", `/mailboxes/${state.supportBox}/drafts`, { mode: "REPLY", inReplyToMessageId: firstMessage.id });
      assert.equal(danDraft.body.data.to[0].address, "customer@client.example");
      assert.equal((await call("carol", "GET", `/drafts/${danDraft.body.data.id}`)).status, 404, "teammates cannot see each other's drafts");
      const blockedReply = await call("dan", "POST", `/drafts/${danDraft.body.data.id}/send`, { revision: 1 });
      assert.equal(blockedReply.status, 409);
      assert.equal(blockedReply.body.code, "MAIL_CONVERSATION_LOCKED");
      const carolDraft = await call("carol", "POST", `/mailboxes/${state.supportBox}/drafts`, { mode: "REPLY", inReplyToMessageId: firstMessage.id, html: "<p>We reset your access.</p>" });
      assert.equal(carolDraft.body.data.senderAddressId, state.addr.support.id, "shared mailbox sends as the shared identity");
      const reply = await call("carol", "POST", `/drafts/${carolDraft.body.data.id}/send`, { revision: 1 });
      assert.equal(reply.status, 202, reply.text);
      const after = (await call("carol", "GET", `/threads/${state.supportThreadId}`)).body.data;
      assert.ok(after.firstResponseAt, "first response recorded for SLA");
      assert.equal(after.lockedBy, null, "sending releases the lock");
      await drain();
      const sentRequest = harness.adapter.state.sent.find((entry) => entry.to.some((party) => party.address === "customer@client.example"));
      assert.equal(sentRequest.from.address, "support@cosmicforge.example");
      assert.equal(sentRequest.headers["In-Reply-To"], "<cust-1@client.example>");
      const replyMessage = await client.mailMessage.findUnique({ where: { id: reply.body.data.messageId } });
      assert.equal(replyMessage.sentByAdminUserId, ids.carol, "shared sender attribution is preserved");
      const activity = await call("carol", "GET", `/threads/${state.supportThreadId}/activity`);
      assert.ok(activity.body.data.some((event) => event.action === "MAIL_CONVERSATION_ASSIGNED"));

      const revoke = await call("mailAdmin", "DELETE", `/mailboxes/${state.supportBox}/members/${state.danMembership}`);
      assert.equal(revoke.status, 200);
      assert.equal((await call("dan", "GET", `/threads/${state.supportThreadId}`)).status, 404, "revocation applies on the next request");
      assert.equal((await call("dan", "GET", "/support/mailboxes")).body.data.length, 0);
      assert.equal((await call("carol", "GET", "/support/mailboxes")).body.data[0].openCount >= 0, true);
    });

    await t.test("M1: step-up MFA, break-glass approval and audited READER-only access", async () => {
      assert.equal((await call("frank", "GET", `/mailboxes/${state.aliceBox}/threads`)).status, 404);
      const noMfa = await call("alice", "POST", "/security/step-up", { code: "123456", purpose: "BREAK_GLASS_REQUEST" });
      assert.equal(noMfa.body.code, "MAIL_MFA_NOT_ENROLLED", "twoFactorEnabled without a verified code is never enough");
      const wrong = await call("frank", "POST", "/security/step-up", { code: "000000", purpose: "BREAK_GLASS_REQUEST" });
      assert.equal(wrong.status, 403);
      const stepUp = await call("frank", "POST", "/security/step-up", { code: totp(harness.clock), purpose: "BREAK_GLASS_REQUEST" });
      assert.equal(stepUp.status, 201, stepUp.text);
      const replay = await call("frank", "POST", "/security/step-up", { code: totp(harness.clock), purpose: "BREAK_GLASS_REQUEST" });
      assert.equal(replay.status, 403, "a TOTP code cannot be replayed");
      const request = await call("frank", "POST", "/break-glass/requests", { mailboxId: state.aliceBox, justification: "Legal discovery request for the Q3 report thread", caseReference: "LEGAL-42", stepUpId: stepUp.body.data.stepUpId });
      assert.equal(request.status, 201, request.text);
      const reuse = await call("frank", "POST", "/break-glass/requests", { mailboxId: state.aliceBox, justification: "Legal discovery request for the Q3 report thread", caseReference: "LEGAL-43", stepUpId: stepUp.body.data.stepUpId });
      assert.equal(reuse.body.code, "MAIL_STEP_UP_REQUIRED", "step-ups are single use");
      assert.equal((await call("super", "POST", `/break-glass/requests/${request.body.data.id}/approve`, { stepUpId: stepUp.body.data.stepUpId })).status, 403, "SUPER needs an explicit approver grant");
      assert.equal((await call("frank", "GET", `/mailboxes/${state.aliceBox}/threads`)).status, 404, "pending request grants nothing");
      harness.advance(31000);
      const graceStepUp = await call("grace", "POST", "/security/step-up", { code: totp(harness.clock), purpose: "BREAK_GLASS_APPROVAL" });
      const approved = await call("grace", "POST", `/break-glass/requests/${request.body.data.id}/approve`, { stepUpId: graceStepUp.body.data.stepUpId, durationMinutes: 30 });
      assert.equal(approved.status, 200, approved.text);
      const threads = await call("frank", "GET", `/mailboxes/${state.aliceBox}/threads?view=all`);
      assert.equal(threads.status, 200);
      await call("frank", "GET", `/threads/${state.aliceThreadId}/messages`);
      assert.equal(await client.mailAuditEvent.count({ where: { action: "MAIL_BREAK_GLASS_READ", actorAdminUserId: ids.frank } }), 1);
      assert.equal((await call("frank", "POST", `/threads/${state.aliceThreadId}/move`, { folder: "TRASH" })).status, 403, "break-glass is read only");
      assert.equal((await call("frank", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["x@y.example"] })).status, 403);
      await client.mailBreakGlassRequest.update({ where: { id: request.body.data.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await call("frank", "GET", `/mailboxes/${state.aliceBox}/threads`)).status, 404, "access expires");
    });

    await t.test("M3: legal holds, immutable audit trail and offboarding retain history", async () => {
      await call("alice", "POST", `/threads/${state.aliceThreadId}/move`, { folder: "TRASH" });
      const hold = await call("mailAdmin", "POST", "/admin/legal-holds", { organizationId: state.orgId, mailboxId: state.aliceBox, reason: "Litigation hold LEGAL-42" });
      assert.equal(hold.status, 201);
      const deleted = await call("alice", "DELETE", `/threads/${state.aliceThreadId}`);
      assert.equal(deleted.status, 409);
      assert.equal(deleted.body.code, "MAIL_LEGAL_HOLD");
      await assert.rejects(client.$executeRawUnsafe(`DELETE FROM mail_messages WHERE mailbox_id = '${state.aliceBox}'`), /legal hold/);
      await assert.rejects(client.$executeRawUnsafe("UPDATE mail_audit_events SET action = 'TAMPERED'"), /immutable/);
      await assert.rejects(client.$executeRawUnsafe("DELETE FROM mail_audit_events"), /immutable/);

      const offboard = await call("mailAdmin", "POST", `/admin/users/${ids.bob}/offboard`);
      assert.equal(offboard.status, 200, offboard.text);
      assert.equal(offboard.body.data.mailboxesSuspended, 1);
      assert.deepEqual((await call("bob", "GET", "/me/mailboxes")).body.data, []);
      assert.ok((await client.mailMessage.count({ where: { mailboxId: state.bobBox } })) >= 1, "history retained");
      await assert.rejects(client.adminUser.delete({ where: { id: ids.bob } }), "mail history blocks cascade deletion of the employee");
      const inboundToBob = await client.mailAddress.findUnique({ where: { address: "bob@cosmicforge.example" } });
      assert.equal(inboundToBob.status, "SUSPENDED");
    });

    await t.test("M6: brand-scoped consent, suppression, CSV safety and segments", async () => {
      await client.adminSectionGrant.createMany({ data: [
        { adminUserId: ids.dave, module: "mail-marketing", section: "cosmicforge", mode: "EDIT", grantedBy: ids.super },
        { adminUserId: ids.erin, module: "mail-marketing", section: "approve:cosmicforge", mode: "EDIT", grantedBy: ids.super },
        { adminUserId: ids.erin, module: "mail-marketing", section: "karryam", mode: "EDIT", grantedBy: ids.super },
      ] });
      const orgs = await call("dave", "GET", "/marketing/organizations");
      assert.deepEqual(orgs.body.data.map((org) => org.slug), ["cosmicforge"]);
      assert.equal((await call("dave", "GET", `/marketing/${state.org2Id}/contacts`)).status, 404, "cross-brand access denied");
      assert.equal((await call("super", "GET", `/marketing/${state.orgId}/contacts`)).status, 404, "marketing scopes need explicit grants");
      const base = `/marketing/${state.orgId}`;
      const consent = (topic = "newsletter", extra = {}) => ({ topic, source: "WEB_FORM", policyVersion: "2026-10", evidence: { reference: "form-submission-881", formUrl: "https://cosmicforge.example/subscribe" }, ...extra });
      const granted = await call("dave", "POST", `${base}/contacts`, { email: "Fan@Reader.example", firstName: "Fan", consent: consent() });
      assert.equal(granted.status, 201, granted.text);
      assert.equal(granted.body.data.email, "fan@reader.example");
      const duplicate = await call("dave", "POST", `${base}/contacts`, { email: "fan@reader.example" });
      assert.equal(duplicate.status, 400);
      const noConsent = await call("dave", "POST", `${base}/contacts`, { email: "noconsent@reader.example" });
      const missingEvidence = await call("dave", "POST", `${base}/contacts`, { email: "x@reader.example", consent: { topic: "newsletter", source: "WEB_FORM", policyVersion: "1" } });
      assert.equal(missingEvidence.body.code, "MAIL_CONSENT_REQUIRED");
      const formula = await call("dave", "POST", `${base}/contacts`, { email: "f@reader.example", firstName: "=HYPERLINK(1)" });
      assert.equal(formula.status, 400);
      const doubleOpt = await call("dave", "POST", `${base}/contacts`, { email: "pending@reader.example", consent: consent("newsletter", { doubleOptIn: true }) });
      assert.ok(doubleOpt.body.data.confirmationToken);
      const withdrawn = await call("dave", "POST", `${base}/contacts`, { email: "gone@reader.example", consent: consent() });
      await call("dave", "POST", `${base}/contacts/${withdrawn.body.data.id}/consents/newsletter/withdraw`, { source: "unsubscribe-link" });
      const suppressed = await call("dave", "POST", `${base}/contacts`, { email: "hidden@partner.example", consent: consent() });
      const other = await call("erin", "POST", `/marketing/${state.org2Id}/contacts`, { email: "karry@reader.example", consent: consent() });
      assert.equal(other.status, 201);

      const audience = await call("dave", "POST", `${base}/audiences`, { name: "Newsletter", topic: "newsletter" });
      const members = await call("dave", "POST", `${base}/audiences/${audience.body.data.id}/contacts`, { contactIds: [granted.body.data.id, noConsent.body.data.id, doubleOpt.body.data.id, withdrawn.body.data.id, suppressed.body.data.id, other.body.data.id] });
      assert.equal(members.body.data.added, 5);
      assert.equal(members.body.data.rejected, 1, "contacts from another brand are rejected");
      const detail = await call("dave", "GET", `${base}/audiences/${audience.body.data.id}`);
      assert.equal(detail.body.data.eligibleCount, 1);
      assert.deepEqual(detail.body.data.excluded, { notInSegment: 0, inactive: 0, noConsent: 1, unconfirmed: 1, withdrawn: 1, suppressed: 1 });

      const csvRejected = new FormData();
      csvRejected.append("file", new Blob(["email\nbuyer@list.example\n"], { type: "text/csv" }), "list.csv");
      csvRejected.append("topic", "newsletter");
      csvRejected.append("source", "IMPORT");
      csvRejected.append("policyVersion", "2026-10");
      csvRejected.append("evidenceReference", "purchased-list");
      assert.equal((await call("dave", "POST", `${base}/contacts/import`, csvRejected)).body.code, "MAIL_CONSENT_REQUIRED", "imports require an opt-in attestation");
      const csv = new FormData();
      csv.append("file", new Blob(['email,first_name,consented_at\nnew1@reader.example,Nia,2026-09-01T10:00:00Z\nnew1@reader.example,Dup,\nbad-email,X,\nevil@reader.example,"=cmd|\' /C calc\'!A0",\ngone@reader.example,Gone,\n'], { type: "text/csv" }), "event.csv");
      csv.append("topic", "newsletter");
      csv.append("source", "EVENT");
      csv.append("policyVersion", "2026-10");
      csv.append("evidenceReference", "event-signup-sheet-2026-09");
      csv.append("attestOptIn", "true");
      csv.append("audienceId", audience.body.data.id);
      const report = await call("dave", "POST", `${base}/contacts/import`, csv);
      assert.equal(report.status, 200, report.text);
      assert.equal(report.body.data.created, 1);
      const reasons = Object.fromEntries(report.body.data.rows.map((row) => [row.row, row.reason]));
      assert.equal(reasons[3], "DUPLICATE_IN_FILE");
      assert.equal(reasons[4], "INVALID_EMAIL");
      assert.equal(reasons[5], "FORMULA_NOT_ALLOWED");
      assert.equal(reasons[6], "CONSENT_PREVIOUSLY_WITHDRAWN", "imports never re-grant withdrawn consent");

      const segment = await call("dave", "POST", `${base}/audiences/${audience.body.data.id}/segments`, { name: "Reader domain", definition: { match: "all", rules: [{ field: "email_domain", op: "equals", value: "reader.example" }] } });
      assert.equal(segment.status, 201, segment.text);
      const preview = await call("dave", "GET", `${base}/segments/${segment.body.data.id}/preview`);
      assert.equal(preview.body.data.eligibleCount, 2);
      const lift = await call("dave", "GET", `${base}/suppressions`);
      const bounced = lift.body.data.find((row) => row.email === "hidden@partner.example");
      assert.ok(bounced, "bounce suppression visible to the brand");
      const complaint = await call("dave", "POST", `${base}/suppressions`, { email: "complainer@reader.example", reason: "LEGAL" });
      assert.equal((await call("dave", "POST", `${base}/suppressions/${complaint.body.data.id}/lift`)).status, 409, "legal suppressions are not liftable");
      state.audienceId = audience.body.data.id;
      state.segmentId = segment.body.data.id;
    });

    await t.test("M6: templates, campaign preflight, reviewer separation, step-up approval, invalidation and no dispatch", async () => {
      const base = `/marketing/${state.orgId}`;
      const blocks = [{ type: "heading", text: "Hello {{first_name}}" }, { type: "text", text: "Our **autumn** update." }, { type: "button", label: "Read more", url: "https://cosmicforge.example/news" }];
      const render = await call("dave", "POST", `${base}/templates/render`, { subject: "Autumn news", blocks });
      assert.equal(render.status, 200, render.text);
      assert.match(render.body.data.html, /Hello Ada/);
      const badVar = await call("dave", "POST", `${base}/templates/render`, { subject: "x", blocks: [{ type: "text", text: "{{ssn}}" }] });
      assert.equal(badVar.body.code, "MAIL_TEMPLATE_INVALID_VARIABLE");
      const template = await call("dave", "POST", `${base}/templates`, { name: "Autumn newsletter" });
      const version = await call("dave", "POST", `${base}/templates/${template.body.data.id}/versions`, { subject: "Autumn news", blocks });
      assert.equal(version.status, 201, version.text);
      await assert.rejects(client.$executeRawUnsafe(`UPDATE marketing_email_template_versions SET html = 'x' WHERE id = '${version.body.data.id}'`), /immutable/);
      const legacy = await call("dave", "GET", `${base}/legacy-templates`);
      assert.equal(legacy.status, 200);
      const identities = await call("dave", "GET", `${base}/sender-identities`);
      assert.ok(identities.body.data.some((identity) => identity.address === "news@cosmicforge.example" && identity.domainVerifiedForSending));
      assert.ok(!identities.body.data.some((identity) => identity.address === "alice@cosmicforge.example"), "personal identities are never brand senders");

      const campaign = await call("dave", "POST", `${base}/campaigns`, { name: "Autumn", topic: "newsletter", templateVersionId: version.body.data.id, audienceId: state.audienceId, senderAddressId: state.addr.alice.id });
      assert.equal(campaign.status, 201, campaign.text);
      let preflight = await call("dave", "POST", `${base}/campaigns/${campaign.body.data.id}/preflight`);
      assert.equal(preflight.body.data.ok, false);
      assert.equal(preflight.body.data.checks.find((check) => check.id === "sender_identity").ok, false);
      assert.equal((await call("dave", "POST", `${base}/campaigns/${campaign.body.data.id}/submit`, { revision: 1 })).body.code, "MAIL_PREFLIGHT_FAILED");
      const fixed = await call("dave", "PATCH", `${base}/campaigns/${campaign.body.data.id}`, { revision: 1, senderAddressId: state.addr.news.id, replyTo: "support@cosmicforge.example" });
      assert.equal(fixed.body.data.revision, 2);
      preflight = await call("dave", "POST", `${base}/campaigns/${campaign.body.data.id}/preflight`);
      assert.equal(preflight.body.data.ok, true, JSON.stringify(preflight.body.data.checks));
      assert.equal(preflight.body.data.eligibleCount, 2);
      const submitted = await call("dave", "POST", `${base}/campaigns/${campaign.body.data.id}/submit`, { revision: 2 });
      assert.equal(submitted.body.data.status, "READY_FOR_REVIEW");
      assert.equal((await call("dave", "POST", `${base}/campaigns/${campaign.body.data.id}/approve`, { revision: 2 })).status, 403, "authors cannot approve");
      const noStep = await call("erin", "POST", `${base}/campaigns/${campaign.body.data.id}/approve`, { revision: 2 });
      assert.equal(noStep.body.code, "MAIL_STEP_UP_REQUIRED");
      harness.advance(31000);
      const erinStep = await call("erin", "POST", "/security/step-up", { code: totp(harness.clock), purpose: "MARKETING_CAMPAIGN_APPROVAL" });
      const approved = await call("erin", "POST", `${base}/campaigns/${campaign.body.data.id}/approve`, { revision: 2, stepUpId: erinStep.body.data.stepUpId, comment: "Looks good" });
      assert.equal(approved.status, 200, approved.text);
      assert.equal(approved.body.data.status, "APPROVED");
      assert.equal(approved.body.data.dispatchEnabled, false);
      const history = await call("erin", "GET", `${base}/campaigns/${campaign.body.data.id}/history`);
      const kinds = history.body.data.snapshots.map((snapshot) => snapshot.kind);
      assert.deepEqual(kinds, ["SUBMISSION", "APPROVAL"]);
      assert.equal(history.body.data.snapshots[0].contentSha256, history.body.data.snapshots[1].contentSha256);
      await assert.rejects(client.$executeRawUnsafe("UPDATE marketing_email_campaign_snapshots SET subject = 'changed'"), /immutable/);

      const edited = await call("dave", "PATCH", `${base}/campaigns/${campaign.body.data.id}`, { revision: 2, subjectOverride: "Changed after approval" });
      assert.equal(edited.body.data.status, "DRAFT", "material edits invalidate approval");
      assert.equal(edited.body.data.revision, 3);
      const after = await call("erin", "GET", `${base}/campaigns/${campaign.body.data.id}/history`);
      assert.ok(after.body.data.approvals.some((approval) => approval.decision === "INVALIDATED"));
      assert.equal(await client.mailOutboxJob.count({ where: { kind: { notIn: ["SEND_MESSAGE", "PROCESS_INBOUND", "PROCESS_DELIVERY_EVENT"] } } }), 0, "no marketing dispatch jobs exist in M6");
      await assert.rejects(harness.adapter.sendBroadcast({}), (error) => error.code === "BROADCAST_NOT_ENABLED");
    });

    await t.test("Flags: Mail disabled returns honest 503s", async () => {
      const disabled = createMailApplication({ client, config: loadMailConfig({}), adapter: createFakeAdapter(), storageBackend: memoryBackend(), logger: { info() {}, warn() {}, error() {} } });
      const app = express();
      app.use(express.json());
      app.use("/api/mail/v1", createMailRouter({ mail: disabled, authenticate: (req, res, next) => { req.adminUser = { id: ids.alice, status: "ACTIVE", tier: "EMPLOYEE" }; next(); } }));
      app.use(errorHandler);
      const local = await listen(app);
      try {
        const response = await fetch(`${local.base}/me/mailboxes`);
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, "MAIL_DISABLED");
      } finally {
        await closeServer(local.server);
      }
    });
  } finally {
    await closeServer(server);
    await client.$disconnect();
    await dropDatabase(BASE_DATABASE_URL, replay.databaseName);
  }
});
