"use strict";

// Per-user Mail preferences (spec 15 "Profiles", migration 36) on real
// PostgreSQL (replayed migrations 1-36, offline fake provider): defaults,
// preferred sender validated against the caller's live sender identities,
// compose pre-selection, audit, and the notification preference (suppresses
// new-mail notices only; failure notices are always sent).

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");

test("Mail preferences on real PostgreSQL", { timeout: 240000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client);
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const { server, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  t.after(async () => {
    await closeServer(server);
    await db.close();
  });
  const mailboxFor = async (key, localPart) => {
    const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids[key], address: { domainId: cf.domain.id, localPart } });
    assert.equal(box.status, 201, box.text);
    return box.body.data.id;
  };
  let counter = 0;
  const receive = async (toAddress) => {
    counter += 1;
    const id = `in_pref_${counter}_${crypto.randomUUID().slice(0, 8)}`;
    harness.adapter.addInbound(id, { from: { address: "partner@partner.example", name: "Partner" }, to: [{ address: toAddress, name: null }], cc: [], envelopeRecipients: [], subject: `Hello ${counter}`, html: null, text: "hello", rfcMessageId: `<${id}@partner.example>`, inReplyTo: null, references: [], receivedAt: harness.clock() });
    const result = await harness.mail.processors.inbound.process({ id: crypto.randomUUID(), payload: { providerEmailId: id, to: [toAddress] }, webhookEventId: null });
    assert.equal(result.delivered, 1);
  };
  const newMailNotices = (key) => client.notification.count({ where: { adminUserId: ids[key], title: { startsWith: "New email in" } } });
  const state = {};

  await t.test("setup: personal mailboxes and a shared mailbox dave may send from", async () => {
    state.daveBox = await mailboxFor("dave", "dave");
    state.erinBox = await mailboxFor("erin", "erin");
    state.daveAddress = await client.mailAddress.findUnique({ where: { address: "dave@cosmicforge.example" } });
    state.erinAddress = await client.mailAddress.findUnique({ where: { address: "erin@cosmicforge.example" } });
    state.membership = await client.mailMembership.create({ data: { mailboxId: cf.mailbox.id, adminUserId: ids.dave, role: "MEMBER", canSend: true, grantedBy: ids.ops } });
  });

  await t.test("defaults: notifications on, no preferred sender, every current identity offered", async () => {
    const response = await call("dave", "GET", "/me/preferences");
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const data = response.body.data;
    assert.equal(data.available, true);
    assert.equal(data.notificationsEnabled, true);
    assert.equal(data.defaultSenderAddressId, null);
    assert.deepEqual(data.senderOptions.map((option) => option.address).sort(), ["dave@cosmicforge.example", "news@cosmicforge.example"]);
    assert.equal(data.senderOptions.find((option) => option.address === "news@cosmicforge.example").mailboxId, cf.mailbox.id);
    assert.equal(await client.mailUserPreference.count(), 0, "reading never writes a row");
  });

  await t.test("validation: unknown fields, wrong types and empty bodies are refused", async () => {
    for (const bad of [{}, { notificationsEnabled: "no" }, { defaultSenderAddressId: "not-a-uuid" }, { signatureHtml: "<b>x</b>" }]) {
      const response = await call("dave", "PUT", "/me/preferences", bad);
      assert.equal(response.status >= 400 && response.status < 500, true, `${JSON.stringify(bad)}: ${response.text}`);
      assert.equal(response.body.code, "MAIL_VALIDATION_FAILED");
    }
    assert.equal(await client.mailUserPreference.count(), 0);
  });

  await t.test("a sender identity the caller does not hold is refused (403)", async () => {
    for (const addressId of [state.erinAddress.id, crypto.randomUUID()]) {
      const response = await call("dave", "PUT", "/me/preferences", { defaultSenderAddressId: addressId });
      assert.equal(response.status, 403, response.text);
      assert.equal(response.body.code, "MAIL_SENDER_NOT_AUTHORIZED");
    }
    assert.equal(await client.mailUserPreference.count(), 0);
    assert.equal(await client.mailAuditEvent.count({ where: { action: "MAIL_PREFERENCES_UPDATED" } }), 0);
  });

  await t.test("a valid preferred sender is saved and audited (metadata only)", async () => {
    const response = await call("dave", "PUT", "/me/preferences", { defaultSenderAddressId: cf.sender.id });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.data.defaultSenderAddressId, cf.sender.id);
    assert.equal(response.body.data.notificationsEnabled, true);
    const row = await client.mailUserPreference.findUnique({ where: { adminUserId: ids.dave } });
    assert.equal(row.defaultSenderAddressId, cf.sender.id);
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_PREFERENCES_UPDATED", actorAdminUserId: ids.dave }, orderBy: { createdAt: "desc" } });
    assert.ok(audit, "audit row written");
    assert.equal(audit.targetType, "mail_preferences");
    assert.equal(audit.targetId, ids.dave);
    assert.deepEqual(audit.metadata.changed, ["defaultSenderAddressId"]);
    assert.equal(audit.metadata.defaultSenderAddressId, cf.sender.id);
    assert.equal(audit.metadata.previousDefaultSenderAddressId, null);
    // Other users are unaffected.
    const erin = await call("erin", "GET", "/me/preferences");
    assert.equal(erin.body.data.defaultSenderAddressId, null);
    assert.deepEqual(erin.body.data.senderOptions.map((option) => option.address), ["erin@cosmicforge.example"]);
  });

  await t.test("compose pre-selects the preferred sender only in the mailbox that owns it", async () => {
    const shared = await call("dave", "POST", `/mailboxes/${cf.mailbox.id}/drafts`, { to: ["partner@partner.example"], subject: "Shared", text: "x" });
    assert.equal(shared.status, 201, shared.text);
    assert.equal(shared.body.data.senderAddressId, cf.sender.id);
    const personal = await call("dave", "POST", `/mailboxes/${state.daveBox}/drafts`, { to: ["partner@partner.example"], subject: "Personal", text: "x" });
    assert.equal(personal.body.data.senderAddressId, state.daveAddress.id, "not an identity of this mailbox: first identity");
    const explicit = await call("dave", "POST", `/mailboxes/${cf.mailbox.id}/drafts`, { senderAddressId: cf.sender.id, subject: "Explicit", text: "x" });
    assert.equal(explicit.body.data.senderAddressId, cf.sender.id);
  });

  await t.test("a revoked identity stops applying and is no longer reported", async () => {
    await client.mailMembership.update({ where: { id: state.membership.id }, data: { revokedAt: harness.clock(), revokedBy: ids.ops } });
    const response = await call("dave", "GET", "/me/preferences");
    assert.equal(response.body.data.defaultSenderAddressId, null);
    assert.deepEqual(response.body.data.senderOptions.map((option) => option.address), ["dave@cosmicforge.example"]);
    const stale = await call("dave", "PUT", "/me/preferences", { defaultSenderAddressId: cf.sender.id });
    assert.equal(stale.status, 403);
    const cleared = await call("dave", "PUT", "/me/preferences", { defaultSenderAddressId: null });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal((await client.mailUserPreference.findUnique({ where: { adminUserId: ids.dave } })).defaultSenderAddressId, null);
  });

  await t.test("notifications off suppresses new-mail notices but never failure notices", async () => {
    await receive("dave@cosmicforge.example");
    assert.equal(await newMailNotices("dave"), 1, "on by default");

    const off = await call("dave", "PUT", "/me/preferences", { notificationsEnabled: false });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.body.data.notificationsEnabled, false);
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_PREFERENCES_UPDATED", actorAdminUserId: ids.dave }, orderBy: { createdAt: "desc" } });
    assert.deepEqual(audit.metadata.changed, ["notificationsEnabled"]);
    assert.equal(audit.metadata.notificationsEnabled, false);
    assert.equal(audit.metadata.previousNotificationsEnabled, true);

    // Inbound (external) and internal deliveries: no new-mail notice for dave.
    await receive("dave@cosmicforge.example");
    const internal = await call("erin", "POST", `/mailboxes/${state.erinBox}/drafts`, { to: ["dave@cosmicforge.example"], subject: "Internal", text: "x" });
    const internalSent = await call("erin", "POST", `/drafts/${internal.body.data.id}/send`, { revision: internal.body.data.revision });
    assert.equal(internalSent.status, 202, internalSent.text);
    assert.equal(await newMailNotices("dave"), 1, "muted: no further new-mail notices");
    // Someone who did not opt out is still notified.
    await receive("erin@cosmicforge.example");
    assert.equal(await newMailNotices("erin"), 1);

    // A failed send still notifies the sender.
    const draft = await call("dave", "POST", `/mailboxes/${state.daveBox}/drafts`, { to: ["reject@partner.example"], subject: "Permanent", text: "x" });
    harness.adapter.failNext("sendMessage", "PERMANENT", "RESEND_HTTP_422");
    const sent = await call("dave", "POST", `/drafts/${draft.body.data.id}/send`, { revision: draft.body.data.revision });
    assert.equal(sent.status, 202, sent.text);
    await harness.mail.createWorker({ queues: ["OUTBOUND"] }).drain({ maxTicks: 10 });
    assert.equal((await client.mailMessage.findUnique({ where: { id: sent.body.data.messageId } })).status, "FAILED");
    assert.equal(await client.notification.count({ where: { adminUserId: ids.dave, title: "Email could not be sent" } }), 1, "failure notices are never suppressed");

    // Turning it back on restores new-mail notices.
    const on = await call("dave", "PUT", "/me/preferences", { notificationsEnabled: true });
    assert.equal(on.body.data.notificationsEnabled, true);
    await receive("dave@cosmicforge.example");
    assert.equal(await newMailNotices("dave"), 2);
  });
});
