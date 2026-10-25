"use strict";

// Shared harness for the Mail M7-M10 PostgreSQL suites. Builds a disposable
// database by replaying every reviewed manual migration (triggers, partial
// indexes, enum additions), seeds brands, verified domains, brand sender
// identities and staff with verified shared-MFA enrollments + live sessions,
// and serves the real Mail router behind a test authenticator. Providers are
// the offline fakes; nothing leaves 127.0.0.1.

const crypto = require("node:crypto");
const express = require("express");
const { PrismaClient } = require("../../src/generated/admin-client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { replayVerify, dropDatabase } = require("../../scripts/social-operations/db-replay-verify");
const { createMailApplication } = require("../../src/modules/mail/application");
const { createMailRouter } = require("../../src/modules/mail/http/mail.routes");
const { loadMailConfig } = require("../../src/modules/mail/mail.config");
const { createFakeAdapter } = require("../../src/modules/mail/adapters/fake.adapter");
const { createFakeMarketingAdapter } = require("../../src/modules/mail/adapters/marketing/fake-marketing.adapter");
const { memoryBackend } = require("../../src/modules/mail/storage/mail-storage");
const { signatureScanner } = require("../../src/modules/mail/scanning/attachment-scanner");
const { signResendWebhook } = require("../../src/modules/mail/webhooks/resend-webhook.verifier");
const { totpAt, decodeBase32, encryptSecret } = require("../../src/shared/auth/mfa-core");
const { errorHandler } = require("../../src/shared/middlewares/error.middleware");

const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const WEBHOOK_SECRET = `whsec_${crypto.randomBytes(24).toString("base64")}`;
const BRAND_WEBHOOK_SECRETS = { cosmicforge: `whsec_${crypto.randomBytes(24).toString("base64")}`, karryam: `whsec_${crypto.randomBytes(24).toString("base64")}` };
process.env.AUTH_MFA_ENCRYPTION_KEYS = process.env.AUTH_MFA_ENCRYPTION_KEYS || `t1:${crypto.randomBytes(32).toString("base64")}`;

function baseEnv(overrides = {}) {
  return {
    NODE_ENV: "test",
    AUTH_MFA_ENCRYPTION_KEYS: process.env.AUTH_MFA_ENCRYPTION_KEYS,
    MAIL_ENABLED: "true", MAIL_SENDING_ENABLED: "true", MAIL_RECEIVING_ENABLED: "true", MAIL_MARKETING_ENABLED: "true", MAIL_WORKER_ENABLED: "true",
    MAIL_BROADCAST_DISPATCH_ENABLED: "true", MAIL_AUTOMATION_ENABLED: "true",
    MAIL_PROVIDER: "fake", RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RESEND_WEBHOOK_SECRET__COSMICFORGE: BRAND_WEBHOOK_SECRETS.cosmicforge, RESEND_WEBHOOK_SECRET__KARRYAM: BRAND_WEBHOOK_SECRETS.karryam,
    MAIL_ENCRYPTION_KEYS: `v1:${crypto.randomBytes(32).toString("base64")}`,
    MAIL_DOMAIN_ALLOWLIST: "cosmicforge.example,karryam.example",
    MAIL_WORKER_QUEUES: "outbound,inbound,events,marketing",
    MAIL_WORKER_MAX_ATTEMPTS: "6",
    MAIL_PUBLIC_API_URL: "https://admin-api.cosmicforge.example",
    MAIL_MARKETING_UNSUBSCRIBE_SECRET: crypto.randomBytes(32).toString("hex"),
    MAIL_BROADCAST_MIN_LEAD_SECONDS: "60",
    ...overrides,
  };
}

async function openDatabase() {
  const replay = await replayVerify({ keep: true });
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: replay.replayUrl }) });
  await client.$connect();
  return {
    client,
    replay,
    async close() {
      await client.$disconnect().catch(() => {});
      await dropDatabase(replay.replayUrl).catch(() => {});
    },
  };
}

const USERS = {
  super: { tier: "SUPER" },
  mailAdmin: { tier: "ADMIN" },
  dave: { tier: "EMPLOYEE", mfa: true }, // cosmicforge author
  erin: { tier: "EMPLOYEE", mfa: true }, // cosmicforge approver
  fay: { tier: "EMPLOYEE", mfa: true }, // second cosmicforge approver
  kim: { tier: "EMPLOYEE", mfa: true }, // karryam author + approver only
  ops: { tier: "ADMIN", mfa: true }, // mail admin with MFA (M9/M10 operations)
};

async function seed(client, { clock }) {
  const ids = {};
  const sessions = new Map();
  for (const [key, spec] of Object.entries(USERS)) {
    const id = crypto.randomUUID();
    ids[key] = id;
    await client.adminUser.create({ data: { id, email: `${key}@staff.example.invalid`, password: "test-only-hash", name: key, tier: spec.tier, status: "ACTIVE", mustChangePassword: false } });
    if (spec.mfa) await client.adminMfaEnrollment.create({ data: { adminUserId: id, enrolledAt: new Date(clock().getTime() - 86400000), secretEncrypted: encryptSecret(decodeBase32(TOTP_SECRET), id), updatedAt: new Date() } });
    const session = await client.adminSession.create({ data: { id: crypto.randomUUID(), adminUserId: id, mode: "dual", authMethod: "PASSWORD", csrfNonce: "n", idleExpiresAt: new Date(clock().getTime() + 3650 * 86400000), absoluteExpiresAt: new Date(clock().getTime() + 3650 * 86400000) } });
    sessions.set(id, session.id);
  }
  const grant = (key, module, section, mode = "EDIT") => client.adminSectionGrant.create({ data: { adminUserId: ids[key], module, section, mode, grantedBy: ids.super } });
  await grant("mailAdmin", "mail", "admin");
  await grant("ops", "mail", "admin");
  await grant("dave", "mail-marketing", "cosmicforge");
  await grant("erin", "mail-marketing", "approve:cosmicforge");
  await grant("fay", "mail-marketing", "approve:cosmicforge");
  await grant("kim", "mail-marketing", "karryam");
  await grant("kim", "mail-marketing", "approve:karryam");

  const brands = {};
  for (const [slug, name, domain] of [["cosmicforge", "CosmicForge", "cosmicforge.example"], ["karryam", "Karryam Go", "karryam.example"]]) {
    const organization = await client.mailOrganization.create({ data: { slug, name, kind: "BRAND", createdBy: ids.super } });
    const domainRow = await client.mailDomain.create({ data: { organizationId: organization.id, domain, status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "VERIFIED", providerDomainId: `fake_${slug}`, verifiedAt: clock() } });
    const mailbox = await client.mailMailbox.create({ data: { organizationId: organization.id, type: "SHARED", purpose: "MARKETING", name: `${name} News` } });
    const sender = await client.mailAddress.create({ data: { organizationId: organization.id, domainId: domainRow.id, mailboxId: mailbox.id, localPart: "news", address: `news@${domain}`, displayName: `${name} News`, kind: "SHARED", status: "ACTIVE" } });
    await client.marketingBrandSettings.create({ data: { organizationId: organization.id, postalAddress: `${name} Ltd, 1 Marina Road, Lagos`, confirmationSenderId: sender.id, defaultTimeZone: "Africa/Lagos" } });
    brands[slug] = { organization, domain: domainRow, mailbox, sender };
  }
  return { ids, sessions, brands };
}

function createHarness(client, { env = {}, clockStart = Date.now() } = {}) {
  let offsetMs = 0;
  const clock = () => new Date(clockStart + offsetMs);
  const adapter = createFakeAdapter();
  const marketingAdapter = createFakeMarketingAdapter();
  const backend = memoryBackend();
  const environment = baseEnv(env);
  const build = (overrides = {}, extra = {}) => createMailApplication({
    client,
    env: { ...environment, ...overrides },
    config: loadMailConfig({ ...environment, ...overrides }),
    adapter: extra.adapter || adapter,
    marketingAdapter: extra.marketingAdapter || marketingAdapter,
    storageBackend: backend,
    encryption: extra.encryption,
    scanner: signatureScanner(),
    logger: { info() {}, warn() {}, error() {} },
    clock,
  });
  const mail = build();
  const state = { sessions: new Map() };
  const authenticate = async (req, res, next) => {
    try {
      const id = req.get("x-test-user");
      if (!id) return res.status(401).json({ success: false, message: "No token provided" });
      const user = await client.adminUser.findUnique({ where: { id }, select: { id: true, email: true, name: true, tier: true, status: true, department: true, isTeamLead: true } });
      if (!user) return res.status(401).json({ success: false });
      if (user.status === "INACTIVE" || user.status === "LOCKED") return res.status(403).json({ success: false });
      req.adminUser = user;
      const override = req.get("x-test-session");
      req.authSession = { id: override === "none" ? null : override || state.sessions.get(user.id) || null, mfaVerifiedAt: null, mfaEnrolled: false };
      return next();
    } catch (error) {
      return next(error);
    }
  };
  const mountApp = (application) => {
    const app = express();
    const raw = express.raw({ type: "*/*", limit: "256kb" });
    const keepRaw = (req, res, next) => {
      req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      req.body = {};
      next();
    };
    app.post("/api/mail/v1/webhooks/resend", raw, keepRaw, application.webhookHandler);
    app.post("/api/mail/v1/webhooks/resend/brand/:slug", raw, keepRaw, application.brandWebhookHandler);
    if (application.integrationHandler) app.post(/^\/api\/mail\/v1\/integrations\/v1\/.*/, raw, keepRaw, application.integrationHandler);
    app.use(express.json({ limit: "1mb" }));
    app.use("/api/mail/v1", createMailRouter({ mail: application, authenticate, rateLimitMax: 100000 }));
    app.use(errorHandler);
    return app;
  };
  return {
    mail, build, mountApp, adapter, marketingAdapter, backend, clock, environment, authenticate, state,
    advance: (ms) => { offsetMs += ms; },
  };
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}`, base: `http://127.0.0.1:${server.address().port}/api/mail/v1` };
}

function caller(base, ids) {
  return async function call(userKey, method, path, body, headers = {}) {
    const isForm = typeof body === "string";
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(userKey ? { "x-test-user": ids[userKey] } : {}), ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}), ...(isForm ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...headers },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      redirect: "manual",
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, body: json, text, headers: response.headers };
  };
}

function totp(clock) {
  return totpAt(decodeBase32(TOTP_SECRET), Math.floor(clock().getTime() / 30000));
}

async function postWebhook(base, clock, type, data, { id = `msg_${crypto.randomUUID()}`, secret = WEBHOOK_SECRET, path = "/webhooks/resend" } = {}) {
  const timestamp = Math.floor(clock().getTime() / 1000);
  const rawBody = Buffer.from(JSON.stringify({ type, created_at: clock().toISOString(), data }));
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": signResendWebhook({ rawBody, secret, id, timestamp }) }, body: rawBody });
  return { status: response.status, body: await response.json().catch(() => null), id };
}

module.exports = { openDatabase, seed, createHarness, listen, caller, totp, postWebhook, baseEnv, TOTP_SECRET, WEBHOOK_SECRET, BRAND_WEBHOOK_SECRETS };
