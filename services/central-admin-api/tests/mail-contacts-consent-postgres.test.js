"use strict";

// Contacts & Consent on real PostgreSQL through the real router, including
// bypass attempts with direct HTTP requests (no UI involved):
// - contact creation is separate from marketing permission; origin is MANUAL;
// - the browser cannot claim WEB_FORM / API / EVENT / IMPORT provenance;
// - previously documented consent is never granted on staff assertion: it is an
//   approval request a different brand approver must accept (single use, TTL,
//   brand isolation, re-checked against withdrawals);
// - topics and policy versions must be configured (or already in use);
// - imports offer only WEB_FORM / EVENT / OTHER and store source IMPORT;
// - existing (historical) consent rows are never rewritten.

const test = require("node:test");
const assert = require("node:assert/strict");
const { openDatabase, seed, createHarness, listen, caller } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");
const { requestConfirmation, documented, confirmContact } = require("./helpers/marketing-consent");

test("Contacts & Consent: separate permission, server-set provenance, independent approval", { timeout: 300000 }, async (t) => {
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client);
  const { ids, brands } = await seed(client, { clock: harness.clock });
  const { server, base } = await listen(harness.mountApp(harness.mail));
  const json = caller(base, ids);
  // Multipart bodies (CSV import) go through untouched; everything else is JSON.
  const call = async (userKey, method, path, body, headers = {}) => {
    if (!(body instanceof FormData)) return json(userKey, method, path, body, headers);
    const response = await fetch(`${base}${path}`, { method, headers: { ...(userKey ? { "x-test-user": ids[userKey] } : {}), ...headers }, body });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: response.status, body: parsed, text };
  };
  const reasonOf = (response) => response.body?.errors?.[0]?.reason;
  const cf = brands.cosmicforge.organization.id;
  const ka = brands.karryam.organization.id;
  const mbase = `/marketing/${cf}`;
  const consentOf = (contactId, topic = "newsletter") => client.marketingConsent.findUnique({ where: { contactId_topic: { contactId, topic } } });
  const eligibleCount = async (contactIds) => {
    const audience = await call("dave", "POST", `${mbase}/audiences`, { name: `aud-${Math.random().toString(36).slice(2, 8)}`, topic: "newsletter" });
    await call("dave", "POST", `${mbase}/audiences/${audience.body.data.id}/contacts`, { contactIds });
    return (await call("dave", "GET", `${mbase}/audiences/${audience.body.data.id}`)).body.data.eligibleCount;
  };
  t.after(async () => {
    await closeServer(server);
    await db.close();
  });

  await t.test("consent options come from configuration plus brand history", async () => {
    const options = await call("dave", "GET", `${mbase}/consent-options`);
    assert.equal(options.status, 200, options.text);
    assert.ok(options.body.data.topics.includes("newsletter"));
    assert.equal(options.body.data.currentPolicyVersion, "2026-10");
    assert.deepEqual(options.body.data.importOriginalChannels, ["WEB_FORM", "EVENT", "OTHER"]);
    assert.equal((await call("kim", "GET", `${mbase}/consent-options`)).status, 404, "another brand's options are not visible");
  });

  await t.test("a contact can be saved without marketing permission; origin is MANUAL", async () => {
    const saved = await call("dave", "POST", `${mbase}/contacts`, { email: "save-only@reader.example" });
    assert.equal(saved.status, 201, saved.text);
    assert.equal(saved.body.data.source, "manual");
    assert.equal(saved.body.data.marketingPermission, "NOT_REQUESTED");
    assert.deepEqual(saved.body.data.consents, []);
    assert.equal(await eligibleCount([saved.body.data.id]), 0);
  });

  await t.test("asking to confirm keeps consent pending until the contact confirms", async () => {
    const created = await call("dave", "POST", `${mbase}/contacts`, { email: "doi@reader.example", consent: requestConfirmation() });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.data.marketingPermission, "PENDING_CONFIRMATION");
    assert.deepEqual(created.body.data.confirmationEmail, { queued: false, reason: "CONFIRMATION_EMAILS_DISABLED" }, "status reports honestly that no email was sent");
    const pending = await consentOf(created.body.data.id);
    assert.equal(pending.status, "PENDING_CONFIRMATION");
    assert.equal(pending.source, "MANUAL");
    assert.equal(pending.doubleOptIn, true);
    assert.equal(await eligibleCount([created.body.data.id]), 0, "pending confirmation is not eligible");
    await confirmContact(call, created);
    const granted = await consentOf(created.body.data.id);
    assert.equal(granted.status, "GRANTED");
    assert.ok(granted.confirmedAt);
    assert.equal(await eligibleCount([created.body.data.id]), 1);
    const trigger = await client.marketingTriggerEvent.findFirst({ where: { contactId: created.body.data.id, eventType: "consent.granted" } });
    assert.notEqual(trigger.status, "IGNORED", "a contact's own confirmation is a real sign-up");
  });

  await t.test("bypass: the browser cannot claim another channel's provenance", async () => {
    for (const source of ["WEB_FORM", "API", "EVENT", "IMPORT"]) {
      const forged = await call("dave", "POST", `${mbase}/contacts`, { email: `forged-${source.toLowerCase()}@reader.example`, consent: { ...documented(), source } });
      assert.equal(forged.status, 422, `${source}: ${forged.text}`);
      assert.equal(reasonOf(forged), "CONSENT_SOURCE_SET_BY_SERVER");
      assert.equal(await client.marketingContact.count({ where: { email: `forged-${source.toLowerCase()}@reader.example` } }), 0, "nothing is created");
    }
    const contact = (await call("dave", "POST", `${mbase}/contacts`, { email: "existing@reader.example" })).body.data;
    const forged = await call("dave", "POST", `${mbase}/contacts/${contact.id}/consents`, { ...documented(), source: "API" });
    assert.equal(forged.status, 422, forged.text);
    assert.equal(await consentOf(contact.id), null);
    const explicitManual = await call("dave", "POST", `${mbase}/contacts/${contact.id}/consents`, { ...requestConfirmation(), source: "MANUAL" });
    assert.equal(explicitManual.status, 201, "MANUAL (the server's own value) stays accepted for compatibility");
  });

  await t.test("bypass: a typed evidence reference never grants consent by itself", async () => {
    // Legacy request shape that used to grant immediately: doubleOptIn false + evidence.
    const legacy = await call("dave", "POST", `${mbase}/contacts`, { email: "legacy@reader.example", consent: { topic: "newsletter", policyVersion: "2026-10", doubleOptIn: false, evidence: { reference: "signed-form-12" } } });
    assert.equal(legacy.status, 201, legacy.text);
    assert.equal(legacy.body.data.marketingPermission, "PENDING_APPROVAL");
    assert.equal(await consentOf(legacy.body.data.id), null, "no consent row before approval");
    assert.equal(await eligibleCount([legacy.body.data.id]), 0);
    const conflicting = await call("dave", "POST", `${mbase}/contacts`, { email: "conflict@reader.example", consent: { ...documented(), doubleOptIn: true } });
    assert.equal(conflicting.status, 400, "mode and legacy flag must agree");
    const noProof = await call("dave", "POST", `${mbase}/contacts`, { email: "noproof@reader.example", consent: { mode: "DOCUMENTED", topic: "newsletter", policyVersion: "2026-10" } });
    assert.equal(noProof.body.code, "MAIL_CONSENT_REQUIRED");
  });

  await t.test("documented consent is granted only by a different brand approver", async () => {
    const created = await call("dave", "POST", `${mbase}/contacts`, { email: "documented@reader.example", consent: documented("newsletter", { evidence: { reference: "paper-form-2026-117", note: "signed at the clinic" }, consentedAt: "2026-09-01T10:00:00Z" }) });
    assert.equal(created.status, 201, created.text);
    const { requestId } = created.body.data.consentApproval;
    const listed = await call("erin", "GET", `${mbase}/consent-approvals`);
    const entry = listed.body.data.find((r) => r.requestId === requestId);
    assert.equal(entry.email, "documented@reader.example");
    assert.equal(entry.evidenceReference, "paper-form-2026-117");
    assert.equal(entry.evidenceNote, "signed at the clinic");
    assert.equal(entry.requestedByMe, false);
    assert.equal((await call("dave", "GET", `${mbase}/consent-approvals`)).body.data.find((r) => r.requestId === requestId).requestedByMe, true);

    const self = await call("dave", "POST", `${mbase}/consent-approvals/${requestId}/decision`, { decision: "APPROVE" });
    assert.equal(self.status, 403, "an author without approval rights cannot approve");
    const otherBrand = await call("kim", "POST", `/marketing/${ka}/consent-approvals/${requestId}/decision`, { decision: "APPROVE" });
    assert.equal(otherBrand.status, 404, "another brand's approver cannot see the request");
    const bogus = await call("erin", "POST", `${mbase}/consent-approvals/${requestId}/decision`, { decision: "GRANT" });
    assert.equal(bogus.status, 400);

    const approved = await call("erin", "POST", `${mbase}/consent-approvals/${requestId}/decision`, { decision: "APPROVE" });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.body.data.consentStatus, "GRANTED");
    const row = await consentOf(created.body.data.id);
    assert.equal(row.status, "GRANTED");
    assert.equal(row.source, "MANUAL");
    assert.equal(row.doubleOptIn, false);
    assert.equal(row.sourceEvidence.reference, "paper-form-2026-117");
    assert.equal(row.sourceEvidence.verification.method, "INDEPENDENT_APPROVAL");
    assert.equal(row.sourceEvidence.verification.requestedBy, ids.dave);
    assert.equal(row.sourceEvidence.verification.approvedBy, ids.erin);
    assert.equal(row.consentedAt.toISOString(), "2026-09-01T10:00:00.000Z");
    const trigger = await client.marketingTriggerEvent.findFirst({ where: { contactId: created.body.data.id, eventType: "consent.granted" } });
    assert.equal(trigger.status, "IGNORED", "historical consent never enrolls welcome automations");
    assert.equal(trigger.error, "DOCUMENTED_CONSENT_NOT_A_TRIGGER");
    assert.equal(await eligibleCount([created.body.data.id]), 1);

    const again = await call("fay", "POST", `${mbase}/consent-approvals/${requestId}/decision`, { decision: "APPROVE" });
    assert.equal(again.status, 409, "single use");
    assert.equal(reasonOf(again), "CONSENT_REQUEST_ALREADY_DECIDED");
    assert.ok(!(await call("erin", "GET", `${mbase}/consent-approvals`)).body.data.some((r) => r.requestId === requestId));
    const audit = await client.mailAuditEvent.count({ where: { targetId: requestId, action: { in: ["MARKETING_CONSENT_APPROVAL_REQUESTED", "MARKETING_CONSENT_APPROVAL_DECIDED"] } } });
    assert.equal(audit, 2, "request and decision are audited");
  });

  await t.test("an approver who requested consent cannot approve their own request", async () => {
    // kim authors and approves for Karryam: the four-eyes rule still applies.
    const own = await call("kim", "POST", `/marketing/${ka}/contacts`, { email: "own@karryam.example", consent: documented() });
    assert.equal(own.status, 201, own.text);
    const decided = await call("kim", "POST", `/marketing/${ka}/consent-approvals/${own.body.data.consentApproval.requestId}/decision`, { decision: "APPROVE" });
    assert.equal(decided.status, 403);
    assert.equal(reasonOf(decided), "CONSENT_APPROVER_MUST_DIFFER_FROM_REQUESTER");
  });

  await t.test("concurrent approvals decide once", async () => {
    const created = await call("dave", "POST", `${mbase}/contacts`, { email: "race@reader.example", consent: documented() });
    const { requestId } = created.body.data.consentApproval;
    const results = await Promise.all(["erin", "fay"].map((key) => call(key, "POST", `${mbase}/consent-approvals/${requestId}/decision`, { decision: "APPROVE" })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await client.mailAuditEvent.count({ where: { targetId: requestId, action: "MARKETING_CONSENT_APPROVAL_DECIDED" } }), 1);
  });

  await t.test("rejection records nothing; expired requests cannot be approved", async () => {
    const rejected = await call("dave", "POST", `${mbase}/contacts`, { email: "rejected@reader.example", consent: documented() });
    const decision = await call("erin", "POST", `${mbase}/consent-approvals/${rejected.body.data.consentApproval.requestId}/decision`, { decision: "REJECT", note: "proof not found" });
    assert.equal(decision.status, 200, decision.text);
    assert.equal(await consentOf(rejected.body.data.id), null);
    const stale = await call("dave", "POST", `${mbase}/contacts`, { email: "stale@reader.example", consent: documented() });
    harness.advance(8 * 24 * 3600000);
    const late = await call("erin", "POST", `${mbase}/consent-approvals/${stale.body.data.consentApproval.requestId}/decision`, { decision: "APPROVE" });
    assert.equal(late.status, 409, late.text);
    assert.equal(reasonOf(late), "CONSENT_REQUEST_EXPIRED");
    assert.equal(await consentOf(stale.body.data.id), null);
  });

  await t.test("withdrawals, unsubscribes and suppression stay authoritative", async () => {
    // Withdrawn consent comes back only through the contact's own confirmation.
    const contact = await call("dave", "POST", `${mbase}/contacts`, { email: "withdrawn@reader.example", consent: requestConfirmation() });
    await confirmContact(call, contact);
    await call("dave", "POST", `${mbase}/contacts/${contact.body.data.id}/consents/newsletter/withdraw`, { source: "unsubscribe-link" });
    const documentedAfterWithdrawal = await call("dave", "POST", `${mbase}/contacts/${contact.body.data.id}/consents`, documented());
    assert.equal(documentedAfterWithdrawal.body.code, "MAIL_CONSENT_REQUIRED");
    assert.equal((await consentOf(contact.body.data.id)).status, "WITHDRAWN");

    // Withdrawn after the request was opened: approval is refused.
    const opened = await call("dave", "POST", `${mbase}/contacts`, { email: "late-withdrawal@reader.example", consent: requestConfirmation() });
    await confirmContact(call, opened);
    await call("dave", "POST", `${mbase}/contacts/${opened.body.data.id}/consents/newsletter/withdraw`, { source: "unsubscribe-link" });
    const pendingDoi = await call("dave", "POST", `${mbase}/contacts/${opened.body.data.id}/consents`, requestConfirmation());
    assert.equal(pendingDoi.status, 201, "re-confirmation by the contact is allowed after withdrawal");
    const request = await call("dave", "POST", `${mbase}/contacts/${opened.body.data.id}/consents`, documented());
    assert.equal(request.status, 201, request.text);
    await call("dave", "POST", `${mbase}/contacts/${opened.body.data.id}/consents/newsletter/withdraw`, { source: "unsubscribe-link" });
    const refused = await call("erin", "POST", `${mbase}/consent-approvals/${request.body.data.consentApproval.requestId}/decision`, { decision: "APPROVE" });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(reasonOf(refused), "CONSENT_WITHDRAWN_SINCE_REQUEST");
    assert.equal((await consentOf(opened.body.data.id)).status, "WITHDRAWN");

    // A granted consent is never silently downgraded by staff.
    const granted = await call("dave", "POST", `${mbase}/contacts`, { email: "granted@reader.example", consent: requestConfirmation() });
    await confirmContact(call, granted);
    for (const body of [requestConfirmation(), documented()]) {
      const downgrade = await call("dave", "POST", `${mbase}/contacts/${granted.body.data.id}/consents`, body);
      assert.equal(downgrade.status, 409, downgrade.text);
      assert.equal(reasonOf(downgrade), "CONSENT_ALREADY_GRANTED");
    }
    assert.equal((await consentOf(granted.body.data.id)).status, "GRANTED");

    // Suppression still excludes an approved contact.
    const suppressedRequest = await call("dave", "POST", `${mbase}/contacts`, { email: "suppressed@reader.example", consent: documented() });
    await call("erin", "POST", `${mbase}/consent-approvals/${suppressedRequest.body.data.consentApproval.requestId}/decision`, { decision: "APPROVE" });
    await call("dave", "POST", `${mbase}/suppressions`, { email: "suppressed@reader.example", reason: "MANUAL" });
    assert.equal(await eligibleCount([suppressedRequest.body.data.id]), 0);
  });

  await t.test("bypass: topics and policy versions must be configured choices", async () => {
    for (const body of [{ ...requestConfirmation(), topic: "made-up-topic" }, { ...requestConfirmation(), policyVersion: "9999" }]) {
      const refused = await call("dave", "POST", `${mbase}/contacts`, { email: `choice-${body.topic}-${body.policyVersion}@reader.example`, consent: body });
      assert.equal(refused.status, 422, refused.text);
    }
    const unconfigured = harness.build({ MAIL_MARKETING_CONSENT_POLICY_VERSIONS: "" });
    const other = await listen(harness.mountApp(unconfigured));
    try {
      const callOther = caller(other.base, ids);
      // History keeps already-used versions valid; a never-used one is refused.
      const historical = await callOther("dave", "POST", `${mbase}/contacts`, { email: "historic-version@reader.example", consent: requestConfirmation() });
      assert.equal(historical.status, 201, historical.text);
      const unknown = await callOther("dave", "POST", `${mbase}/contacts`, { email: "unknown-version@reader.example", consent: { ...requestConfirmation(), policyVersion: "2026-11" } });
      assert.equal(unknown.status, 422, unknown.text);
      const karryam = await callOther("kim", "POST", `/marketing/${ka}/contacts`, { email: "first@karryam.example", consent: { ...requestConfirmation(), policyVersion: "2026-11" } });
      assert.equal(karryam.status, 422, "a brand with no configured or used policy version cannot record permission");
      const saveOnly = await callOther("kim", "POST", `/marketing/${ka}/contacts`, { email: "first@karryam.example" });
      assert.equal(saveOnly.status, 201, "saving the contact itself still works");
    } finally {
      await closeServer(other.server);
    }
  });

  await t.test("CSV import: only backend channels, stored as IMPORT, two-person approval kept", async () => {
    const form = (fields) => {
      const data = new FormData();
      data.append("file", new Blob(["email,first_name\nimp1@reader.example,Ivy\n"], { type: "text/csv" }), "signups.csv");
      for (const [key, value] of Object.entries({ topic: "newsletter", policyVersion: "2026-10", evidenceReference: "event-sheet-17", attestOptIn: "true", ...fields })) data.append(key, value);
      return data;
    };
    for (const fields of [{ source: "API" }, { source: "MANUAL" }, { originalChannel: "API" }, { originalChannel: "WEB_FORM", source: "EVENT" }]) {
      const refused = await call("dave", "POST", `${mbase}/contacts/import`, form(fields));
      assert.equal(refused.status, 400, `${JSON.stringify(fields)}: ${refused.text}`);
    }
    const preview = await call("dave", "POST", `${mbase}/contacts/import`, form({ originalChannel: "EVENT" }));
    assert.equal(preview.status, 200, preview.text);
    const commitFields = { originalChannel: "EVENT", mode: "commit", fileSha256: preview.body.data.fileSha256 };
    assert.equal((await call("dave", "POST", `${mbase}/contacts/import`, form(commitFields))).status, 403, "the uploader cannot approve");
    const committed = await call("erin", "POST", `${mbase}/contacts/import`, form(commitFields));
    assert.equal(committed.status, 200, committed.text);
    const contact = await client.marketingContact.findUnique({ where: { organizationId_email: { organizationId: cf, email: "imp1@reader.example" } } });
    const row = await consentOf(contact.id);
    assert.equal(contact.source, "import");
    assert.equal(row.source, "IMPORT", "consent is recorded as received through the import channel");
    assert.equal(row.sourceEvidence.originalChannel, "EVENT");
    assert.equal(row.sourceEvidence.importApprovedBy, ids.erin);
    // Legacy clients sending source=WEB_FORM keep working and map onto the channel.
    const legacy = await call("dave", "POST", `${mbase}/contacts/import`, form({ source: "WEB_FORM" }));
    assert.equal(legacy.status, 200, legacy.text);
  });

  await t.test("historical consent records are never rewritten", async () => {
    const contact = await client.marketingContact.create({ data: { organizationId: cf, email: "historic@reader.example", source: "web_form", createdBy: ids.dave } });
    const historic = await client.marketingConsent.create({ data: { contactId: contact.id, organizationId: cf, topic: "newsletter", status: "GRANTED", source: "WEB_FORM", sourceEvidence: { reference: "legacy-form-1" }, policyVersion: "legacy-1", doubleOptIn: false, consentedAt: new Date("2026-01-01T00:00:00Z") } });
    const listed = await call("dave", "GET", `${mbase}/contacts`, undefined);
    assert.equal(listed.status, 200);
    const shown = listed.body.data.find((c) => c.id === contact.id);
    assert.equal(shown.consents[0].source, "WEB_FORM");
    assert.equal(shown.consents[0].status, "GRANTED");
    assert.ok((await call("dave", "GET", `${mbase}/consent-options`)).body.data.policyVersions.includes("legacy-1"), "versions in use stay valid");
    assert.equal((await call("dave", "POST", `${mbase}/contacts/${contact.id}/consents`, requestConfirmation())).status, 409);
    const after = await consentOf(contact.id);
    assert.deepEqual({ status: after.status, source: after.source, policyVersion: after.policyVersion, evidence: after.sourceEvidence }, { status: historic.status, source: historic.source, policyVersion: historic.policyVersion, evidence: historic.sourceEvidence });
    assert.equal(after.updatedAt.getTime(), historic.updatedAt.getTime());
  });
});
