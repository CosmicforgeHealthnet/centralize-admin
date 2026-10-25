"use strict";

// Spec §22 (Critical): "Staging deployment without migration -> fail readiness
// gracefully". Mail is switched ON against a real, empty PostgreSQL database
// (no Mail tables at all): every Mail route answers 503 MAIL_SCHEMA_NOT_READY
// (never a Prisma 500), webhooks are not acknowledged, the worker idles and the
// liveness probe stays up. No external network calls are made.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const { PrismaClient } = require("../src/generated/admin-client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { createMailApplication } = require("../src/modules/mail/application");
const { createMailRouter } = require("../src/modules/mail/http/mail.routes");
const { loadMailConfig } = require("../src/modules/mail/mail.config");
const { createFakeAdapter } = require("../src/modules/mail/adapters/fake.adapter");
const { memoryBackend } = require("../src/modules/mail/storage/mail-storage");
const { signatureScanner } = require("../src/modules/mail/scanning/attachment-scanner");
const { errorHandler } = require("../src/shared/middlewares/error.middleware");
const { closeServer } = require("./helpers/server-close");

const BASE_DATABASE_URL = process.env.DATABASE_URL;

test("Mail enabled before its migrations are applied fails readiness gracefully", { timeout: 120000 }, async (t) => {
  assert.ok(BASE_DATABASE_URL, "DATABASE_URL is required");
  const name = `mail_schema_missing_${crypto.randomBytes(4).toString("hex")}`;
  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: BASE_DATABASE_URL }) });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(BASE_DATABASE_URL);
  url.pathname = `/${name}`;
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const warnings = [];
  const mail = createMailApplication({
    client,
    config: loadMailConfig({
      MAIL_ENABLED: "true", MAIL_SENDING_ENABLED: "true", MAIL_RECEIVING_ENABLED: "true", MAIL_MARKETING_ENABLED: "true", MAIL_WORKER_ENABLED: "true",
      MAIL_PROVIDER: "fake", RESEND_WEBHOOK_SECRET: `whsec_${crypto.randomBytes(24).toString("base64")}`,
      MAIL_ENCRYPTION_KEYS: `v1:${crypto.randomBytes(32).toString("base64")}`, MAIL_DOMAIN_ALLOWLIST: "cosmicforge.example",
    }),
    adapter: createFakeAdapter(),
    storageBackend: memoryBackend(),
    scanner: signatureScanner(),
    logger: { info() {}, warn: (message) => warnings.push(message), error() {} },
  });
  const app = express();
  app.post("/api/mail/v1/webhooks/resend", express.raw({ type: "*/*" }), (req, res, next) => { req.rawBody = req.body; next(); }, mail.webhookHandler);
  app.use(express.json());
  // Authentication passes without touching the (absent) Mail tables.
  const authenticate = (req, res, next) => { req.adminUser = { id: "u1", tier: "ADMIN", status: "ACTIVE", name: "Ops" }; req.authSession = { id: null }; next(); };
  app.use("/api/mail/v1", createMailRouter({ mail, authenticate, rateLimitMax: 10000 }));
  app.use(errorHandler);
  const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}/api/mail/v1`;
  t.after(async () => {
    await closeServer(server);
    await client.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
  });

  const live = await fetch(`${base}/health/live`);
  assert.equal(live.status, 200, "liveness never depends on the schema");
  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 503);
  const readyBody = await ready.json();
  assert.equal(readyBody.data?.checks?.schema ?? readyBody.checks?.schema, false);
  assert.equal(/\.sql|mail_/.test(JSON.stringify(readyBody)), false, "public readiness exposes no migration or table names");

  for (const [method, path] of [["GET", "/me/entitlements"], ["GET", "/me/mailboxes"], ["GET", "/admin/status"], ["GET", "/admin/organizations"], ["POST", "/marketing/contacts"]]) {
    const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    const body = await response.json();
    assert.equal(response.status, 503, `${method} ${path}`);
    assert.equal(body.code ?? body.errors?.[0]?.code ?? body.error?.code, "MAIL_SCHEMA_NOT_READY", `${method} ${path}: ${JSON.stringify(body)}`);
  }

  const webhook = await fetch(`${base}/webhooks/resend`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(webhook.status, 503, "the provider retries later instead of losing the event");
  assert.equal((await webhook.json()).code, "MAIL_SCHEMA_NOT_READY");

  assert.equal(await mail.createWorker().tick(), 0, "workers idle");
  assert.equal(warnings.filter((message) => message.includes("Mail schema not present")).length, 1, "operators get one clear log line");
});
