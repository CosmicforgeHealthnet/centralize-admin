"use strict";

// Deploy safety for the preferences release: the new code against an Admin
// DB that has migrations 1-35 but NOT 20261102_mail_user_preferences.sql.
// Core Mail and the gap-closure features keep working, GET /me/preferences
// answers the defaults (available=false), PUT answers an honest, retryable
// 503 MAIL_FEATURE_NOT_READY, compose falls back to the first identity and
// new-mail notifications are never suppressed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");

const ROLLBACK = path.join(__dirname, "..", "..", "..", "docs", "sql", "cosmicforge-mail-user-preferences-rollback.sql");

test("preferences code on a database without migration 36", { timeout: 180000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  await client.$executeRawUnsafe(fs.readFileSync(ROLLBACK, "utf8"));
  const harness = createHarness(client, { env: { MAIL_FORWARDING_EXTERNAL_ALLOWED_DOMAINS: "partner.example" } });
  const warnings = [];
  const { createMailApplication } = require("../src/modules/mail/application");
  const { loadMailConfig } = require("../src/modules/mail/mail.config");
  const mail = createMailApplication({ client, env: harness.environment, config: loadMailConfig(harness.environment), adapter: harness.adapter, storageBackend: harness.backend, scanner: require("../src/modules/mail/scanning/attachment-scanner").signatureScanner(), logger: { info() {}, warn: (message) => warnings.push(message), error() {} }, clock: harness.clock });
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
  assert.equal(ready.body.data.checks.schema, true, "core Mail is ready without migration 36");
  const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids.dave, address: { domainId: cf.domain.id, localPart: "dave" } });
  assert.equal(box.status, 201, box.text);
  const mailboxId = box.body.data.id;
  const daveAddress = await client.mailAddress.findUnique({ where: { address: "dave@cosmicforge.example" } });

  // Reads answer the defaults; nothing is stored or required.
  const prefs = await call("dave", "GET", "/me/preferences");
  assert.equal(prefs.status, 200, prefs.text);
  assert.equal(prefs.body.data.available, false);
  assert.equal(prefs.body.data.notificationsEnabled, true);
  assert.equal(prefs.body.data.defaultSenderAddressId, null);
  assert.deepEqual(prefs.body.data.senderOptions.map((option) => option.address), ["dave@cosmicforge.example"]);

  // Writes answer an honest, retryable 503 (never a Prisma 500).
  for (const payload of [{ notificationsEnabled: false }, { defaultSenderAddressId: daveAddress.id }]) {
    const response = await call("dave", "PUT", "/me/preferences", payload);
    assert.equal(response.status, 503, response.text);
    assert.equal(response.body.code, "MAIL_FEATURE_NOT_READY");
    assert.equal(response.body.retryable, true);
  }

  // Compose falls back to the first identity.
  const draft = await call("dave", "POST", `/mailboxes/${mailboxId}/drafts`, { to: ["partner@partner.example"], subject: "Hi", text: "x" });
  assert.equal(draft.status, 201, draft.text);
  assert.equal(draft.body.data.senderAddressId, daveAddress.id);

  // Inbound delivery still notifies (nothing is suppressed without the table).
  harness.adapter.addInbound("pre_pref_1", { from: { address: "partner@partner.example", name: null }, to: [{ address: "dave@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [], subject: "Hello", html: null, text: "hello", rfcMessageId: "<pre_pref_1@partner.example>", inReplyTo: null, references: [], receivedAt: harness.clock() });
  const result = await mail.processors.inbound.process({ id: crypto.randomUUID(), payload: { providerEmailId: "pre_pref_1", to: ["dave@cosmicforge.example"] }, webhookEventId: null });
  assert.equal(result.delivered, 1);
  assert.equal(await client.notification.count({ where: { adminUserId: ids.dave, title: { startsWith: "New email in" } } }), 1);

  // Gap-closure features (migration 35) are unaffected.
  const forwarding = await call("dave", "GET", `/mailboxes/${mailboxId}/forwarding`);
  assert.equal(forwarding.status, 200, forwarding.text);

  assert.ok(warnings.some((message) => message.includes("Preferences table not present")), "operators get one clear log line");
  assert.equal(warnings.filter((message) => message.includes("Preferences table not present")).length, 1, "logged once");
  assert.equal(warnings.filter((message) => message.includes("Mail schema not present") || message.includes("Gap-closure tables not present")).length, 0, "core Mail and migration 35 are not reported missing");
});
