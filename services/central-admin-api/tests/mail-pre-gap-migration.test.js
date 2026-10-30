"use strict";

// Deploy safety for the gap-closure release: the new code against an Admin DB
// that has migrations 1-34 but NOT 20261101_mail_spec_gap_closure.sql (the
// state staging is in right after this push). Core Mail keeps working, the
// new features answer an honest 503 MAIL_FEATURE_NOT_READY, inbound delivery
// still succeeds (no archive/forwarding/index writes), search is
// metadata-only and rate limits fall back to the process-local window.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");

const ROLLBACK = path.join(__dirname, "..", "..", "..", "docs", "sql", "cosmicforge-mail-gap-closure-rollback.sql");

test("gap-closure code on a database without migration 35", { timeout: 180000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  await client.$executeRawUnsafe(fs.readFileSync(ROLLBACK, "utf8"));
  const warnings = [];
  const harness = createHarness(client, { env: { MAIL_BODY_SEARCH_ENABLED: "true", MAIL_SEARCH_INDEX_KEYS: `s1:${crypto.randomBytes(32).toString("base64")}`, MAIL_ARCHIVE_RAW_MIME: "true", MAIL_FORWARDING_EXTERNAL_ALLOWED_DOMAINS: "partner.example" } });
  const mail = harness.build({}, {});
  // A dedicated app with a recording logger.
  const { createMailApplication } = require("../src/modules/mail/application");
  const { loadMailConfig } = require("../src/modules/mail/mail.config");
  const recorded = createMailApplication({ client, env: harness.environment, config: loadMailConfig(harness.environment), adapter: harness.adapter, storageBackend: harness.backend, scanner: require("../src/modules/mail/scanning/attachment-scanner").signatureScanner(), logger: { info() {}, warn: (message) => warnings.push(message), error() {} }, clock: harness.clock });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const { server, base } = await listen(harness.mountApp(mail));
  const call = caller(base, ids);
  t.after(async () => {
    await closeServer(server);
    await db.close();
  });

  const ready = await call(null, "GET", "/health/ready");
  assert.equal(ready.body.data.checks.schema, true, "core Mail is ready without migration 35");
  const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids.dave, address: { domainId: cf.domain.id, localPart: "dave" } });
  assert.equal(box.status, 201, box.text);
  const mailboxId = box.body.data.id;

  // Filters use the original mail_rules table and work.
  const rule = await call("dave", "POST", `/mailboxes/${mailboxId}/rules`, { name: "Archive news", conditions: { subjectContains: "news" }, actions: { folder: "ARCHIVE" } });
  assert.equal(rule.status, 201, rule.text);

  // Inbound delivery works; archive, index, forwarding and attribution are skipped.
  harness.adapter.addInbound("pre_gap_1", { from: { address: "partner@partner.example", name: null }, to: [{ address: "dave@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [], subject: "Weekly news", html: null, text: "the bodyonlyword is here", rfcMessageId: "<pre_gap_1@partner.example>", inReplyTo: null, references: [], receivedAt: harness.clock(), originalHeaders: [{ name: "Received", value: "x" }], rawMime: "raw" });
  const result = await recorded.processors.inbound.process({ id: crypto.randomUUID(), payload: { providerEmailId: "pre_gap_1", to: ["dave@cosmicforge.example"] }, webhookEventId: null });
  assert.equal(result.delivered, 1);
  const message = await client.mailMessage.findFirst({ where: { providerMessageId: "pre_gap_1" }, include: { thread: true } });
  assert.equal(message.thread.folder, "ARCHIVE", "filters applied");

  // Search: metadata works, body search is unavailable (never an error).
  const meta = await call("dave", "GET", "/search?q=weekly");
  assert.equal(meta.status, 200, meta.text);
  assert.equal(meta.body.data.length, 1);
  const body = await call("dave", "GET", "/search?q=bodyonlyword");
  assert.equal(body.status, 200);
  assert.equal(body.body.data.length, 0);

  // New features answer an honest, retryable 503.
  for (const [method, url, payload] of [
    ["GET", `/mailboxes/${mailboxId}/forwarding`],
    ["POST", `/mailboxes/${mailboxId}/forwarding`, { targetAddress: "x@partner.example", reason: "Testing" }],
    ["GET", `/messages/${message.id}/original-headers`],
    ["GET", "/admin/forwarding"],
  ]) {
    const response = await call(method === "GET" && url === "/admin/forwarding" ? "ops" : "dave", method, url, payload);
    assert.equal(response.status, 503, `${method} ${url}: ${response.text}`);
    assert.match(response.text, /MAIL_FEATURE_NOT_READY/);
    assert.equal(response.body.retryable, true);
  }
  const searchStatus = await call("ops", "GET", "/admin/search-index");
  assert.equal(searchStatus.body.data.enabled, false);

  // Reports and ops keep working; reply metric is reported as unavailable.
  const snap = await mail.services.ops.snapshot();
  assert.equal(snap.features.gapClosureSchema, false);
  assert.equal(snap.search.enabled, false);
  const limited = await mail.rateLimiter.consume("pre-gap", { max: 1 });
  assert.equal(limited.shared, false, "process-local fallback before the table exists");
  assert.equal(limited.allowed, true);
  assert.equal((await mail.rateLimiter.consume("pre-gap", { max: 1 })).allowed, false);
  assert.ok(warnings.some((message) => message.includes("Gap-closure tables not present")), "operators get one clear log line");
  assert.equal(warnings.filter((message) => message.includes("Mail schema not present")).length, 0, "core Mail is not reported missing");
});
