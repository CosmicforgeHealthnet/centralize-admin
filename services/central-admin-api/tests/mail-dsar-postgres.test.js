"use strict";

// GDPR DSAR access export and erasure (spec §12) on real PostgreSQL: mail
// admin + step-up gating, organization scoping, BCC privacy, dry run then
// execution, legal holds and metadata-only audit records.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");

const SUBJECT = "jane.subject@partner.example";

test("CosmicForge Mail DSAR export and erasure on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client);
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const ka = brands.karryam;
  const { server, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  const stepUp = async (purpose) => {
    harness.advance(31000);
    const response = await call("ops", "POST", "/security/step-up", { code: totp(harness.clock), purpose });
    assert.equal(response.status, 201, response.text);
    return response.body.data.stepUpId;
  };
  const exists = async (key) => harness.backend.read(key).then(() => true, () => false);
  const state = {};

  // One message per mailbox with the subject as sender, recipient or BCC.
  const makeMessage = async (mailbox, { from = SUBJECT, to = ["staff@cosmicforge.example"], bcc = [], subject = "Contract question", direction = "INBOUND" } = {}) => {
    const body = await harness.mail.store.storeBody({ html: "<p>personal details</p>", text: "personal details" });
    const thread = await client.mailThread.create({ data: { mailboxId: mailbox.id, subject, normalizedSubject: subject.toLowerCase(), lastMessageAt: harness.clock(), messageCount: 1, hasInbound: true, participants: [{ address: from }, ...to.map((address) => ({ address }))] } });
    const message = await client.mailMessage.create({ data: { mailboxId: mailbox.id, threadId: thread.id, direction, status: "RECEIVED", rfcMessageId: `<${crypto.randomUUID()}@partner.example>`, subject, fromAddress: from, fromName: "Jane", metadataSearchText: `${subject} ${from} ${to.join(" ")}`, contentObjectKey: body.key, contentSha256: body.sha256, sizeBytes: body.sizeBytes, hasAttachments: true } });
    for (const address of to) await client.mailMessageRecipient.create({ data: { messageId: message.id, type: "TO", address, status: "DELIVERED" } });
    for (const address of bcc) await client.mailMessageRecipient.create({ data: { messageId: message.id, type: "BCC", address, status: "DELIVERED" } });
    const stored = await harness.mail.store.storeAttachmentContent(Buffer.from("passport scan"));
    await client.mailAttachment.create({ data: { mailboxId: mailbox.id, messageId: message.id, filename: "passport.pdf", contentType: "application/pdf", sizeBytes: stored.sizeBytes, sha256: stored.sha256, storageKey: stored.key, scanStatus: "CLEAN", quarantined: false } });
    return { thread, message, bodyKey: body.key, attachmentKey: stored.key };
  };

  try {
    await t.test("setup: messages in two organizations and marketing rows", async () => {
      state.supportBox = await client.mailMailbox.create({ data: { organizationId: cf.organization.id, type: "SHARED", purpose: "SUPPORT", name: "CF Support" } });
      state.legalBox = await client.mailMailbox.create({ data: { organizationId: cf.organization.id, type: "SHARED", purpose: "GENERAL", name: "CF Legal" } });
      state.otherOrgBox = await client.mailMailbox.create({ data: { organizationId: ka.organization.id, type: "SHARED", purpose: "GENERAL", name: "KA Support" } });
      state.fromSubject = await makeMessage(state.supportBox);
      state.toSubject = await makeMessage(state.supportBox, { from: "agent@cosmicforge.example", to: [SUBJECT], bcc: ["other-bcc@partner.example"], direction: "OUTBOUND", subject: "Re: Contract question" });
      state.bccSubject = await makeMessage(state.supportBox, { from: "agent@cosmicforge.example", to: ["someone@else.example"], bcc: [SUBJECT], direction: "OUTBOUND", subject: "Blind copy" });
      state.held = await makeMessage(state.legalBox, { subject: "Held matter" });
      state.otherOrg = await makeMessage(state.otherOrgBox, { subject: "Other brand" });
      state.unrelated = await makeMessage(state.supportBox, { from: "someone@else.example", subject: "Unrelated" });
      const contact = await client.marketingContact.create({ data: { organizationId: cf.organization.id, email: SUBJECT, firstName: "Jane", source: "WEB_FORM" } });
      await client.marketingConsent.create({ data: { contactId: contact.id, organizationId: cf.organization.id, topic: "newsletter", status: "GRANTED", source: "WEB_FORM", sourceEvidence: { reference: "form-1" }, policyVersion: "2026-10", consentedAt: harness.clock() } });
      const kaContact = await client.marketingContact.create({ data: { organizationId: ka.organization.id, email: SUBJECT, source: "WEB_FORM" } });
      // Re-audit: provider state + re-subscription rows (migration 37), both brands.
      await client.marketingContactProviderState.create({ data: { contactId: contact.id, organizationId: cf.organization.id, provider: "fake", state: "UNSUBSCRIBED", reason: "USER_UNSUBSCRIBE", observedAt: harness.clock() } });
      await client.marketingProviderResubscription.create({ data: { organizationId: cf.organization.id, contactId: contact.id, topic: "newsletter", status: "PENDING_APPROVAL", consentEvidence: { consentId: crypto.randomUUID(), topic: "newsletter", source: "WEB_FORM", policyVersion: "2026-10", doubleOptIn: true, confirmedAt: harness.clock().toISOString() } } });
      await client.marketingContactProviderState.create({ data: { contactId: kaContact.id, organizationId: ka.organization.id, provider: "fake", state: "SUPPRESSED", reason: "HARD_BOUNCE", observedAt: harness.clock() } });
      await client.marketingProviderResubscription.create({ data: { organizationId: ka.organization.id, contactId: kaContact.id, topic: "offers", status: "REFUSED", consentEvidence: { topic: "offers" } } });
    });

    await t.test("non-admins are denied; step-up and a reason are required", async () => {
      const input = { organizationId: cf.organization.id, email: SUBJECT, reason: "DSAR ticket #4411" };
      assert.equal((await call("dave", "POST", "/admin/dsar/export", { ...input, stepUpId: crypto.randomUUID() })).status, 403);
      assert.equal((await call("dave", "POST", "/admin/dsar/erasure", { ...input, stepUpId: crypto.randomUUID() })).status, 403);
      const noStepUp = await call("ops", "POST", "/admin/dsar/export", input);
      assert.equal(noStepUp.status, 403);
      assert.equal(noStepUp.body.code, "MAIL_STEP_UP_REQUIRED");
      const wrongPurpose = await call("ops", "POST", "/admin/dsar/export", { ...input, stepUpId: await stepUp("MAIL_JOB_REQUEUE") });
      assert.equal(wrongPurpose.status, 403, "step-up is purpose-bound");
      assert.equal((await call("ops", "POST", "/admin/dsar/erasure", input)).body.code, "MAIL_STEP_UP_REQUIRED");
      const noReason = await call("ops", "POST", "/admin/dsar/export", { organizationId: cf.organization.id, email: SUBJECT, stepUpId: await stepUp("MAIL_DSAR_EXPORT") });
      assert.equal(noReason.status, 400);
      assert.equal((await call("ops", "POST", "/admin/dsar/export", { ...input, email: "not-an-address", stepUpId: await stepUp("MAIL_DSAR_EXPORT") })).status, 400);
    });

    await t.test("access export is scoped to the organization, metadata only, BCC of others hidden", async () => {
      const response = await call("ops", "POST", "/admin/dsar/export", { organizationId: cf.organization.id, email: "Jane.Subject@Partner.example", reason: "DSAR ticket #4411", stepUpId: await stepUp("MAIL_DSAR_EXPORT") });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const data = response.body.data;
      assert.equal(data.email, SUBJECT);
      const subjects = data.messages.map((row) => row.subject).sort();
      assert.deepEqual(subjects, ["Blind copy", "Contract question", "Held matter", "Re: Contract question"]);
      assert.doesNotMatch(JSON.stringify(data), /Other brand|Unrelated|personal details|passport scan/, "no other org, no unrelated mail, no bodies");
      const reply = data.messages.find((row) => row.subject === "Re: Contract question");
      assert.deepEqual(reply.bcc, [], "another person's BCC is never disclosed");
      assert.deepEqual(data.messages.find((row) => row.subject === "Blind copy").bcc.map((row) => row.address), [SUBJECT], "the subject's own BCC is theirs");
      const [attachment] = data.messages.find((row) => row.subject === "Contract question").attachments;
      assert.deepEqual(Object.keys(attachment).sort(), ["filename", "sizeBytes"]);
      assert.equal(attachment.filename, "passport.pdf");
      assert.equal(data.messages.find((row) => row.subject === "Contract question").mailbox, "CF Support");
      assert.equal(data.marketing.contacts.length, 1, "only this organization's contact");
      assert.equal(data.marketing.contacts[0].consents.length, 1);
      assert.doesNotMatch(JSON.stringify(data.marketing), /confirmationTokenHash/);
      // Re-audit: provider states and re-subscriptions of this organization only.
      assert.deepEqual(data.marketing.providerStates.map((row) => [row.state, row.reason]), [["UNSUBSCRIBED", "USER_UNSUBSCRIBE"]]);
      assert.equal(data.marketing.providerResubscriptions.length, 1);
      assert.equal(data.marketing.providerResubscriptions[0].status, "PENDING_APPROVAL");
      assert.equal(data.marketing.providerResubscriptions[0].consentEvidence.doubleOptIn, true);
      assert.doesNotMatch(JSON.stringify(data.marketing), /HARD_BOUNCE|offers/, "another brand's provider rows are never exported");
    });

    await t.test("erasure: dry run by default, then execution; legal holds and other orgs untouched", async () => {
      // Our own addresses are not external correspondents.
      const internal = await call("ops", "POST", "/admin/dsar/erasure", { organizationId: cf.organization.id, email: "someone@cosmicforge.example", reason: "DSAR ticket #4411", stepUpId: await stepUp("MAIL_DSAR_ERASURE") });
      assert.equal(internal.status, 400);
      assert.match(internal.text, /SUBJECT_IS_INTERNAL/);

      const hold = await call("ops", "POST", "/admin/legal-holds", { organizationId: cf.organization.id, mailboxId: state.legalBox.id, reason: "Litigation hold (DSAR test)" });
      assert.equal(hold.status, 201, hold.text);
      const input = { organizationId: cf.organization.id, email: SUBJECT, reason: "DSAR ticket #4411" };
      const dry = await call("ops", "POST", "/admin/dsar/erasure", { ...input, stepUpId: await stepUp("MAIL_DSAR_ERASURE") });
      assert.equal(dry.status, 200, dry.text);
      assert.equal(dry.body.data.dryRun, true);
      assert.equal(dry.body.data.candidates, 4);
      assert.equal(dry.body.data.erasable, 3);
      assert.equal(dry.body.data.erased, 0);
      assert.deepEqual(dry.body.data.skippedHeld, [{ messageId: state.held.message.id, mailboxId: state.legalBox.id }]);
      assert.ok(await exists(state.fromSubject.bodyKey), "dry run changes nothing");
      assert.equal((await client.mailMessage.findUnique({ where: { id: state.fromSubject.message.id } })).fromAddress, SUBJECT);

      const executed = await call("ops", "POST", "/admin/dsar/erasure", { ...input, dryRun: false, stepUpId: await stepUp("MAIL_DSAR_ERASURE") });
      assert.equal(executed.status, 200, executed.text);
      assert.equal(executed.body.data.dryRun, false);
      assert.equal(executed.body.data.erased, 3);
      assert.equal(executed.body.data.skippedHeld.length, 1);
      assert.equal(executed.body.data.objectsRemoved, 6, "body + attachment of each erased message");

      for (const item of [state.fromSubject, state.toSubject, state.bccSubject]) {
        const message = await client.mailMessage.findUnique({ where: { id: item.message.id }, include: { recipients: true, attachments: true } });
        assert.equal(message.contentObjectKey, null);
        assert.equal(message.subject, "");
        assert.equal(message.metadataSearchText, "");
        assert.equal(message.attachments.length, 0);
        assert.ok(!JSON.stringify(message).includes(SUBJECT), "address redacted everywhere on the message");
        assert.equal(await exists(item.bodyKey), false);
        assert.equal(await exists(item.attachmentKey), false);
        const thread = await client.mailThread.findUnique({ where: { id: item.thread.id } });
        assert.ok(!JSON.stringify(thread.participants).includes(SUBJECT));
      }
      const other = await client.mailMessage.findUnique({ where: { id: state.toSubject.message.id }, include: { recipients: true } });
      assert.ok(other.recipients.some((row) => row.address === "other-bcc@partner.example"), "other people's addresses are untouched");
      for (const item of [state.held, state.otherOrg]) {
        const message = await client.mailMessage.findUnique({ where: { id: item.message.id } });
        assert.equal(message.fromAddress, SUBJECT, "held / other-org mail untouched");
        assert.ok(await exists(item.bodyKey));
      }
      assert.ok(await exists(state.unrelated.bodyKey));

      const again = await call("ops", "POST", "/admin/dsar/erasure", { ...input, dryRun: false, stepUpId: await stepUp("MAIL_DSAR_ERASURE") });
      assert.equal(again.body.data.erased, 0, "idempotent: nothing left to erase outside the hold");
    });

    await t.test("every DSAR call is audited with metadata only", async () => {
      const rows = await client.mailAuditEvent.findMany({ where: { action: { startsWith: "MAIL_DSAR_" } }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(rows.map((row) => row.action), ["MAIL_DSAR_EXPORTED", "MAIL_DSAR_ERASURE_DRY_RUN", "MAIL_DSAR_ERASURE_EXECUTED", "MAIL_DSAR_ERASURE_EXECUTED"]);
      for (const row of rows) {
        assert.equal(row.actorAdminUserId, ids.ops);
        assert.equal(row.organizationId, cf.organization.id);
        assert.equal(row.metadata.reference, "DSAR ticket #4411");
        assert.equal(row.targetId, crypto.createHash("sha256").update(SUBJECT).digest("hex"));
      }
      assert.doesNotMatch(JSON.stringify(rows), /jane\.subject|personal details|passport|Contract question/i, "no address or content in the audit trail");
    });
  } finally {
    await closeServer(server);
    await db.close();
  }
});

// Re-audit: before migration 37 the export works unchanged and reports the
// provider rows as null (not available), never an error.
test("DSAR export before migration 37: provider states / re-subscriptions are null, export still works", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const fs = require("node:fs");
  const path = require("node:path");
  const db = await openDatabase();
  const { client } = db;
  await client.$executeRawUnsafe(fs.readFileSync(path.join(__dirname, "..", "..", "..", "docs", "sql", "cosmicforge-mail-final-gap-closure-rollback.sql"), "utf8"));
  const harness = createHarness(client);
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const { server, base } = await listen(harness.mountApp(harness.mail));
  t.after(async () => {
    await closeServer(server);
    await db.close();
  });
  const call = caller(base, ids);
  await client.marketingContact.create({ data: { organizationId: brands.cosmicforge.organization.id, email: SUBJECT, source: "WEB_FORM" } });
  harness.advance(31000);
  const stepUp = await call("ops", "POST", "/security/step-up", { code: totp(harness.clock), purpose: "MAIL_DSAR_EXPORT" });
  const response = await call("ops", "POST", "/admin/dsar/export", { organizationId: brands.cosmicforge.organization.id, email: SUBJECT, reason: "DSAR ticket pre-37", stepUpId: stepUp.body.data.stepUpId });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.data.marketing.contacts.length, 1);
  assert.equal(response.body.data.marketing.providerStates, null);
  assert.equal(response.body.data.marketing.providerResubscriptions, null);
});
