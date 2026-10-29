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
const { memoryBackend, filesystemBackend } = require("../src/modules/mail/storage/mail-storage");
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const nodeOs = require("node:os");
const { signatureScanner, EICAR } = require("../src/modules/mail/scanning/attachment-scanner");
const { signResendWebhook } = require("../src/modules/mail/webhooks/resend-webhook.verifier");
const { totpAt, decodeBase32, encryptSecret } = require("../src/shared/auth/mfa-core");
const { errorHandler } = require("../src/shared/middlewares/error.middleware");
const { closeServer } = require("./helpers/server-close");

const BASE_DATABASE_URL = process.env.DATABASE_URL;
const WEBHOOK_SECRET = `whsec_${crypto.randomBytes(24).toString("base64")}`;
const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
// Shared HQ MFA keyring for this test process (verified enrollments are stored encrypted).
process.env.AUTH_MFA_ENCRYPTION_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
// Per-user live HQ session ids (admin_sessions), used by the test authenticator.
const SESSIONS = new Map();

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
  hrManager: { tier: "ADMIN", name: "Hana HR" },
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
        // Legacy plaintext columns are set on purpose: Mail must ignore them.
        twoFactorEnabled: Boolean(spec.twoFactor), twoFactorSecret: spec.twoFactor ? TOTP_SECRET : null,
      },
    });
    if (spec.twoFactor) {
      await client.adminMfaEnrollment.create({ data: { adminUserId: ids[key], enrolledAt: new Date(Date.now() - 86400000), secretEncrypted: encryptSecret(decodeBase32(TOTP_SECRET), ids[key]), updatedAt: new Date() } });
    }
    const session = await client.adminSession.create({ data: { id: crypto.randomUUID(), adminUserId: ids[key], mode: "dual", authMethod: "PASSWORD", csrfNonce: crypto.randomBytes(16).toString("hex"), idleExpiresAt: new Date(Date.now() + 3650 * 86400000), absoluteExpiresAt: new Date(Date.now() + 3650 * 86400000) } });
    SESSIONS.set(ids[key], session.id);
  }
  const grant = (adminUserId, module, section, mode = "EDIT") => client.adminSectionGrant.create({ data: { adminUserId, module, section, mode, grantedBy: ids.super } });
  await grant(ids.mailAdmin, "mail", "admin");
  await grant(ids.frank, "mail", "break-glass-request");
  await grant(ids.grace, "mail", "break-glass-approve");
  await grant(ids.hrManager, "hrm", "accounts");
  return ids;
}

let harnessKeys = "";
const baseEnvKeys = () => harnessKeys;

function fileKeyringEnv(rawKey) {
  const directory = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "cfmail-keyring-"));
  const file = nodePath.join(directory, "keyring.json");
  nodeFs.writeFileSync(file, JSON.stringify({ format: "cosmicforge-mail-keyring/1", environment: "development", active: "v1", keys: { v1: rawKey } }), { mode: 0o400 });
  return { MAIL_KMS_PROVIDER: "file", MAIL_ENCRYPTION_KEYRING_FILE: file };
}

// MAIL_TEST_STORAGE=filesystem: the production self-hosted backend (encrypted
// filesystem with an environment marker, free-space floor and fsync).
// `objects` exposes every stored file's raw bytes for ciphertext-only checks.
function testFilesystemBackend() {
  const directory = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "cfmail-store-"));
  const backend = filesystemBackend(directory, { environment: "test", minFreeBytes: 1024 * 1024 });
  const walk = (dir, out) => {
    for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (!entry.name.startsWith(".")) out.set(nodePath.relative(directory, full), nodeFs.readFileSync(full));
    }
    return out;
  };
  return Object.assign(backend, { directory, get objects() { return walk(directory, new Map()); } });
}

function createHarness(client, { storageBackend } = {}) {
  let offsetMs = 0;
  const clock = () => new Date(Date.now() + offsetMs);
  const adapter = createFakeAdapter();
  const rawKey = crypto.randomBytes(32).toString("base64");
  // MAIL_TEST_KEYRING=file: the self-hosted keyring file (MAIL_KMS_PROVIDER=file)
  // instead of environment keys; same key, so key-dependent checks still apply.
  const keyEnv = process.env.MAIL_TEST_KEYRING === "file" ? fileKeyringEnv(rawKey) : { MAIL_ENCRYPTION_KEYS: `v1:${rawKey}` };
  const baseEnv = {
    MAIL_ENABLED: "true", MAIL_SENDING_ENABLED: "true", MAIL_RECEIVING_ENABLED: "true", MAIL_MARKETING_ENABLED: "true", MAIL_WORKER_ENABLED: "true",
    MAIL_PROVIDER: "fake", RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET, ...keyEnv,
    MAIL_WORKER_MAX_ATTEMPTS: "4", MAIL_UNKNOWN_RECIPIENT_POLICY: "reject",
    MAIL_DOMAIN_ALLOWLIST: "cosmicforge.example,karryam.example",
    // Legacy flag: must be refused, never re-enabling plaintext body indexing.
    MAIL_SEARCH_INDEX_BODIES: "true",
  };
  const config = loadMailConfig(baseEnv);
  harnessKeys = `v1:${rawKey}`;
  // MAIL_TEST_STORAGE=s3 runs the whole suite against the S3 backend (fake S3
  // on 127.0.0.1) instead of memory; `backend.objects` exposes raw stored bytes.
  const backend = storageBackend || memoryBackend();
  const mail = createMailApplication({ client, config, adapter, storageBackend: backend, scanner: signatureScanner(), logger: { info() {}, warn() {}, error() {} }, clock });
  // Another app instance over the same DB/storage/keys with different config
  // (e.g. a worker deployed with a changed allowlist).
  const variant = (overrides, extra = {}) => createMailApplication({ client, config: loadMailConfig({ ...baseEnv, ...overrides }), adapter: extra.adapter || adapter, storageBackend: backend, encryption: mail.encryption, scanner: extra.scanner || signatureScanner(), logger: { info() {}, warn() {}, error() {} }, clock });
  const authenticate = async (req, res, next) => {
    try {
      const id = req.get("x-test-user");
      if (!id) return res.status(401).json({ success: false, message: "No token provided" });
      const user = await client.adminUser.findUnique({ where: { id }, select: { id: true, email: true, name: true, tier: true, status: true, twoFactorEnabled: true } });
      if (!user) return res.status(401).json({ success: false });
      if (user.status === "INACTIVE" || user.status === "LOCKED") return res.status(403).json({ success: false });
      req.adminUser = user;
      // x-test-session overrides (e.g. "none" = legacy session-less token).
      const override = req.get("x-test-session");
      req.authSession = { id: override === "none" ? null : override || SESSIONS.get(user.id) || null, mfaVerifiedAt: null, mfaEnrolled: false };
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
  return { mail, app, adapter, worker, clock, backend, variant, authenticate, advance: (ms) => { offsetMs += ms; } };
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
  let fakeS3 = null;
  let storageBackend;
  if (process.env.MAIL_TEST_STORAGE === "s3") {
    const { startFakeS3 } = require("./helpers/mail-infra-fakes");
    const { s3Backend } = require("../src/modules/mail/storage/s3-backend");
    fakeS3 = await startFakeS3();
    storageBackend = Object.assign(s3Backend(fakeS3.config()), { objects: fakeS3.objects });
  } else if (process.env.MAIL_TEST_STORAGE === "filesystem") {
    storageBackend = testFilesystemBackend();
  }
  const harness = createHarness(client, { storageBackend });
  // Prove the selected mode is really in use (no silent fallback to memory/env keys).
  const modeHealth = await harness.mail.health();
  assert.equal(modeHealth.encryption.provider, process.env.MAIL_TEST_KEYRING === "file" ? "file" : "env");
  assert.equal(modeHealth.encryption.available, true);
  assert.equal(harness.mail.storage.name, { s3: "s3", filesystem: "encrypted-filesystem" }[process.env.MAIL_TEST_STORAGE] || "memory");
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
      // Admin-driven shared-mailbox grants need an MFA step-up (MAIL_MEMBERSHIP_GRANT).
      await client.adminMfaEnrollment.upsert({ where: { adminUserId: ids.mailAdmin }, create: { adminUserId: ids.mailAdmin, enrolledAt: new Date(harness.clock().getTime() - 86400000), secretEncrypted: encryptSecret(decodeBase32(TOTP_SECRET), ids.mailAdmin), updatedAt: new Date() }, update: {} });
      const grantStepUp = async () => {
        harness.advance(31000);
        const response = await call("mailAdmin", "POST", "/security/step-up", { code: totp(harness.clock), purpose: "MAIL_MEMBERSHIP_GRANT" });
        assert.equal(response.status, 201, response.text);
        return response.body.data.stepUpId;
      };
      assert.equal((await call("mailAdmin", "POST", `/mailboxes/${state.supportBox}/members`, { adminUserId: ids.carol, role: "MEMBER", canSend: true })).body.code, "MAIL_STEP_UP_REQUIRED");
      const addCarol = await call("mailAdmin", "POST", `/mailboxes/${state.supportBox}/members`, { adminUserId: ids.carol, role: "MEMBER", canSend: true, stepUpId: await grantStepUp() });
      assert.equal(addCarol.status, 201, addCarol.text);
      state.danMembership = (await call("mailAdmin", "POST", `/mailboxes/${state.supportBox}/members`, { adminUserId: ids.dan, role: "MEMBER", canSend: true, stepUpId: await grantStepUp() })).body.data.id;
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
      // A 5xx may come back after the provider accepted the email, so an
      // exhausted 5xx outage is an unknown outcome, not a clean failure.
      assert.equal((await call("alice", "GET", `/messages/${sent4.body.data.messageId}/status`)).body.data.status, "OUTCOME_UNKNOWN");
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
      // Every break-glass content exposure is audited, the thread list included.
      assert.equal(await client.mailAuditEvent.count({ where: { action: "MAIL_BREAK_GLASS_THREAD_LIST", actorAdminUserId: ids.frank } }), 1);
      assert.equal((await call("frank", "POST", `/threads/${state.aliceThreadId}/move`, { folder: "TRASH" })).status, 403, "break-glass is read only");
      assert.equal((await call("frank", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["x@y.example"] })).status, 403);
      await client.mailBreakGlassRequest.update({ where: { id: request.body.data.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await call("frank", "GET", `/mailboxes/${state.aliceBox}/threads`)).status, 404, "access expires");
    });

    await t.test("Stage A3: Mail step-up runs on the shared HQ MFA (session-bound, fail-closed)", async () => {
      const newSession = async (adminUserId) => (await client.adminSession.create({ data: { id: crypto.randomUUID(), adminUserId, mode: "dual", authMethod: "PASSWORD", csrfNonce: "n", idleExpiresAt: new Date(harness.clock().getTime() + 3650 * 86400000), absoluteExpiresAt: new Date(harness.clock().getTime() + 3650 * 86400000) } })).id;
      const makeUser = async (key, { enrolled = false, legacyPlaintext = false } = {}) => {
        const id = crypto.randomUUID();
        await client.adminUser.create({ data: { id, email: `${key}@staff.example.invalid`, password: "test-only-hash", name: key, tier: "ADMIN", status: "ACTIVE", mustChangePassword: false, twoFactorEnabled: legacyPlaintext, twoFactorSecret: legacyPlaintext ? TOTP_SECRET : null } });
        if (enrolled) await client.adminMfaEnrollment.create({ data: { adminUserId: id, enrolledAt: new Date(Date.now() - 86400000), secretEncrypted: encryptSecret(decodeBase32(TOTP_SECRET), id), updatedAt: new Date() } });
        await client.adminSectionGrant.create({ data: { adminUserId: id, module: "mail", section: "break-glass-request", mode: "EDIT", grantedBy: ids.super } });
        ids[key] = id;
        SESSIONS.set(id, await newSession(id));
        return id;
      };
      const request = (key, stepUpId, headers = {}) => call(key, "POST", "/break-glass/requests", { mailboxId: state.aliceBox, justification: "Stage A3 shared MFA verification of break-glass", caseReference: `A3-${crypto.randomUUID().slice(0, 8)}`, stepUpId }, headers);
      const step = (key, headers = {}, code = totp(harness.clock), purpose = "BREAK_GLASS_REQUEST") => call(key, "POST", "/security/step-up", { code, purpose }, headers);

      // Legacy plaintext twoFactorSecret alone is never MFA evidence.
      await makeUser("legacy2fa", { legacyPlaintext: true });
      assert.equal((await step("legacy2fa")).body.code, "MAIL_MFA_NOT_ENROLLED");

      // Session-less (legacy) tokens cannot step up.
      await makeUser("investigator", { enrolled: true });
      harness.advance(31000);
      const legacy = await step("investigator", { "x-test-session": "none" });
      assert.equal(legacy.body.code, "MAIL_MFA_SESSION_REQUIRED", legacy.text);

      // Bound to the session it was verified on.
      const ok = await step("investigator");
      assert.equal(ok.status, 201, ok.text);
      const otherSession = await newSession(ids.investigator);
      assert.equal((await request("investigator", ok.body.data.stepUpId, { "x-test-session": otherSession })).body.code, "MAIL_STEP_UP_REQUIRED", "another session cannot use it");
      // Purpose-bound.
      assert.equal((await call("investigator", "POST", "/break-glass/requests/00000000-0000-4000-8000-000000000000/approve", { stepUpId: ok.body.data.stepUpId })).status >= 403, true);
      // Session revocation (logout / password change / deactivation) voids it.
      await client.adminSession.update({ where: { id: SESSIONS.get(ids.investigator) }, data: { revokedAt: new Date(), revokeReason: "LOGOUT" } });
      assert.equal((await request("investigator", ok.body.data.stepUpId)).body.code, "MAIL_STEP_UP_REQUIRED", "revoked session");
      SESSIONS.set(ids.investigator, await newSession(ids.investigator));

      // MFA reset between verification and use voids it.
      harness.advance(31000);
      const beforeReset = await step("investigator");
      assert.equal(beforeReset.status, 201, beforeReset.text);
      const enrollment = await client.adminMfaEnrollment.findUnique({ where: { adminUserId: ids.investigator } });
      await client.adminMfaEnrollment.delete({ where: { adminUserId: ids.investigator } });
      assert.equal((await request("investigator", beforeReset.body.data.stepUpId)).body.code, "MAIL_STEP_UP_REQUIRED", "MFA reset");
      await client.adminMfaEnrollment.create({ data: { ...enrollment, enrolledAt: new Date(harness.clock().getTime() + 1000) } });
      assert.equal((await request("investigator", beforeReset.body.data.stepUpId)).body.code, "MAIL_STEP_UP_REQUIRED", "re-enrollment does not revive an older step-up");

      // Expiry.
      harness.advance(31000);
      const expiring = await step("investigator");
      assert.equal(expiring.status, 201, expiring.text);
      harness.advance(301000);
      assert.equal((await request("investigator", expiring.body.data.stepUpId)).body.code, "MAIL_STEP_UP_REQUIRED", "expired");

      // Positive path still works end to end and is audited in both systems.
      harness.advance(31000);
      const good = await step("investigator");
      const created = await request("investigator", good.body.data.stepUpId);
      assert.equal(created.status, 201, created.text);
      const stepUpRow = await client.mailStepUpVerification.findUnique({ where: { id: good.body.data.stepUpId } });
      assert.equal(stepUpRow.sessionId, SESSIONS.get(ids.investigator));
      assert.ok(stepUpRow.consumedAt);
      // The step-up did not grant general session MFA freshness.
      assert.equal((await client.adminSession.findUnique({ where: { id: SESSIONS.get(ids.investigator) } })).mfaVerifiedAt, null);

      // Recovery codes are refused; repeated failures lock via the shared limiter.
      await makeUser("locker", { enrolled: true });
      assert.equal((await step("locker", {}, "ABCDE-FGHJK")).body.code, "MAIL_MFA_INVALID");
      for (let attempt = 0; attempt < 4; attempt += 1) await step("locker", {}, "000000");
      const locked = await step("locker");
      assert.equal(locked.status, 429, locked.text);
      assert.equal(locked.body.code, "MAIL_MFA_LOCKED");
      assert.ok(await client.adminAuthEvent.count({ where: { adminUserId: ids.locker, action: "MFA_LOCKED" } }) >= 1, "shared auth audit records the lockout");
      assert.ok(await client.mailAuditEvent.count({ where: { actorAdminUserId: ids.locker, action: "MAIL_STEP_UP_FAILED" } }) >= 1);
    });

    await t.test("Remediation: mixed internal/external recipients reach the provider exactly once, external only", async () => {
      const sentFor = async (messageId) => {
        const { rfcMessageId } = await client.mailMessage.findUnique({ where: { id: messageId } });
        return harness.adapter.state.sent.filter((request) => request.headers["Message-ID"] === rfcMessageId);
      };
      const addresses = (list) => list.map((party) => party.address).sort();
      const send = async (userKey, mailboxId, draft) => {
        const created = await call(userKey, "POST", `/mailboxes/${mailboxId}/drafts`, { subject: "Mixed", text: "hello", ...draft });
        assert.equal(created.status, 201, created.text);
        const sent = await call(userKey, "POST", `/drafts/${created.body.data.id}/send`, { revision: 1 });
        assert.equal(sent.status, 202, sent.text);
        return sent.body.data;
      };
      const bobCopies = async (messageId) => {
        const { rfcMessageId } = await client.mailMessage.findUnique({ where: { id: messageId } });
        return client.mailMessage.findMany({ where: { mailboxId: state.bobBox, rfcMessageId }, include: { recipients: true } });
      };

      const toTo = await send("alice", state.aliceBox, { to: ["bob@cosmicforge.example", "mx1@partner.example"] });
      const ccTo = await send("alice", state.aliceBox, { to: ["mx2@partner.example"], cc: ["bob@cosmicforge.example"] });
      const bccTo = await send("alice", state.aliceBox, { to: ["mx3@partner.example"], bcc: ["bob@cosmicforge.example"] });
      const extBcc = await send("alice", state.aliceBox, { bcc: ["hb1@partner.example", "hb2@partner.example"] });
      const multi = await send("bob", state.bobBox, { to: ["alice@cosmicforge.example", "a.okafor@cosmicforge.example", "mx4@partner.example"] });
      const internalOnly = await send("alice", state.aliceBox, { to: ["bob@cosmicforge.example"], cc: ["a.okafor@cosmicforge.example"] });
      const extOnly = await send("alice", state.aliceBox, { to: ["mx5@partner.example"], cc: ["mx6@partner.example"] });
      const promoted = await send("alice", state.aliceBox, { to: ["bob@cosmicforge.example"], cc: ["mx7@partner.example"] });
      assert.equal(internalOnly.status, "DELIVERED");
      assert.equal(internalOnly.jobId, null, "internal-only mail never creates a provider job");
      await drain();

      const one = async (data) => {
        const requests = await sentFor(data.messageId);
        assert.equal(requests.length, 1, "exactly one provider request");
        return requests[0];
      };
      let request = await one(toTo);
      assert.deepEqual([addresses(request.to), addresses(request.cc), addresses(request.bcc)], [["mx1@partner.example"], [], []]);
      assert.equal((await bobCopies(toTo.messageId)).length, 1);
      request = await one(ccTo);
      assert.deepEqual([addresses(request.to), addresses(request.cc), addresses(request.bcc)], [["mx2@partner.example"], [], []]);
      request = await one(bccTo);
      assert.deepEqual([addresses(request.to), addresses(request.cc), addresses(request.bcc)], [["mx3@partner.example"], [], []]);
      const [bccCopy] = await bobCopies(bccTo.messageId);
      assert.ok(bccCopy, "internal BCC recipient received a local copy");
      assert.ok(!bccCopy.recipients.some((recipient) => recipient.type === "BCC"), "BCC never copied into recipient mailboxes");
      const individual = await sentFor(extBcc.messageId);
      assert.equal(individual.length, 2, "external BCC-only mail is sent individually");
      for (const entry of individual) {
        assert.equal(entry.to.length, 1);
        assert.deepEqual([entry.cc, entry.bcc], [[], []], "BCC recipients never see each other");
      }
      assert.deepEqual(individual.map((entry) => entry.to[0].address).sort(), ["hb1@partner.example", "hb2@partner.example"]);
      assert.notEqual(individual[0].idempotencyKey, individual[1].idempotencyKey);
      request = await one(multi);
      assert.deepEqual(addresses(request.to), ["mx4@partner.example"]);
      const { rfcMessageId: multiId } = await client.mailMessage.findUnique({ where: { id: multi.messageId } });
      assert.equal(await client.mailMessage.count({ where: { mailboxId: state.aliceBox, rfcMessageId: multiId } }), 1, "two addresses of one mailbox -> one copy");
      assert.equal((await sentFor(internalOnly.messageId)).length, 0);
      request = await one(extOnly);
      assert.deepEqual([addresses(request.to), addresses(request.cc)], [["mx5@partner.example"], ["mx6@partner.example"]]);
      request = await one(promoted);
      assert.deepEqual([addresses(request.to), addresses(request.cc)], [["mx7@partner.example"], []], "Resend requires `to`: external CC promoted, internal To excluded");
      const toToStatus = await call("alice", "GET", `/messages/${toTo.messageId}/status`);
      assert.equal(toToStatus.body.data.recipients.find((recipient) => recipient.address === "bob@cosmicforge.example").status, "INTERNAL_DELIVERED");
      assert.equal(toToStatus.body.data.status, "PROVIDER_ACCEPTED");

      // Provider echo / replay of the locally delivered message is deduplicated.
      const { rfcMessageId } = await client.mailMessage.findUnique({ where: { id: toTo.messageId } });
      harness.adapter.addInbound("echo_mixed", { from: { address: "alice@cosmicforge.example", name: "Alice" }, to: [{ address: "bob@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [], subject: "Mixed", html: null, text: "dup", rfcMessageId, inReplyTo: null, references: [], receivedAt: harness.clock() });
      const echo = await webhook("email.received", { email_id: "echo_mixed", to: ["bob@cosmicforge.example"] });
      await webhook("email.received", { email_id: "echo_mixed", to: ["bob@cosmicforge.example"] }, { id: echo.id });
      await drain();
      assert.equal((await bobCopies(toTo.messageId)).length, 1, "no duplicate delivery after echo + replay");

      // Delivery events for an individual BCC send resolve only that recipient.
      const status = await call("alice", "GET", `/messages/${extBcc.messageId}/status`);
      assert.equal(status.body.data.status, "PROVIDER_ACCEPTED");
      await webhook("email.delivered", { email_id: individual.find((entry) => entry.to[0].address === "hb2@partner.example").providerMessageId, to: ["hb2@partner.example"] });
      await drain();
      const after = (await call("alice", "GET", `/messages/${extBcc.messageId}/status`)).body.data;
      assert.equal(after.recipients.find((recipient) => recipient.address === "hb2@partner.example").status, "DELIVERED");
      assert.equal(after.recipients.find((recipient) => recipient.address === "hb1@partner.example").status, "PROVIDER_ACCEPTED");
    });

    await t.test("Remediation: queued sends are re-authorized at dispatch (offboarding, identity revocation, domain kill-switch)", async () => {
      const makeUser = async (key, name) => {
        const id = crypto.randomUUID();
        await client.adminUser.create({ data: { id, email: `${key}@staff.example.invalid`, password: "test-only-hash", name, tier: "EMPLOYEE", status: "ACTIVE", mustChangePassword: false } });
        ids[key] = id;
        const box = await call("mailAdmin", "POST", "/admin/mailboxes", { organizationId: state.orgId, type: "PERSONAL", ownerAdminUserId: id, address: { domainId: state.domainId, localPart: key } });
        assert.equal(box.status, 201, box.text);
        return box.body.data.id;
      };
      const queue = async (userKey, mailboxId, to = ["ext-dispatch@partner.example"]) => {
        const draft = await call(userKey, "POST", `/mailboxes/${mailboxId}/drafts`, { to, subject: "Queued", text: "x" });
        const sent = await call(userKey, "POST", `/drafts/${draft.body.data.id}/send`, { revision: 1 });
        assert.equal(sent.status, 202, sent.text);
        return sent.body.data;
      };
      const providerCalls = (messageRfc) => harness.adapter.state.sent.filter((request) => request.headers["Message-ID"] === messageRfc).length;
      const rfc = async (messageId) => (await client.mailMessage.findUnique({ where: { id: messageId } })).rfcMessageId;

      const zoeBox = await makeUser("zoe", "Zoe Leaver");
      const zoeQueued = await queue("zoe", zoeBox);
      assert.equal((await call("mailAdmin", "POST", `/admin/users/${ids.zoe}/offboard`)).status, 200);
      await drain();
      let message = await client.mailMessage.findUnique({ where: { id: zoeQueued.messageId }, include: { recipients: true } });
      assert.equal(message.status, "FAILED");
      assert.equal(message.recipients[0].lastEventDetail, "SENDER_MEMBERSHIP_REVOKED");
      assert.equal(providerCalls(await rfc(zoeQueued.messageId)), 0, "offboarded sender's queued mail is never dispatched");
      assert.equal((await client.mailOutboxJob.findUnique({ where: { id: zoeQueued.jobId } })).status, "FAILED");

      const yanBox = await makeUser("yan", "Yan Domain");
      const yanQueued = await queue("yan", yanBox);
      await client.mailDomain.update({ where: { id: state.domainId }, data: { sendingStatus: "DISABLED" } });
      await drain();
      message = await client.mailMessage.findUnique({ where: { id: yanQueued.messageId }, include: { recipients: true } });
      assert.equal(message.recipients[0].lastEventDetail, "SENDER_DOMAIN_SENDING_DISABLED");
      assert.equal(providerCalls(await rfc(yanQueued.messageId)), 0, "domain kill-switch stops queued mail");
      await client.mailDomain.update({ where: { id: state.domainId }, data: { sendingStatus: "VERIFIED" } });

      const aliasDraft = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["ext-alias@partner.example"], subject: "Alias", text: "x" });
      const aliasId = (await call("alice", "GET", `/mailboxes/${state.aliceBox}`)).body.data.senderIdentities.find((identity) => identity.address === "a.okafor@cosmicforge.example").addressId;
      await call("alice", "PATCH", `/drafts/${aliasDraft.body.data.id}`, { revision: 1, senderAddressId: aliasId });
      const aliasSent = await call("alice", "POST", `/drafts/${aliasDraft.body.data.id}/send`, { revision: 2 });
      assert.equal((await call("mailAdmin", "PATCH", `/admin/addresses/${aliasId}`, { status: "SUSPENDED" })).status, 200);
      await drain();
      message = await client.mailMessage.findUnique({ where: { id: aliasSent.body.data.messageId }, include: { recipients: true } });
      assert.equal(message.recipients[0].lastEventDetail, "SENDER_IDENTITY_REVOKED");
      assert.equal(providerCalls(message.rfcMessageId), 0);
      await client.mailAddress.update({ where: { id: aliasId }, data: { status: "ACTIVE" } });
    });

    await t.test("Remediation: ambiguous sends past the provider idempotency window become OUTCOME_UNKNOWN, never a duplicate", async () => {
      const queue = async (to) => {
        const draft = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: [to], subject: "Window", text: "x" });
        return (await call("alice", "POST", `/drafts/${draft.body.data.id}/send`, { revision: 1 })).body.data;
      };
      const countFor = async (messageId) => {
        const { rfcMessageId } = await client.mailMessage.findUnique({ where: { id: messageId } });
        return harness.adapter.state.sent.filter((request) => request.headers["Message-ID"] === rfcMessageId).length;
      };

      // 1. Timeout after the provider accepted; the worker is unavailable for >24h.
      const late = await queue("late@partner.example");
      harness.adapter.failNext("sendMessage", "AMBIGUOUS", "PROVIDER_TIMEOUT", { acceptBeforeFailing: true });
      await harness.worker.drain({ maxTicks: 1 });
      assert.equal((await client.mailOutboxJob.findUnique({ where: { id: late.jobId } })).status, "RECONCILING");
      assert.equal(await countFor(late.messageId), 1);
      harness.advance(25 * 3600 * 1000);
      await harness.worker.drain();
      const lateStatus = (await call("alice", "GET", `/messages/${late.messageId}/status`)).body.data;
      assert.equal(lateStatus.status, "OUTCOME_UNKNOWN");
      assert.equal(lateStatus.recipients[0].status, "OUTCOME_UNKNOWN");
      assert.equal(await countFor(late.messageId), 1, "no resend once deduplication is no longer guaranteed");
      assert.ok(await client.mailAuditEvent.count({ where: { action: "MAIL_SEND_OUTCOME_UNKNOWN", targetId: late.messageId } }));

      // 2. Provider says the key was used with a different payload.
      const conflict = await queue("conflict@partner.example");
      harness.adapter.failNext("sendMessage", "IDEMPOTENCY_CONFLICT", "RESEND_IDEMPOTENCY_CONFLICT");
      await drain();
      assert.equal((await call("alice", "GET", `/messages/${conflict.messageId}/status`)).body.data.status, "OUTCOME_UNKNOWN");

      // 3. Worker crash mid-send on the final attempt.
      const crash = await queue("lastcrash@partner.example");
      const job = await client.mailOutboxJob.findUnique({ where: { id: crash.jobId } });
      const recipients = await client.mailMessageRecipient.findMany({ where: { messageId: crash.messageId } });
      await client.mailOutboxJob.update({ where: { id: job.id }, data: { status: "LEASED", leaseOwner: "dead-worker", leaseExpiresAt: new Date(harness.clock().getTime() - 1000), attemptCount: job.maxAttempts, payload: { plan: [{ to: recipients.map((recipient) => recipient.id), cc: [], bcc: [], firstAttemptAt: harness.clock().toISOString() }] } } });
      await harness.worker.drain({ maxTicks: 1 });
      assert.equal((await client.mailOutboxJob.findUnique({ where: { id: job.id } })).status, "DEAD_LETTER");
      assert.equal((await call("alice", "GET", `/messages/${crash.messageId}/status`)).body.data.status, "OUTCOME_UNKNOWN", "a crash during an attempted send is unknown, not failed or sent");
      assert.equal(await countFor(crash.messageId), 0);
    });

    await t.test("Confidentiality: message bodies, previews and notes are never stored in plaintext in the Mail database", async () => {
      const tag = crypto.randomBytes(8).toString("hex");
      const canaries = {
        outbound: `cfbodyout${tag}`,
        inbound: `cfbodyin${tag}`,
        attachment: `cfattach${tag}`,
        note: `cfnote${tag}`,
        draft: `cfdraft${tag}`,
      };
      assert.equal(harness.mail.config.search.bodies, false, "body indexing cannot be enabled");
      assert.equal(harness.mail.config.search.bodyIndexingRequestRefused, true, "legacy MAIL_SEARCH_INDEX_BODIES=true is refused and reported");

      const draft = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["bob@cosmicforge.example", "canary-ext@partner.example"], bcc: ["canary-bcc@partner.example"], subject: "Canary metadata subject", html: `<p>Confidential ${canaries.outbound} figures</p>` });
      const sent = await call("alice", "POST", `/drafts/${draft.body.data.id}/send`, { revision: 1 });
      assert.equal(sent.status, 202, sent.text);
      harness.adapter.addInbound("canary_in", { from: { address: "patient@client.example", name: "Patient" }, to: [{ address: "support@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [], subject: "Canary inbound subject", html: `<p>My record ${canaries.inbound}</p>`, text: `My record ${canaries.inbound}`, rfcMessageId: `<canary-${tag}@client.example>`, inReplyTo: null, references: [], receivedAt: harness.clock() }, [{ filename: "notes.txt", contentType: "text/plain", content: Buffer.from(`attachment ${canaries.attachment}`) }]);
      await webhook("email.received", { email_id: "canary_in", to: ["support@cosmicforge.example"] });
      await drain();
      const queue = await call("carol", "GET", `/mailboxes/${state.supportBox}/threads?view=all`);
      const supportThread = queue.body.data.find((thread) => thread.subject === "Canary inbound subject");
      assert.ok(supportThread);
      assert.equal((await call("carol", "POST", `/threads/${supportThread.id}/notes`, { body: `Callback ${canaries.note}` })).status, 201);
      const keptDraft = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["x@partner.example"], subject: "Draft subject", html: `<p>${canaries.draft}</p>` });
      assert.equal(keptDraft.status, 201);

      // Positive control: authorized readers still get decrypted content and previews.
      assert.match(supportThread.snippet, new RegExp(canaries.inbound), "preview is decrypted for authorized readers");
      const messages = await call("carol", "GET", `/threads/${supportThread.id}/messages`);
      assert.match(messages.body.data[0].html, new RegExp(canaries.inbound));
      const notes = await call("carol", "GET", `/threads/${supportThread.id}/notes`);
      assert.equal(notes.body.data.at(-1).body, `Callback ${canaries.note}`);
      assert.match((await call("alice", "GET", `/drafts/${keptDraft.body.data.id}`)).body.data.html, new RegExp(canaries.draft));

      // Scan every text-like and binary column of every Mail / Marketing Email table.
      const columns = await client.$queryRawUnsafe(`
        SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND (table_name LIKE 'mail\\_%' OR table_name LIKE 'marketing\\_email\\_%' OR table_name IN ('notifications', 'admin_audit_logs'))
          AND data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'ARRAY', 'bytea', 'USER-DEFINED')`);
      assert.ok(columns.length > 100, `scanned ${columns.length} columns`);
      const hits = [];
      for (const canary of Object.values(canaries)) {
        for (const column of columns) {
          const ident = `"${column.table_name}"."${column.column_name}"`;
          const predicate = column.data_type === "bytea" ? `position(convert_to($1, 'UTF8') in ${ident}) > 0` : `${ident}::text ILIKE '%' || $1 || '%'`;
          const [row] = await client.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${column.table_name}" WHERE ${predicate}`, canary);
          if (row.n) hits.push(`${column.table_name}.${column.column_name} contains ${canary}`);
        }
      }
      assert.deepEqual(hits, [], "no plaintext body/preview/note/draft canary in any Mail column, index source or audit row");
      const [fts] = await client.$queryRawUnsafe(`SELECT count(*)::int AS n FROM mail_messages WHERE to_tsvector('simple', metadata_search_text) @@ plainto_tsquery('simple', $1)`, canaries.inbound);
      assert.equal(fts.n, 0, "full-text index has no body terms");
      assert.deepEqual((await call("carol", "GET", `/search?q=${canaries.inbound}`)).body.data, [], "body search is not available");
      assert.ok((await call("carol", "GET", "/search?q=Canary")).body.data.length >= 1, "metadata (subject) search still works");
      for (const object of harness.backend.objects.values()) {
        for (const canary of Object.values(canaries)) assert.ok(!object.includes(Buffer.from(canary)), "private storage holds ciphertext only");
      }
      // BCC never reaches searchable metadata.
      const [bcc] = await client.$queryRawUnsafe(`SELECT count(*)::int AS n FROM mail_messages WHERE metadata_search_text ILIKE '%canary-bcc@partner.example%'`);
      assert.equal(bcc.n, 0);
    });

    await t.test("Hardening: external delivery requires a configured provider and a non-empty sender-domain allowlist, at enqueue and at dispatch", async () => {
      const alice = await client.adminUser.findUnique({ where: { id: ids.alice } });
      const newDraft = async (body = {}) => (await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["gate@partner.example"], subject: "Gate", text: "x", ...body })).body.data;
      const reasonOf = (error) => error.errors?.[0]?.reason;
      const providerCalls = async (messageId) => {
        const { rfcMessageId } = await client.mailMessage.findUnique({ where: { id: messageId } });
        return harness.adapter.state.sent.filter((request) => request.headers["Message-ID"] === rfcMessageId).length;
      };

      // Enqueue-time denials (nothing is queued).
      const emptyAllowlist = harness.variant({ MAIL_DOMAIN_ALLOWLIST: "" });
      let draft = await newDraft();
      await assert.rejects(emptyAllowlist.services.compose.sendDraft(alice, draft.id, { revision: 1 }), (error) => error.code === "MAIL_SENDER_NOT_AUTHORIZED" && reasonOf(error) === "SENDER_DOMAIN_ALLOWLIST_EMPTY");
      const internalOnly = await newDraft({ to: ["bob@cosmicforge.example"] });
      assert.equal((await emptyAllowlist.services.compose.sendDraft(alice, internalOnly.id, { revision: 1 })).status, "DELIVERED", "internal delivery is not governed by the external allowlist");
      const disabled = harness.variant({ MAIL_SENDING_ENABLED: "false" });
      await assert.rejects(disabled.services.compose.sendDraft(alice, draft.id, { revision: 1 }), (error) => error.code === "MAIL_SENDING_DISABLED");
      const { notConfiguredAdapter } = require("../src/modules/mail/adapters");
      const noProvider = harness.variant({}, { adapter: notConfiguredAdapter("no credentials") });
      await assert.rejects(noProvider.services.compose.sendDraft(alice, draft.id, { revision: 1 }), (error) => error.code === "MAIL_PROVIDER_UNAVAILABLE" && reasonOf(error) === "MAIL_PROVIDER_NOT_CONFIGURED");
      assert.equal(await client.mailMessage.count({ where: { subject: "Gate", sentByAdminUserId: ids.alice, direction: "OUTBOUND", status: { not: "DELIVERED" } } }), 0, "denied sends never create queued messages");

      // A verified but non-allowlisted domain is refused (HTTP contract).
      // Registered while an operator had it on a wider allowlist; the running config no longer lists it.
      const wider = harness.variant({ MAIL_DOMAIN_ALLOWLIST: "cosmicforge.example,unrelated-verified.example" });
      const mailAdminUser = await client.adminUser.findUnique({ where: { id: ids.mailAdmin } });
      const other = await wider.services.admin.createDomain(mailAdminUser, { organizationId: state.orgId, domain: "unrelated-verified.example", providerDomainId: "dom_other" }, {});
      harness.adapter.state.domains.set("dom_other", { status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "VERIFIED", records: [] });
      assert.equal((await call("mailAdmin", "POST", `/admin/domains/${other.id}/verify`)).body.data.status, "VERIFIED");
      assert.equal((await call("mailAdmin", "POST", "/admin/domains", { organizationId: state.orgId, domain: "another-unlisted.example" })).status, 400, "registration also honours the allowlist");
      const alias = await call("mailAdmin", "POST", "/admin/addresses", { domainId: other.id, localPart: "alice", kind: "ALIAS", mailboxId: state.aliceBox, aliasOfAddressId: state.addr.alice.id });
      assert.equal(alias.status, 201, alias.text);
      draft = await newDraft({ senderAddressId: alias.body.data.id });
      const refused = await call("alice", "POST", `/drafts/${draft.id}/send`, { revision: 1 });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, "MAIL_SENDER_NOT_AUTHORIZED");
      assert.equal(refused.body.errors[0].reason, "SENDER_DOMAIN_NOT_ALLOWLISTED");

      // Dispatch-time denials for mail queued while everything was allowed.
      const queue = async () => {
        const d = await newDraft();
        const result = await call("alice", "POST", `/drafts/${d.id}/send`, { revision: 1 });
        assert.equal(result.status, 202, result.text);
        return result.body.data;
      };
      const cases = [
        { name: "allowlist changed", worker: () => harness.variant({ MAIL_DOMAIN_ALLOWLIST: "unrelated-verified.example" }).createWorker(), reason: "SENDER_DOMAIN_NOT_ALLOWLISTED" },
        { name: "allowlist emptied", worker: () => harness.variant({ MAIL_DOMAIN_ALLOWLIST: "" }).createWorker(), reason: "SENDER_DOMAIN_ALLOWLIST_EMPTY" },
        { name: "provider credentials removed", worker: () => harness.variant({}, { adapter: notConfiguredAdapter("removed") }).createWorker(), reason: "MAIL_PROVIDER_NOT_CONFIGURED" },
        {
          name: "domain suspended",
          before: () => client.mailDomain.update({ where: { id: state.domainId }, data: { status: "SUSPENDED" } }),
          after: () => client.mailDomain.update({ where: { id: state.domainId }, data: { status: "VERIFIED" } }),
          worker: () => harness.worker,
          reason: "SENDER_DOMAIN_SENDING_DISABLED",
        },
      ];
      for (const entry of cases) {
        const queued = await queue();
        await entry.before?.();
        await entry.worker().drain();
        await entry.after?.();
        const message = await client.mailMessage.findUnique({ where: { id: queued.messageId }, include: { recipients: true } });
        assert.equal(message.status, "FAILED", entry.name);
        assert.equal(message.recipients[0].lastEventDetail, entry.reason, entry.name);
        assert.equal(await providerCalls(queued.messageId), 0, `${entry.name}: provider never called`);
        assert.ok(await client.mailAuditEvent.count({ where: { action: "MAIL_SEND_BLOCKED_AT_DISPATCH", targetId: queued.messageId } }), `${entry.name}: audited`);
      }
      // Control: with the original configuration the same path still sends.
      const control = await queue();
      await drain();
      assert.equal(await providerCalls(control.messageId), 1);
    });

    await t.test("Closure: EXECUTIVE tier has no implicit private-mail access; restricted-health brands never reach the provider; redacted operations views", async () => {
      // Spec §19.2: negative API cases for every tier (EMPLOYEE/ADMIN/SUPER covered above).
      assert.deepEqual((await call("grace", "GET", "/me/mailboxes")).body.data, []);
      assert.equal((await call("grace", "GET", `/mailboxes/${state.aliceBox}/threads`)).status, 404);
      assert.equal((await call("grace", "GET", `/mailboxes/${state.aliceBox}`)).status, 404);

      // Spec §19.7: a HealthNet (restricted-health) brand cannot send through Resend.
      const mailAdminUser = await client.adminUser.findUnique({ where: { id: ids.mailAdmin } });
      const alice = await client.adminUser.findUnique({ where: { id: ids.alice } });
      const wide = harness.variant({ MAIL_DOMAIN_ALLOWLIST: "cosmicforge.example,healthnet-clinic.example" });
      const org = await wide.services.admin.createOrganization(mailAdminUser, { slug: "healthnet-clinic", name: "HealthNet Clinic" }, {});
      const domain = await wide.services.admin.createDomain(mailAdminUser, { organizationId: org.id, domain: "healthnet-clinic.example", providerDomainId: "dom_hn" }, {});
      harness.adapter.state.domains.set("dom_hn", { status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "VERIFIED", records: [] });
      await wide.services.admin.verifyDomain(mailAdminUser, domain.id, {});
      const box = await wide.services.admin.createMailbox(mailAdminUser, { organizationId: org.id, type: "PERSONAL", ownerAdminUserId: ids.alice, address: { domainId: domain.id, localPart: "alice" } }, {});
      const draft = await wide.services.compose.createDraft(alice, box.id, { to: ["patient@external.example"], subject: "Results", text: "x" });
      await assert.rejects(wide.services.compose.sendDraft(alice, draft.id, { revision: draft.revision }), (error) => error.code === "MAIL_SENDER_NOT_AUTHORIZED" && error.errors?.[0]?.reason === "SENDER_ORGANIZATION_RESTRICTED_HEALTH");
      assert.equal(await client.mailMessage.count({ where: { mailboxId: box.id } }), 0, "nothing queued");
      const approved = harness.variant({ MAIL_DOMAIN_ALLOWLIST: "cosmicforge.example,healthnet-clinic.example", MAIL_RESTRICTED_HEALTH_PROVIDER_APPROVED: "true" });
      assert.equal((await approved.services.compose.sendDraft(alice, draft.id, { revision: draft.revision })).status, "QUEUED", "only an explicit, approval-backed override lifts the block");
      // The queued message is still re-checked at dispatch by a worker without the override.
      await wide.createWorker().drain();
      const blocked = await client.mailMessage.findFirst({ where: { mailboxId: box.id }, include: { recipients: true } });
      assert.equal(blocked.status, "FAILED");
      assert.equal(blocked.recipients[0].lastEventDetail, "SENDER_ORGANIZATION_RESTRICTED_HEALTH");

      // Spec §5.8/§9: operations views are admin-only and redacted.
      for (const path of ["/admin/audit-events", "/admin/webhook-events", "/admin/delivery-events", "/admin/jobs?status=DEAD_LETTER"]) {
        assert.equal((await call("alice", "GET", path)).status, 403, path);
        const response = await call("mailAdmin", "GET", path);
        assert.equal(response.status, 200, `${path} ${response.text}`);
        assert.equal(/"payload"|"html"|"text"|encrypted/i.test(response.text), false, `${path} exposes no content`);
      }
      for (const path of ["/admin/jobs?status=RUNNING", "/admin/jobs?queue=NOPE", "/admin/webhook-events?status=x", "/admin/delivery-events?eventType=x"]) {
        const bad = await call("mailAdmin", "GET", path);
        assert.equal(bad.status, 400, `${path} is a validation error, not a 500`);
      }
      // Provider events are settled with their jobs (backlog, lag, retention).
      await harness.worker.drain();
      assert.equal(await client.mailWebhookEvent.count({ where: { status: "RECEIVED", jobs: { none: { status: { in: ["PENDING", "LEASED", "RETRY_SCHEDULED", "RECONCILING"] } } } } }), 0, "no settled job leaves its event RECEIVED");
      const webhooks = (await call("mailAdmin", "GET", "/admin/webhook-events")).body.data;
      assert.ok(webhooks.length > 0 && webhooks.every((row) => !("payload" in row) && "lagSeconds" in row));
      assert.ok(webhooks.some((row) => row.status === "PROCESSED" && typeof row.lagSeconds === "number"), "processing lag is reported");
      const deliveries = (await call("mailAdmin", "GET", "/admin/delivery-events")).body.data;
      assert.ok(deliveries.length > 0 && deliveries.every((row) => !("recipient" in row) && !String(row.recipientDomain || "").includes("@")));
      const audits = (await call("mailAdmin", "GET", `/admin/audit-events?targetId=${blocked.id}`)).body.data;
      assert.ok(audits.some((row) => row.action === "MAIL_SEND_BLOCKED_AT_DISPATCH"));

      // Spec §15/§24: HR onboarding raises a request for the employee; IT approves.
      const hrRequest = await call("hrManager", "POST", "/provisioning/requests", { type: "PERSONAL_MAILBOX", requestedAddress: "bob.mensah@cosmicforge.example", subjectAdminUserId: ids.bob, justification: "New starter" });
      assert.equal(hrRequest.status, 201, hrRequest.text);
      assert.equal(hrRequest.body.data.subjectAdminUserId, ids.bob);
      assert.equal(hrRequest.body.data.status, "PENDING");
      const selfOnly = await call("alice", "POST", "/provisioning/requests", { type: "PERSONAL_MAILBOX", requestedAddress: "bob.other@cosmicforge.example", subjectAdminUserId: ids.bob });
      assert.equal(selfOnly.status, 403, "an ordinary employee cannot raise a request for someone else (refused, not re-targeted)");
      assert.equal((await call("hrManager", "POST", "/provisioning/requests", { type: "PERSONAL_MAILBOX", requestedAddress: "ghost@cosmicforge.example", subjectAdminUserId: ids.mallory })).status, 201, "pending starters can be provisioned ahead of activation");
      assert.equal((await call("hrManager", "POST", "/provisioning/requests", { type: "PERSONAL_MAILBOX", requestedAddress: "nobody@cosmicforge.example", subjectAdminUserId: "c0000000-0000-4000-8000-999999999999" })).status, 400);
      assert.equal((await call("hrManager", "POST", `/provisioning/requests/${hrRequest.body.data.id}/approve`, {})).status, 403, "HR cannot approve; Mail administration does");
      assert.equal((await call("hrManager", "GET", "/admin/mailboxes")).status, 403, "HR authority grants no Mail administration");
      assert.ok((await call("hrManager", "GET", "/provisioning/requests")).body.data.every((row) => row.requestedByAdminUserId === ids.hrManager), "HR sees only the requests it raised");

      // Active sender grants are listed for administrators only.
      const granted = await call("mailAdmin", "POST", "/admin/sender-grants", { mailboxId: state.supportBox, addressId: state.addr.support.id, adminUserId: ids.carol });
      assert.equal(granted.status, 201, granted.text);
      assert.equal((await call("alice", "GET", "/admin/sender-grants")).status, 403);
      let grants = await call("mailAdmin", "GET", `/admin/sender-grants?mailboxId=${state.supportBox}`);
      assert.equal(grants.status, 200, grants.text);
      assert.deepEqual(grants.body.data.map((row) => [row.mailbox.id, row.address.address, row.member.id]), [[state.supportBox, "support@cosmicforge.example", ids.carol]]);
      assert.equal((await call("mailAdmin", "DELETE", `/admin/sender-grants/${granted.body.data.id}`)).status, 200);
      grants = await call("mailAdmin", "GET", `/admin/sender-grants?mailboxId=${state.supportBox}`);
      assert.deepEqual(grants.body.data, [], "revoked grants are not listed as active");
    });

    await t.test("Hardening: unknown provider outcomes are never presented as delivered", async () => {
      const draft = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["unknown-outcome@partner.example"], subject: "Unknown outcome", text: "x" });
      const sent = (await call("alice", "POST", `/drafts/${draft.body.data.id}/send`, { revision: 1 })).body.data;
      harness.adapter.failNext("sendMessage", "IDEMPOTENCY_CONFLICT", "RESEND_IDEMPOTENCY_CONFLICT");
      await drain();
      const status = (await call("alice", "GET", `/messages/${sent.messageId}/status`)).body.data;
      assert.equal(status.status, "OUTCOME_UNKNOWN");
      assert.ok(status.recipients.every((recipient) => recipient.status !== "DELIVERED"));
      const thread = (await call("alice", "GET", `/threads/${sent.threadId}`)).body.data;
      assert.equal(thread.lastDeliveryStatus, "OUTCOME_UNKNOWN");
      // An unrelated provider event cannot resolve it.
      await webhook("email.delivered", { email_id: "some-other-provider-id", to: ["unknown-outcome@partner.example"] });
      await drain();
      assert.equal((await call("alice", "GET", `/messages/${sent.messageId}/status`)).body.data.status, "OUTCOME_UNKNOWN");
      const job = await client.mailOutboxJob.findUnique({ where: { id: sent.jobId } });
      assert.notEqual(job.status, "RETRY_SCHEDULED", "unknown outcomes are never retried automatically");
    });

    await t.test("Regression: dispatch follows the batch plan, not message status; status never regresses", async () => {
      const { MailProviderError } = require("../src/modules/mail/adapters/mail-provider.contract");
      const original = harness.adapter.sendMessage;
      let refused = false;
      harness.adapter.sendMessage = async (request) => {
        if (!refused && request.to.some((party) => party.address === "plan-b1@partner.example")) {
          refused = true;
          throw new MailProviderError("RETRYABLE", "RESEND_HTTP_429", "rate limited", { status: 429, retryAfterSeconds: 60 });
        }
        return original(request);
      };
      try {
        const draft = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { bcc: ["plan-b0@partner.example", "plan-b1@partner.example"], subject: "Plan batches", text: "x" });
        const sent = (await call("alice", "POST", `/drafts/${draft.body.data.id}/send`, { revision: 1 })).body.data;
        await harness.worker.drain({ maxTicks: 1 });
        const b0 = harness.adapter.state.sent.find((entry) => entry.to.some((party) => party.address === "plan-b0@partner.example"));
        assert.ok(b0 && refused, "batch 0 accepted, batch 1 refused with 429");
        // Batch 0 bounces before batch 1 is retried (no time advance: retry not due).
        await webhook("email.bounced", { email_id: b0.providerMessageId, to: ["plan-b0@partner.example"], bounce: { type: "Permanent", message: "unknown" } });
        await harness.worker.drain({ maxTicks: 2 });
        assert.equal((await client.mailMessage.findUnique({ where: { id: sent.messageId } })).status, "BOUNCED");
        await drain();
        const b1 = harness.adapter.state.sent.filter((entry) => entry.to.some((party) => party.address === "plan-b1@partner.example"));
        assert.equal(b1.length, 1, "batch 1 is still sent after a batch 0 event");
        const message = await client.mailMessage.findUnique({ where: { id: sent.messageId }, include: { recipients: true, outboxJobs: true } });
        assert.equal(message.recipients.find((r) => r.address === "plan-b1@partner.example").status, "PROVIDER_ACCEPTED");
        assert.equal(message.status, "BOUNCED", "dispatch keeps the event-derived BOUNCED state");
        assert.equal(message.outboxJobs[0].status, "SUCCEEDED");
      } finally {
        harness.adapter.sendMessage = original;
      }
    });

    await t.test("Regression: earlier ambiguity survives later definitive errors at dead letter", async () => {
      const { MailProviderError } = require("../src/modules/mail/adapters/mail-provider.contract");
      // Attempt 1 times out after the provider accepted; attempts 2..4 get 429.
      const draft = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["sticky@partner.example"], subject: "Sticky ambiguity", text: "x" });
      harness.adapter.failNext("sendMessage", "AMBIGUOUS", "PROVIDER_TIMEOUT", { acceptBeforeFailing: true });
      const original = harness.adapter.sendMessage;
      let calls = 0;
      harness.adapter.sendMessage = async (request) => {
        if (request.to.some((party) => party.address === "sticky@partner.example") && ++calls > 1) throw new MailProviderError("RETRYABLE", "RESEND_HTTP_429", "rate limited", { status: 429 });
        return original(request);
      };
      const crashDraft = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["crashed@partner.example"], subject: "Crashed worker", text: "x" });
      let crashCalls = 0;
      const sticky = harness.adapter.sendMessage;
      harness.adapter.sendMessage = async (request) => {
        if (request.to.some((party) => party.address === "crashed@partner.example")) {
          // First attempt dies mid-call (no provider answer); later ones get 429.
          if (++crashCalls === 1) throw new Error("worker crashed mid-call");
          throw new MailProviderError("RETRYABLE", "RESEND_HTTP_429", "rate limited", { status: 429 });
        }
        return sticky(request);
      };
      const failedNotices = () => client.notification.count({ where: { adminUserId: ids.alice, title: "Email could not be sent" } });
      const noticesBefore = await failedNotices();
      try {
        const sent = (await call("alice", "POST", `/drafts/${draft.body.data.id}/send`, { revision: 1 })).body.data;
        const crashed = (await call("alice", "POST", `/drafts/${crashDraft.body.data.id}/send`, { revision: 1 })).body.data;
        for (let index = 0; index < 6; index += 1) await drain();
        for (const { jobId, messageId } of [sent, crashed]) {
          assert.equal((await client.mailOutboxJob.findUnique({ where: { id: jobId } })).status, "DEAD_LETTER");
          const message = await client.mailMessage.findUnique({ where: { id: messageId }, include: { recipients: true } });
          assert.equal(message.status, "OUTCOME_UNKNOWN", "possibly accepted mail is never reported as failed");
          assert.equal(message.recipients[0].status, "OUTCOME_UNKNOWN");
        }
        assert.equal(await failedNotices(), noticesBefore, "sender is never told to re-send possibly delivered mail");
      } finally {
        harness.adapter.sendMessage = original;
      }
    });

    await t.test("Regression: delivery events are attributed per batch; suppressed, early and tracking events", async () => {
      // To + Cc in one provider request.
      const draft = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["attr-to@partner.example"], cc: ["attr-cc@partner.example"], subject: "Attribution", text: "x" });
      const sent = (await call("alice", "POST", `/drafts/${draft.body.data.id}/send`, { revision: 1 })).body.data;
      await drain();
      const request = harness.adapter.state.sent.find((entry) => entry.to.some((party) => party.address === "attr-to@partner.example"));
      const recipientStatus = async (messageId, address) => (await client.mailMessageRecipient.findFirst({ where: { messageId, address } })).status;
      await webhook("email.delivered", { email_id: request.providerMessageId, to: ["attr-to@partner.example"] });
      await drain();
      assert.equal(await recipientStatus(sent.messageId, "attr-to@partner.example"), "DELIVERED");
      assert.equal(await recipientStatus(sent.messageId, "attr-cc@partner.example"), "PROVIDER_ACCEPTED", "unnamed Cc stays accepted, not guessed");
      // Resend echoes the To list on a bounce: it does not say who bounced.
      await webhook("email.bounced", { email_id: request.providerMessageId, to: ["attr-to@partner.example"], bounce: { type: "Permanent", message: "unknown" } });
      await drain();
      assert.equal(await recipientStatus(sent.messageId, "attr-to@partner.example"), "DELIVERED");
      assert.equal(await recipientStatus(sent.messageId, "attr-cc@partner.example"), "PROVIDER_ACCEPTED");
      assert.equal(await client.marketingSuppression.count({ where: { email: { in: ["attr-to@partner.example", "attr-cc@partner.example"] } } }), 0, "no suppression for unattributed bounces");
      const bounce = await client.mailDeliveryEvent.findFirst({ where: { messageId: sent.messageId, eventType: "BOUNCED" } });
      assert.equal(bounce.detail.unattributed, true);

      // email.suppressed (not a marketing send) fails the recipient.
      const lone = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["suppressed@partner.example"], subject: "Suppressed", text: "x" });
      const loneSent = (await call("alice", "POST", `/drafts/${lone.body.data.id}/send`, { revision: 1 })).body.data;
      await drain();
      const loneRequest = harness.adapter.state.sent.find((entry) => entry.to.some((party) => party.address === "suppressed@partner.example"));
      await webhook("email.suppressed", { email_id: loneRequest.providerMessageId, to: ["suppressed@partner.example"] });
      // Open/click tracking is never recorded for mailbox mail.
      await webhook("email.opened", { email_id: loneRequest.providerMessageId, to: ["suppressed@partner.example"] });
      await drain();
      const loneRecipient = await client.mailMessageRecipient.findFirst({ where: { messageId: loneSent.messageId } });
      assert.equal(loneRecipient.status, "FAILED");
      assert.equal(loneRecipient.lastEventDetail, "SUPPRESSED_BY_PROVIDER");
      const suppressedEvent = await client.mailDeliveryEvent.findFirst({ where: { messageId: loneSent.messageId, eventType: "FAILED" } });
      assert.equal(suppressedEvent.detail.suppressed, true);
      assert.equal((await client.mailMessage.findUnique({ where: { id: loneSent.messageId } })).status, "FAILED");
      assert.equal(await client.mailDeliveryEvent.count({ where: { providerMessageId: loneRequest.providerMessageId, eventType: { in: ["OPENED", "CLICKED"] } } }), 0);

      // An event processed before acceptance commits is re-applied afterwards.
      const early = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["early@partner.example"], subject: "Early event", text: "x" });
      const earlySent = (await call("alice", "POST", `/drafts/${early.body.data.id}/send`, { revision: 1 })).body.data;
      const original = harness.adapter.sendMessage;
      harness.adapter.sendMessage = async (req) => {
        const result = await original(req);
        if (req.to.some((party) => party.address === "early@partner.example")) {
          // Real provider events always carry the sender; before acceptance
          // commits it is the only thing that marks the event as CA's.
          const hook = await webhook("email.delivered", { email_id: result.providerMessageId, from: "Alice Okafor <alice@cosmicforge.example>", to: ["early@partner.example"] });
          const event = await client.mailWebhookEvent.findFirst({ where: { providerEventId: hook.id } });
          await harness.mail.processors.deliveryEvents.process({ webhookEventId: event.id });
          await client.mailOutboxJob.updateMany({ where: { webhookEventId: event.id }, data: { status: "SUCCEEDED" } });
        }
        return result;
      };
      try {
        await drain();
      } finally {
        harness.adapter.sendMessage = original;
      }
      assert.equal(await recipientStatus(earlySent.messageId, "early@partner.example"), "DELIVERED", "early event applied after acceptance");
      assert.equal(await client.mailDeliveryEvent.count({ where: { messageId: earlySent.messageId, eventType: "DELIVERED" } }), 1);
      await harness.mail.processors.deliveryEvents.reapplyUnmatched(harness.adapter.state.sent.at(-1).providerMessageId);
      assert.equal(await client.mailDeliveryEvent.count({ where: { messageId: earlySent.messageId, eventType: "DELIVERED" } }), 1, "re-apply is idempotent");
    });

    await t.test("Regression: org quota counts queued recipients, is race-safe, and is re-checked at dispatch", async () => {
      const usage = harness.mail.services.usage;
      const staffQueued = () => client.mailMessageRecipient.count({ where: { status: "PENDING", message: { direction: "OUTBOUND", mailbox: { organizationId: state.orgId, NOT: { purpose: "SUPPORT" } } } } });
      const base = (await usage.totals(state.orgId, "STAFF_MAIL")).today + (await staffQueued());
      await client.mailQuotaLimit.create({ data: { organizationId: state.orgId, purpose: "STAFF_MAIL", dailyHardLimit: base + 3, updatedBy: ids.mailAdmin } });
      const send = async (to) => {
        const draft = await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to, subject: "Quota", text: "x" });
        return call("alice", "POST", `/drafts/${draft.body.data.id}/send`, { revision: 1 });
      };
      try {
        const results = await Promise.all([send(["q1@partner.example", "q2@partner.example"]), send(["q3@partner.example", "q4@partner.example"])]);
        assert.deepEqual(results.map((r) => r.status).sort(), [202, 429], "concurrent sends cannot both pass");
        const refused = await send(["q5@partner.example", "q6@partner.example"]);
        assert.equal(refused.status, 429, "queued, not yet accepted recipients count");
        assert.equal(refused.body.code, "MAIL_QUOTA_HARD_LIMIT");
        await drain();
        // Dispatch re-check: over the hard limit queued mail is deferred, not failed.
        const pending = (await send(["q7@partner.example"])).body.data;
        assert.ok(pending.jobId);
        await client.mailQuotaLimit.update({ where: { organizationId_purpose: { organizationId: state.orgId, purpose: "STAFF_MAIL" } }, data: { dailyHardLimit: null, monthlyHardLimit: 1 } });
        // Monthly, not daily: every drain() moves the harness clock 4h, so a
        // daily limit would reset whenever that crosses midnight.
        await drain();
        const held = await client.mailOutboxJob.findUnique({ where: { id: pending.jobId } });
        assert.equal(held.status, "RETRY_SCHEDULED");
        assert.equal(held.lastErrorCode, "MAIL_QUOTA_HARD_LIMIT");
        assert.equal((await client.mailMessageRecipient.findFirst({ where: { messageId: pending.messageId } })).status, "PENDING");
      } finally {
        await client.mailQuotaLimit.deleteMany({ where: { organizationId: state.orgId, purpose: "STAFF_MAIL" } });
      }
      await drain();
      assert.equal(harness.adapter.state.sent.filter((entry) => entry.to.some((party) => party.address === "q7@partner.example")).length, 1, "sent once the limit allows");

      // Provider quota exhausted (429 daily_quota_exceeded): held until the
      // reset, not retried hourly or failed; recipients stay queued.
      // The reset is computed when the worker sends (drain() first moves the
      // clock 4h), not now: a fixed time would put the reset in the past
      // whenever those 4h cross UTC midnight.
      harness.adapter.failNext("sendMessage", "QUOTA_EXHAUSTED", "DAILY", { now: () => harness.clock() });
      const quotaSend = await send(["q8@partner.example"]);
      assert.equal(quotaSend.status, 202, quotaSend.text);
      await drain();
      const quotaJob = await client.mailOutboxJob.findUnique({ where: { id: quotaSend.body.data.jobId } });
      assert.equal(quotaJob.status, "RETRY_SCHEDULED");
      assert.equal(quotaJob.lastErrorCode, "PROVIDER_QUOTA_EXHAUSTED");
      assert.ok(quotaJob.nextAttemptAt.getTime() > harness.clock().getTime(), "deferred to the quota reset");
      assert.equal((await client.mailMessageRecipient.findFirst({ where: { messageId: quotaSend.body.data.messageId } })).status, "PENDING");
      // Re-audit 7a (spec 11.6): the sender is told once (an alert, never the
      // suppressible NEW_MAIL kind) and the status API explains the wait.
      const quotaSender = (await client.mailMessage.findUnique({ where: { id: quotaSend.body.data.messageId } })).sentByAdminUserId;
      const waitNotices = () => client.notification.count({ where: { adminUserId: quotaSender, title: "Email waiting for provider quota reset" } });
      assert.equal(await waitNotices(), 1);
      const waiting = await call("alice", "GET", `/messages/${quotaSend.body.data.messageId}/status`);
      assert.equal(waiting.status, 200, waiting.text);
      assert.equal(waiting.body.data.status, "QUEUED");
      assert.equal(waiting.body.data.statusDetail.code, "PROVIDER_QUOTA_WAIT");
      assert.equal(waiting.body.data.statusDetail.quotaKind, "DAILY");
      assert.ok(new Date(waiting.body.data.statusDetail.until).getTime() > harness.clock().getTime());
      assert.match(waiting.body.data.statusDetail.message, /^Waiting for provider quota reset \(until /);
      // A second quota refusal for the same send does not notify again.
      harness.adapter.failNext("sendMessage", "QUOTA_EXHAUSTED", "DAILY", { now: new Date(quotaJob.nextAttemptAt.getTime() + 1000) });
      harness.advance(quotaJob.nextAttemptAt.getTime() - harness.clock().getTime() + 1000);
      await drain();
      assert.equal((await client.mailOutboxJob.findUnique({ where: { id: quotaSend.body.data.jobId } })).lastErrorCode, "PROVIDER_QUOTA_EXHAUSTED");
      assert.equal(await waitNotices(), 1, "notified once per send");
      harness.advance(25 * 3600000);
      await drain();
      assert.equal(harness.adapter.state.sent.filter((entry) => entry.to.some((party) => party.address === "q8@partner.example")).length, 1, "sent once after the reset");
      assert.equal((await call("alice", "GET", `/messages/${quotaSend.body.data.messageId}/status`)).body.data.statusDetail, null, "no wait reported after the send");
    });

    await t.test("Regression: staff send policy (suppression, links, size, Reply-To, internal copies, idempotency)", async () => {
      const alice = await client.adminUser.findUnique({ where: { id: ids.alice } });
      const draftFor = async (body) => (await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { subject: "Policy", text: "x", ...body })).body.data;
      // Suppressed (previously bounced) external address.
      const suppressedDraft = await draftFor({ to: ["plan-b0@partner.example", "fine@partner.example"] });
      const suppressed = await call("alice", "POST", `/drafts/${suppressedDraft.id}/send`, { revision: 1 });
      assert.equal(suppressed.status, 422, suppressed.text);
      assert.equal(suppressed.body.errors[0].reason, "RECIPIENT_SUPPRESSED");
      assert.deepEqual(suppressed.body.errors[0].addresses, ["plan-b0@partner.example"]);

      // Phishing-style link text.
      const phish = await draftFor({ to: ["fine@partner.example"], html: '<p><a href="https://evil.example/login">https://cosmicforge.example/login</a></p>' });
      const blocked = await call("alice", "POST", `/drafts/${phish.id}/send`, { revision: 1 });
      assert.equal(blocked.status, 422, blocked.text);
      assert.equal(blocked.body.errors[0].reason, "UNSAFE_LINK");

      // Total message size limit.
      const small = harness.variant({ MAIL_MESSAGE_MAX_BYTES: "1024" });
      const big = await draftFor({ to: ["fine@partner.example"], text: "y".repeat(2048) });
      await assert.rejects(small.services.compose.sendDraft(alice, big.id, { revision: 1 }), (error) => error.statusCode === 413 && error.errors[0].reason === "MESSAGE_TOO_LARGE");

      // Reply-To must be an address the sender is granted.
      const alias = await client.mailAddress.findUnique({ where: { address: "a.okafor@cosmicforge.example" } });
      const replyDraft = await draftFor({ to: ["reply-to@partner.example", "bob@cosmicforge.example"] });
      await assert.rejects(harness.mail.services.compose.sendDraft(alice, replyDraft.id, { revision: 1, replyToAddressId: state.addr.bob.id }), (error) => error.code === "MAIL_SENDER_NOT_AUTHORIZED");
      const replied = await harness.mail.services.compose.sendDraft(alice, replyDraft.id, { revision: 1, replyToAddressId: alias.id });
      assert.equal((await client.mailMessage.findUnique({ where: { id: replied.messageId } })).replyTo, "a.okafor@cosmicforge.example");
      await drain();
      assert.equal(harness.adapter.state.sent.find((entry) => entry.to.some((party) => party.address === "reply-to@partner.example")).replyTo, "a.okafor@cosmicforge.example");

      // Internal copies never claim delivery for external recipients.
      const { rfcMessageId } = await client.mailMessage.findUnique({ where: { id: replied.messageId } });
      const bobCopy = await client.mailMessage.findFirst({ where: { mailboxId: state.bobBox, rfcMessageId }, include: { recipients: true } });
      assert.equal(bobCopy.direction, "INTERNAL");
      assert.equal(bobCopy.replyTo, "a.okafor@cosmicforge.example");
      assert.ok(bobCopy.recipients.length === 2 && bobCopy.recipients.every((recipient) => recipient.status === "INTERNAL_DELIVERED"));

      // Idempotency-Key: reuse for another draft is a conflict; concurrent
      // same-key requests both get the one message.
      const first = await draftFor({ to: ["idem@partner.example"] });
      const ok = await call("alice", "POST", `/drafts/${first.id}/send`, { revision: 1 }, { "Idempotency-Key": "policy-key-0001" });
      assert.equal(ok.status, 202, ok.text);
      const other = await draftFor({ to: ["idem2@partner.example"] });
      const reused = await call("alice", "POST", `/drafts/${other.id}/send`, { revision: 1 }, { "Idempotency-Key": "policy-key-0001" });
      assert.equal(reused.status, 409, reused.text);
      assert.equal(reused.body.errors[0].reason, "IDEMPOTENCY_KEY_REUSED");
      const racing = await draftFor({ to: ["idem3@partner.example"] });
      const both = await Promise.all([1, 2].map(() => call("alice", "POST", `/drafts/${racing.id}/send`, { revision: 1 }, { "Idempotency-Key": "policy-key-0002" })));
      assert.deepEqual(both.map((r) => r.status), [202, 202], both.map((r) => r.text).join(" | "));
      assert.equal(both[0].body.data.messageId, both[1].body.data.messageId);
      await drain();
    });

    await t.test("Malware scanning: clamd verdicts quarantine EICAR and scanner outages; only an admin rescan can clear unscanned files", async () => {
      const { clamdScanner } = require("../src/modules/mail/scanning/attachment-scanner");
      const { startFakeClamd, closedPort } = require("./helpers/mail-infra-fakes");
      const clamd = await startFakeClamd();
      try {
        const live = harness.variant({}, { scanner: clamdScanner({ host: clamd.host, port: clamd.port, timeoutMs: 2000, connectTimeoutMs: 1000 }) });
        const down = harness.variant({}, { scanner: clamdScanner({ host: "127.0.0.1", port: await closedPort(), timeoutMs: 500, connectTimeoutMs: 300 }) });
        const inbound = (id, subject, attachment) => {
          harness.adapter.addInbound(id, { from: { address: "sender@client.example", name: null }, to: [{ address: "alice@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [], subject, html: null, text: "see attached", rfcMessageId: `<${id}@client.example>`, inReplyTo: null, references: [], receivedAt: harness.clock() }, [attachment]);
          return webhook("email.received", { email_id: id, to: ["alice@cosmicforge.example"] });
        };
        const attachmentOf = async (subject) => {
          const row = await client.mailMessage.findFirst({ where: { subject, mailboxId: state.aliceBox }, include: { attachments: true } });
          return { message: row, attachment: row.attachments[0] };
        };

        // EICAR through real clamd protocol => INFECTED, message quarantined, not downloadable.
        await inbound("scan_eicar", "Scan EICAR", { filename: "eicar.com.txt", contentType: "text/plain", content: Buffer.from(EICAR) });
        harness.advance(4 * 3600 * 1000);
        await live.createWorker().drain();
        const infected = await attachmentOf("Scan EICAR");
        assert.equal(infected.attachment.scanStatus, "INFECTED");
        assert.equal(infected.attachment.scanDetail, "Win.Test.EICAR_HDB-1");
        assert.equal(infected.attachment.quarantined, true);
        assert.equal(infected.message.status, "QUARANTINED");
        const eicarDownload = await call("alice", "GET", `/attachments/${infected.attachment.id}/download`);
        assert.equal(eicarDownload.status, 403);
        assert.equal(eicarDownload.body.code, "MAIL_ATTACHMENT_QUARANTINED");
        assert.equal(clamd.state.streams.at(-1).bytes, Buffer.from(EICAR).length, "clamd scanned the attachment bytes");

        // Scanner outage => attachment quarantined (fail closed), never CLEAN.
        await inbound("scan_outage", "Scan outage", { filename: "report.txt", contentType: "text/plain", content: Buffer.from("quarterly numbers") });
        harness.advance(4 * 3600 * 1000);
        await down.createWorker().drain();
        const unscanned = await attachmentOf("Scan outage");
        assert.equal(unscanned.attachment.scanStatus, "SCANNER_UNAVAILABLE");
        assert.equal(unscanned.attachment.quarantined, true);
        assert.equal((await call("alice", "GET", `/attachments/${unscanned.attachment.id}/download`)).status, 403);
        const listed = await call("alice", "GET", `/threads/${unscanned.message.threadId}/messages`);
        assert.equal(listed.body.data[0].attachments[0].downloadable, false);

        // Outbound uploads are scanned too; unscanned attachments block sending.
        const alice = await client.adminUser.findUnique({ where: { id: ids.alice } });
        const draft = (await call("alice", "POST", `/mailboxes/${state.aliceBox}/drafts`, { to: ["bob@cosmicforge.example"], subject: "Outbound scan", text: "x" })).body.data;
        const uploaded = await down.services.compose.addAttachment(alice, draft.id, { buffer: Buffer.from("plain"), originalname: "notes.txt", mimetype: "text/plain" });
        assert.equal(uploaded.scanStatus, "SCANNER_UNAVAILABLE");
        const send = await call("alice", "POST", `/drafts/${draft.id}/send`, { revision: (await call("alice", "GET", `/drafts/${draft.id}`)).body.data.revision });
        assert.equal(send.status, 422);
        assert.equal(send.body.code, "MAIL_ATTACHMENT_NOT_CLEAN");
        const eicarUpload = await live.services.compose.addAttachment(alice, draft.id, { buffer: Buffer.from(EICAR), originalname: "x.txt", mimetype: "text/plain" });
        assert.equal(eicarUpload.scanStatus, "INFECTED");

        // Rescan: members cannot trigger it; admins can, it re-runs the scanner,
        // and INFECTED is never released.
        assert.equal((await call("alice", "POST", `/admin/attachments/${unscanned.attachment.id}/rescan`)).status, 403);
        const mailAdmin = await client.adminUser.findUnique({ where: { id: ids.mailAdmin } });
        const stillDown = await down.services.attachmentReview.rescanAttachment(mailAdmin, unscanned.attachment.id, {});
        assert.equal(stillDown.downloadable, false, "rescan during an outage stays quarantined");
        const cleared = await live.services.attachmentReview.rescanAttachment(mailAdmin, unscanned.attachment.id, {});
        // Re-audit fix 3: with migration 37 a clean rescan records the verdict
        // but never releases; release is an IT quarantine decision (step-up).
        assert.deepEqual({ scanStatus: cleared.scanStatus, downloadable: cleared.downloadable, releaseRequired: cleared.releaseRequired }, { scanStatus: "CLEAN", downloadable: false, releaseRequired: true });
        assert.equal((await call("alice", "GET", `/attachments/${unscanned.attachment.id}/download`)).status, 403, "still quarantined after a clean rescan");
        await client.adminMfaEnrollment.upsert({ where: { adminUserId: ids.mailAdmin }, create: { adminUserId: ids.mailAdmin, enrolledAt: new Date(harness.clock().getTime() - 86400000), secretEncrypted: encryptSecret(decodeBase32(TOTP_SECRET), ids.mailAdmin), updatedAt: new Date() }, update: {} });
        harness.advance(31000);
        const releaseStepUp = await call("mailAdmin", "POST", "/security/step-up", { code: totp(harness.clock), purpose: "MAIL_QUARANTINE_RELEASE" });
        assert.equal(releaseStepUp.status, 201, releaseStepUp.text);
        const released = await call("mailAdmin", "POST", `/admin/quarantine/attachments/${unscanned.attachment.id}/release`, { reason: "Clean after rescan", stepUpId: releaseStepUp.body.data.stepUpId });
        assert.equal(released.status, 200, released.text);
        const download = await call("alice", "GET", `/attachments/${unscanned.attachment.id}/download`);
        assert.equal(download.status, 200);
        assert.equal(download.text, "quarterly numbers");
        const refused = await call("mailAdmin", "POST", `/admin/attachments/${infected.attachment.id}/rescan`);
        assert.equal(refused.status, 403);
        assert.equal(refused.body.code, "MAIL_ATTACHMENT_QUARANTINED");
        assert.equal((await client.mailAttachment.findUnique({ where: { id: infected.attachment.id } })).scanStatus, "INFECTED");
        const actions = (await client.mailAuditEvent.findMany({ where: { targetId: { in: [infected.attachment.id, unscanned.attachment.id] } }, select: { action: true, metadata: true } }));
        assert.ok(actions.some((event) => event.action === "MAIL_ATTACHMENT_RESCAN_REFUSED"));
        assert.ok(actions.some((event) => event.action === "MAIL_ATTACHMENT_RESCAN_CLEAN"));
        assert.ok(actions.some((event) => event.action === "MAIL_ATTACHMENT_RESCAN_QUARANTINED"));
        // Scanner health/metrics are reported to mail admins.
        const health = await live.health();
        assert.equal(health.scanner.ok, true);
        assert.match(health.scanner.version, /^ClamAV/);
        assert.ok(health.scanner.metrics.infected >= 2);
        assert.equal((await down.health()).scanner.ok, false);
      } finally {
        await clamd.close();
      }
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
      // D4: the upload is a dry-run preview; a different brand approver
      // commits the same file by its sha256.
      const dryRun = await call("dave", "POST", `${base}/contacts/import`, csv);
      assert.equal(dryRun.status, 200, dryRun.text);
      assert.equal(dryRun.body.data.dryRun, true);
      assert.equal(dryRun.body.data.created, 1);
      csv.append("mode", "commit");
      csv.append("fileSha256", dryRun.body.data.fileSha256);
      assert.equal((await call("dave", "POST", `${base}/contacts/import`, csv)).status, 403, "the uploader cannot approve the import");
      const report = await call("erin", "POST", `${base}/contacts/import`, csv);
      assert.equal(report.status, 200, report.text);
      assert.equal(report.body.data.dryRun, false);
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
      assert.equal(preflight.body.data.checks.find((check) => check.id === "postal_address").ok, false, "M7: marketing mail needs a postal address");
      assert.equal((await call("dave", "PATCH", `${base}/settings`, { postalAddress: "x" })).status, 403, "only brand approvers change brand settings");
      const settings = await call("erin", "PATCH", `${base}/settings`, { postalAddress: "CosmicForge Ltd, 1 Marina Road, Lagos" });
      assert.equal(settings.status, 200, settings.text);
      preflight = await call("dave", "POST", `${base}/campaigns/${campaign.body.data.id}/preflight`);
      assert.equal(preflight.body.data.ok, true, JSON.stringify(preflight.body.data.checks));
      assert.equal(preflight.body.data.eligibleCount, 2);
      for (const id of ["links_safe", "brand_provider_allowed"]) assert.equal(preflight.body.data.checks.find((check) => check.id === id)?.ok, true, id);
      // Spec §13.2 step 4: a phishing-shaped link fails preflight and blocks submission.
      const phishVersion = await call("dave", "POST", `${base}/templates/${template.body.data.id}/versions`, { subject: "Verify", blocks: [{ type: "button", label: "Verify account", url: "https://bit.ly/verify-now" }] });
      const phish = await call("dave", "POST", `${base}/campaigns`, { name: "Phish", topic: "newsletter", templateVersionId: phishVersion.body.data.id, audienceId: state.audienceId, senderAddressId: state.addr.news.id, replyTo: "support@cosmicforge.example" });
      const phishPreflight = await call("dave", "POST", `${base}/campaigns/${phish.body.data.id}/preflight`);
      assert.equal(phishPreflight.body.data.ok, false);
      assert.equal(phishPreflight.body.data.checks.find((check) => check.id === "links_safe").ok, false);
      assert.equal((await call("dave", "POST", `${base}/campaigns/${phish.body.data.id}/submit`, { revision: 1 })).body.code, "MAIL_PREFLIGHT_FAILED");
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
      assert.equal(await client.mailOutboxJob.count({ where: { kind: { notIn: ["SEND_MESSAGE", "PROCESS_INBOUND", "PROCESS_DELIVERY_EVENT", "OPS_EVALUATE"] } } }), 0, "no marketing dispatch jobs exist in M6 (periodic M9 ops evaluation aside)");
      await assert.rejects(harness.adapter.sendBroadcast({}), (error) => error.code === "BROADCAST_NOT_ENABLED");
    });

    await t.test("Key rotation: dry run changes nothing; apply rewraps every envelope (resumable, audited); old key can then be retired", async () => {
      const { rotateMailEncryption, COLUMNS, OBJECT_SOURCES } = require("../src/modules/mail/security/key-rotation");
      const { createEncryptedStore } = require("../src/modules/mail/storage/mail-storage");
      const { createMailEncryption, parseKeyring } = require("../src/modules/mail/security/mail-encryption.service");
      const v1 = parseKeyring(baseEnvKeys(), "v1").keys.get("v1").toString("base64");
      const v2 = crypto.randomBytes(32).toString("base64");
      const rotating = createMailEncryption({ keys: `v1:${v1},v2:${v2}`, activeKey: "v2" });
      const store = createEncryptedStore({ encryption: rotating, backend: harness.backend });
      const run = (options) => rotateMailEncryption({ client, storage: store, encryption: rotating, audit: harness.mail.audit, operator: ids.mailAdmin, logger: { info() {} }, ...options });
      const envelopes = async () => {
        const found = [];
        for (const source of COLUMNS) {
          for (const row of await client.$queryRawUnsafe(`SELECT "${source.column}" AS value FROM "${source.table}" WHERE "${source.column}" IS NOT NULL`)) found.push({ ...source, envelope: Buffer.from(row.value) });
        }
        return found;
      };
      const objectKeys = async () => {
        const keys = new Set();
        for (const source of OBJECT_SOURCES) for (const row of await client.$queryRawUnsafe(`SELECT DISTINCT "${source.column}" AS key FROM "${source.table}" WHERE "${source.column}" IS NOT NULL`)) keys.add(`${source.purpose}|${row.key}`);
        return [...keys];
      };
      const before = await envelopes();
      assert.ok(before.length > 10 && before.every((entry) => rotating.envelopeKeyVersion(entry.envelope) === "v1"));
      assert.ok(new Set(before.map((entry) => entry.purpose)).size === 3, "drafts, snippets and notes are all covered");

      const dry = await run({ dryRun: true });
      assert.ok(dry.remaining > 0);
      assert.deepEqual((await envelopes()).map((entry) => entry.envelope.toString("base64")), before.map((entry) => entry.envelope.toString("base64")), "dry run writes nothing");

      const partial = await run({ dryRun: false, limit: 5, batchSize: 3 });
      assert.equal(partial.stoppedAtLimit, true);
      assert.ok(partial.remaining > 0);
      const finished = await run({ dryRun: false, batchSize: 7 });
      assert.equal(finished.failed, 0);
      assert.equal(finished.remaining, 0, "resumed run completes");
      const again = await run({ dryRun: false });
      assert.equal(Object.values({ ...again.columns, ...again.objects }).reduce((sum, counts) => sum + counts.rotated, 0), 0, "idempotent");

      // Everything now decrypts with v2 alone, and no longer with v1 alone.
      const v2Only = createMailEncryption({ keys: `v2:${v2}`, activeKey: "v2" });
      const v1Only = createMailEncryption({ keys: `v1:${v1}`, activeKey: "v1" });
      for (const entry of await envelopes()) {
        assert.doesNotThrow(() => v2Only.decrypt(entry.envelope, entry.purpose), `${entry.table}.${entry.column}`);
        assert.throws(() => v1Only.decrypt(entry.envelope, entry.purpose));
      }
      const v2Store = createEncryptedStore({ encryption: v2Only, backend: harness.backend });
      const keys = await objectKeys();
      assert.ok(keys.length > 3);
      for (const entry of keys) {
        const [purpose, key] = entry.split("|");
        assert.equal(await v2Store.keyVersionOf(key), "v2");
        await assert.doesNotReject(v2Store.get(key, { purpose }));
      }
      const audits = await client.mailAuditEvent.findMany({ where: { targetType: "keyring" }, orderBy: { createdAt: "asc" } });
      assert.ok(audits.some((event) => event.action === "MAIL_KEY_ROTATION_DRY_RUN_COMPLETED"));
      assert.ok(audits.filter((event) => event.action === "MAIL_KEY_ROTATION_COMPLETED").length >= 3);
      assert.ok(audits.every((event) => event.actorAdminUserId === ids.mailAdmin));
      for (const event of audits) assert.ok(!JSON.stringify(event.metadata).includes(v2) && !JSON.stringify(event.metadata).includes(v1), "audit never contains keys");
      // The original (v1-only) app instance can no longer read rotated content.
      harness.mail.encryption.load({ keys: new Map([["v1", Buffer.from(v1, "base64")], ["v2", Buffer.from(v2, "base64")]]), active: "v2" });
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
    if (fakeS3) {
      assert.ok(fakeS3.requests.length > 0, "S3 backend was exercised");
      assert.ok(fakeS3.requests.every((request) => request.signature.ok), "every S3 request was SigV4-signed");
      await fakeS3.close();
    }
    await client.$disconnect();
    await dropDatabase(BASE_DATABASE_URL, replay.databaseName);
  }
});
