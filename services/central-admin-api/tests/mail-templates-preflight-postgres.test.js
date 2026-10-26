"use strict";

// Final gaps 1 + 7 on real PostgreSQL (all migrations replayed):
// - template classification: step-up + approver + reason, audit, append-only
//   version snapshots, forced new version on reclassification;
// - classification abuse: a TRANSACTIONAL version is refused for marketing
//   campaigns at create, at approval (even with a tampered campaign row) and
//   at dispatch (even with a tampered classification row), and by automations
//   and campaign test sends;
// - TRANSACTIONAL_SECURITY content policy and distinct-approver enforcement;
// - deliverability preflight states (UNKNOWN when the provider is
//   unavailable, BLOCKED for an unverified domain) and approval binding to
//   the preflight hash;
// - template QA endpoint;
// - pre-migration-37 behaviour (classification endpoints 503, everything
//   MARKETING, core flows unchanged).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");
const { renderTemplate } = require("../src/modules/mail/marketing/template-renderer");
const { registerDeliverability } = require("../src/modules/mail/marketing/preflight");

const ROLLBACK_37 = path.join(__dirname, "..", "..", "..", "docs", "sql", "cosmicforge-mail-final-gap-closure-rollback.sql");

function helpers(harness, call, mbase) {
  const stepUp = async (key, purpose) => {
    harness.advance(31000);
    const response = await call(key, "POST", "/security/step-up", { code: totp(harness.clock), purpose });
    assert.equal(response.status, 201, response.text);
    return response.body.data.stepUpId;
  };
  const consent = () => ({ topic: "newsletter", source: "WEB_FORM", policyVersion: "2026-10", evidence: { reference: `form-${crypto.randomUUID().slice(0, 8)}` } });
  const audienceWith = async (emails) => {
    const contacts = [];
    for (const email of emails) {
      const response = await call("dave", "POST", `${mbase}/contacts`, { email, firstName: email.split("@")[0], consent: consent() });
      assert.equal(response.status, 201, response.text);
      contacts.push(response.body.data);
    }
    const audience = await call("dave", "POST", `${mbase}/audiences`, { name: `aud-${crypto.randomUUID().slice(0, 6)}`, topic: "newsletter" });
    await call("dave", "POST", `${mbase}/audiences/${audience.body.data.id}/contacts`, { contactIds: contacts.map((contact) => contact.id) });
    return audience.body.data.id;
  };
  const template = async (name, extra = {}, key = "dave") => {
    const response = await call(key, "POST", `${mbase}/templates`, { name, ...extra });
    assert.equal(response.status, 201, response.text);
    return response.body.data.id;
  };
  const version = (templateId, blocks, subject = "Hello {{first_name}}", key = "dave") => call(key, "POST", `${mbase}/templates/${templateId}/versions`, { subject, blocks });
  return { stepUp, audienceWith, template, version };
}

const SIMPLE = [{ type: "heading", text: "Your account" }, { type: "text", text: "Hello {{first_name}}, here is an update." }];

test("final gaps 1 + 7: template classification, deliverability preflight and template QA", { timeout: 600000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client, { env: { MAIL_MARKETING_TEST_SENDS_ENABLED: "true" } });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const { server, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  const cf = brands.cosmicforge;
  const kg = brands.karryam;
  const mbase = `/marketing/${cf.organization.id}`;
  const kbase = `/marketing/${kg.organization.id}`;
  const { stepUp, audienceWith, template, version } = helpers(harness, call, mbase);
  const policy = harness.mail.services.marketing.templatePolicy;
  const state = {};
  t.after(async () => {
    await closeServer(server);
    await db.close();
  });
  // The provider reports the brand domain verified, with SPF + DKIM verified.
  harness.adapter.state.domains.set("fake_cosmicforge", { status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "VERIFIED", records: [{ record: "SPF", type: "TXT", name: "send", value: "v=spf1 include:amazonses.com ~all", status: "verified" }, { record: "DKIM", type: "TXT", name: "resend._domainkey", value: "p=...", status: "verified" }] });

  await t.test("classification: MARKETING default, approver + step-up + reason, forced new version, append-only snapshots, audit", async () => {
    const templateId = await template("Account notices");
    const v1 = await version(templateId, SIMPLE);
    assert.equal(v1.status, 201, v1.text);
    assert.equal(v1.body.data.classification, "MARKETING");
    const current = await call("dave", "GET", `${mbase}/templates/${templateId}/classification`);
    assert.equal(current.status, 200, current.text);
    assert.equal(current.body.data.classification, "MARKETING");
    const list = await call("dave", "GET", `${mbase}/templates`);
    assert.equal(list.body.data.find((row) => row.id === templateId).classification, "MARKETING");

    const put = (key, body) => call(key, "PUT", `${mbase}/templates/${templateId}/classification`, body);
    const author = await put("dave", { classification: "TRANSACTIONAL", reason: "Account notices are service mail" });
    assert.equal(author.status, 403, author.text);
    assert.equal(author.body.errors[0].reason, "MARKETING_APPROVER_REQUIRED");
    const noStepUp = await put("erin", { classification: "TRANSACTIONAL", reason: "Account notices are service mail" });
    assert.equal(noStepUp.status, 403);
    assert.equal(noStepUp.body.code, "MAIL_STEP_UP_REQUIRED");
    const noReason = await put("erin", { classification: "TRANSACTIONAL", stepUpId: await stepUp("erin", "MARKETING_TEMPLATE_CLASSIFY") });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.errors[0].reason, "REASON_REQUIRED");
    const wrongPurpose = await put("erin", { classification: "TRANSACTIONAL", reason: "Account notices are service mail", stepUpId: await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL") });
    assert.equal(wrongPurpose.status, 403, "a step-up for another purpose is refused");
    const changed = await put("erin", { classification: "TRANSACTIONAL", reason: "Account notices are service mail", stepUpId: await stepUp("erin", "MARKETING_TEMPLATE_CLASSIFY") });
    assert.equal(changed.status, 200, changed.text);
    assert.equal(changed.body.data.changed, true);
    assert.equal(changed.body.data.newVersion.version, 2, "reclassification creates a new version");
    assert.equal(changed.body.data.newVersion.classification, "TRANSACTIONAL");

    const detail = (await call("dave", "GET", `${mbase}/templates/${templateId}`)).body.data;
    assert.equal(detail.classification, "TRANSACTIONAL");
    assert.equal(detail.classificationReason, "Account notices are service mail");
    assert.deepEqual(detail.versions.map((entry) => [entry.version, entry.classification]), [[2, "TRANSACTIONAL"], [1, "MARKETING"]], "v1 keeps its snapshot");
    const v2 = await client.marketingTemplateVersion.findUnique({ where: { id: changed.body.data.newVersion.id } });
    assert.doesNotMatch(v2.html, /unsubscribe/i, "transactional versions have no marketing footer");
    assert.match(v2.html, /service message/);

    // Snapshots are append-only.
    await assert.rejects(client.$executeRawUnsafe(`UPDATE marketing_template_version_policies SET classification = 'MARKETING' WHERE version_id = '${v2.id}'`));
    await assert.rejects(client.$executeRawUnsafe(`DELETE FROM marketing_template_version_policies WHERE version_id = '${v1.body.data.id}'`));
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MARKETING_TEMPLATE_CLASSIFIED", targetId: templateId } });
    assert.equal(audit.actorAdminUserId, ids.erin);
    assert.equal(audit.metadata.from, "MARKETING");
    assert.equal(audit.metadata.to, "TRANSACTIONAL");
    assert.equal(audit.metadata.reason, "Account notices are service mail");
    assert.equal(audit.metadata.stepUp, true);

    // New versions of a TRANSACTIONAL template follow its policy.
    const withUnsubscribe = await version(templateId, [...SIMPLE, { type: "text", text: "Stop: {{unsubscribe_url}}" }]);
    assert.equal(withUnsubscribe.status, 400);
    assert.equal(withUnsubscribe.body.code, "MAIL_TEMPLATE_INVALID_VARIABLE");
    const banner = await version(templateId, [...SIMPLE, { type: "image", src: "https://cdn.cosmicforge.example/sale.png", alt: "Sale", href: "https://shop.example" }]);
    assert.equal(banner.status, 400);
    assert.equal(banner.body.errors[0].details[0].reason, "PROMOTIONAL_BLOCK_NOT_ALLOWED");
    const v3 = await version(templateId, SIMPLE, "Your statement");
    assert.equal(v3.status, 201, v3.text);
    assert.equal(v3.body.data.classification, "TRANSACTIONAL");

    // Reclassifying the template does not change existing version snapshots.
    const back = await put("erin", { classification: "MARKETING", reason: "Back to newsletter use", stepUpId: await stepUp("erin", "MARKETING_TEMPLATE_CLASSIFY") });
    assert.equal(back.status, 200, back.text);
    assert.equal(await policy.versionClassification(v3.body.data.id), "TRANSACTIONAL", "an existing version never changes class");
    assert.equal(await policy.versionClassification(back.body.data.newVersion.id), "MARKETING");
    state.transactionalVersionId = v3.body.data.id;
    state.marketingVersionId = v1.body.data.id;
    state.marketingTemplateId = templateId;
  });

  await t.test("abuse: a TRANSACTIONAL version is refused at campaign create/update and by automations", async () => {
    const audienceId = await audienceWith(["t1@reader.example"]);
    const created = await call("dave", "POST", `${mbase}/campaigns`, { name: "Sneaky", topic: "newsletter", templateVersionId: state.transactionalVersionId, audienceId, senderAddressId: cf.sender.id });
    assert.equal(created.status, 422, created.text);
    assert.equal(created.body.errors[0].reason, "TEMPLATE_NOT_MARKETING");
    const ok = await call("dave", "POST", `${mbase}/campaigns`, { name: "Honest", topic: "newsletter", templateVersionId: state.marketingVersionId, audienceId, senderAddressId: cf.sender.id });
    assert.equal(ok.status, 201, ok.text);
    const patched = await call("dave", "PATCH", `${mbase}/campaigns/${ok.body.data.id}`, { revision: 1, templateVersionId: state.transactionalVersionId });
    assert.equal(patched.status, 422, patched.text);

    const automation = await call("dave", "POST", `${mbase}/automations`, { name: "Welcome via transactional", triggerType: "CONSENT_GRANTED" });
    const draft = await call("dave", "PUT", `${mbase}/automations/${automation.body.data.id}/draft`, { definition: { topic: "newsletter", steps: [{ id: "a", type: "send_email", templateVersionId: state.transactionalVersionId, senderAddressId: cf.sender.id }] }, triggerConfig: { topic: "newsletter" } });
    assert.equal(draft.status, 200, draft.text);
    const submitted = await call("dave", "POST", `${mbase}/automations/${automation.body.data.id}/versions/${draft.body.data.id}/submit`);
    assert.equal(submitted.status, 422, submitted.text);
    assert.deepEqual(submitted.body.errors[0].checks.map((entry) => entry.id), ["a:template_classification"]);
    state.honestCampaignId = ok.body.data.id;
  });

  await t.test("abuse: approval re-checks the version snapshot even when the campaign row is tampered with", async () => {
    const audienceId = await audienceWith(["t2@reader.example"]);
    const campaign = await call("dave", "POST", `${mbase}/campaigns`, { name: "Tamper approve", topic: "newsletter", templateVersionId: state.marketingVersionId, audienceId, senderAddressId: cf.sender.id });
    assert.equal(campaign.status, 201, campaign.text);
    const submitted = await call("dave", "POST", `${mbase}/campaigns/${campaign.body.data.id}/submit`, { revision: 1 });
    assert.equal(submitted.status, 200, submitted.text);
    await client.marketingEmailCampaign.update({ where: { id: campaign.body.data.id }, data: { templateVersionId: state.transactionalVersionId } });
    const approved = await call("erin", "POST", `${mbase}/campaigns/${campaign.body.data.id}/approve`, { revision: 1, stepUpId: await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL") });
    assert.equal(approved.status, 422, approved.text);
    assert.equal(approved.body.code, "MAIL_PREFLIGHT_FAILED");
    assert.ok(approved.body.errors[0].checks.some((entry) => entry.id === "template_classification" && entry.status === "BLOCKED"));

    // Test sends (campaign path) refuse it too, at request time.
    const dave = await client.adminUser.findUnique({ where: { id: ids.dave } });
    await assert.rejects(harness.mail.services.testSends.requestTestSend(dave, cf.organization.id, campaign.body.data.id, {}, { sessionId: harness.state.sessions.get(ids.dave) }), (error) => error.errors?.[0]?.reason === "TEMPLATE_NOT_MARKETING");
  });

  await t.test("abuse: dispatch re-checks the version snapshot even after an inserted classification row", async () => {
    // A version created without a snapshot (as before migration 37) is MARKETING...
    const templateId = await template("Legacy newsletter");
    const rendered = renderTemplate({ subject: "Autumn news", blocks: SIMPLE, brand: { name: "CosmicForge" } });
    await client.marketingEmailTemplate.update({ where: { id: templateId }, data: { latestVersion: 1 } });
    const legacy = await client.marketingTemplateVersion.create({ data: { templateId, version: 1, subject: rendered.subject, preheader: null, blocks: SIMPLE, brand: rendered.brand, html: rendered.html, text: rendered.text, variables: rendered.variables, contentSha256: rendered.contentSha256, createdBy: ids.dave } });
    assert.equal(await policy.versionClassification(legacy.id), "MARKETING");
    const audienceId = await audienceWith(["d1@reader.example", "d2@reader.example"]);
    const campaign = await call("dave", "POST", `${mbase}/campaigns`, { name: "Dispatch tamper", topic: "newsletter", templateVersionId: legacy.id, audienceId, senderAddressId: cf.sender.id, frequencyCapHours: 0 });
    assert.equal(campaign.status, 201, campaign.text);
    assert.equal((await call("dave", "POST", `${mbase}/campaigns/${campaign.body.data.id}/submit`, { revision: 1 })).status, 200);
    const approved = await call("erin", "POST", `${mbase}/campaigns/${campaign.body.data.id}/approve`, { revision: 1, stepUpId: await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL") });
    assert.equal(approved.status, 200, approved.text);
    const scheduled = await call("dave", "POST", `${mbase}/campaigns/${campaign.body.data.id}/schedule`, { revision: 1, sendAtUtc: new Date(harness.clock().getTime() + 120000).toISOString() });
    assert.equal(scheduled.status, 201, scheduled.text);
    // ...then someone with database access inserts a TRANSACTIONAL snapshot for it.
    await client.$executeRawUnsafe(`INSERT INTO marketing_template_version_policies (version_id, classification) VALUES ('${legacy.id}', 'TRANSACTIONAL')`);
    const worker = harness.mail.createWorker({ queues: ["MARKETING"] });
    harness.advance(300000);
    for (let index = 0; index < 5; index += 1) {
      harness.advance(2000);
      await worker.drain({ maxTicks: 20 });
    }
    const dispatch = await client.marketingBroadcastDispatch.findUnique({ where: { campaignId: campaign.body.data.id } });
    assert.equal(dispatch.status, "FAILED", JSON.stringify(dispatch));
    assert.equal(dispatch.lastErrorCode, "TEMPLATE_NOT_MARKETING");
    assert.equal(harness.marketingAdapter.state.broadcasts.size, 0, "nothing reached the provider");
  });

  await t.test("TRANSACTIONAL_SECURITY: creation needs approver + step-up, strict content policy, distinct approver enforced", async () => {
    const create = (key, body) => call(key, "POST", `${mbase}/templates`, { name: `Security ${crypto.randomUUID().slice(0, 6)}`, classification: "TRANSACTIONAL_SECURITY", reason: "Password reset notices", ...body });
    assert.equal((await create("dave", {})).status, 403, "authors without approve scope cannot create security templates");
    assert.equal((await create("erin", {})).status, 403, "no step-up");
    // erin is approver-only for cosmicforge (no EDIT scope): use kim on karryam for author+approver.
    const kimCreate = await call("kim", "POST", `${kbase}/templates`, { name: "Reset", classification: "TRANSACTIONAL_SECURITY", reason: "Password reset notices", stepUpId: await stepUp("kim", "MARKETING_TEMPLATE_CLASSIFY") });
    assert.equal(kimCreate.status, 201, kimCreate.text);
    assert.equal(kimCreate.body.data.classification, "TRANSACTIONAL_SECURITY");
    const kimTemplateId = kimCreate.body.data.id;
    const kver = (blocks, subject = "Reset your password") => call("kim", "POST", `${kbase}/templates/${kimTemplateId}/versions`, { subject, blocks });
    const reason = (response) => response.body?.errors?.[0]?.details?.[0]?.reason;
    assert.equal(reason(await kver([{ type: "image", src: "https://cdn.karryam.example/a.png", alt: "a" }])), "REMOTE_IMAGE_NOT_ALLOWED");
    assert.equal(reason(await kver([{ type: "button", label: "Reset", url: "https://evil.example/reset" }])), "EXTERNAL_LINK_NOT_ALLOWED");
    assert.equal(reason(await kver([{ type: "text", text: "Reset now and get 20% off" }])), "PROMOTIONAL_COPY_NOT_ALLOWED");
    const good = await kver([{ type: "heading", text: "Password reset" }, { type: "button", label: "Reset password", url: "https://auth.karryam.example/reset" }]);
    assert.equal(good.status, 201, good.text);
    const versionId = good.body.data.id;
    const row = await client.marketingTemplateVersion.findUnique({ where: { id: versionId } });
    // Not usable anywhere (except preview) until a second person approves it.
    assert.equal(await policy.usabilityProblem(versionId, { purpose: "TRANSACTIONAL_SECURITY" }), "TEMPLATE_VERSION_NOT_APPROVED");
    assert.equal(await policy.usabilityProblem(versionId, { purpose: "PREVIEW" }), null);
    // The author cannot approve their own version.
    const self = await call("kim", "POST", `${kbase}/templates/${kimTemplateId}/versions/${versionId}/approve`, { stepUpId: await stepUp("kim", "MARKETING_TEMPLATE_APPROVE") });
    assert.equal(self.status, 403, self.text);
    assert.equal(self.body.errors[0].reason, "REVIEWER_AUTHORED_TEMPLATE_VERSION");
    // A forged approval row by the author is ignored.
    await client.mailAuditEvent.create({ data: { actorAdminUserId: ids.kim, action: "MARKETING_TEMPLATE_VERSION_APPROVED", targetType: "marketing_template_version", targetId: versionId, organizationId: kg.organization.id, outcome: "SUCCESS", metadata: { versionSha256: row.contentSha256 } } });
    assert.equal((await policy.versionApproval(row)).approved, false);
    // A second approver for karryam (fay gets the grant here) approves with step-up.
    await client.adminSectionGrant.create({ data: { adminUserId: ids.fay, module: "mail-marketing", section: "approve:karryam", mode: "EDIT", grantedBy: ids.super } });
    const noMfa = await call("fay", "POST", `${kbase}/templates/${kimTemplateId}/versions/${versionId}/approve`, {});
    assert.equal(noMfa.status, 403);
    const approved = await call("fay", "POST", `${kbase}/templates/${kimTemplateId}/versions/${versionId}/approve`, { stepUpId: await stepUp("fay", "MARKETING_TEMPLATE_APPROVE"), comment: "Checked" });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.body.data.approved, true);
    assert.equal(approved.body.data.approvedBy, ids.fay);
    assert.equal(await policy.usabilityProblem(versionId, { purpose: "TRANSACTIONAL_SECURITY" }), null);
    assert.equal(await policy.usabilityProblem(versionId, { purpose: "MARKETING" }), "TEMPLATE_NOT_MARKETING", "never usable for marketing");
    // A MARKETING version cannot be used where a security template is required.
    assert.equal(await policy.usabilityProblem(state.marketingVersionId, { purpose: "TRANSACTIONAL_SECURITY" }), "TEMPLATE_NOT_TRANSACTIONAL");
    await assert.rejects(policy.assertTemplateUsable(state.marketingVersionId, { purpose: "TRANSACTIONAL_SECURITY" }), (error) => error.statusCode === 422);
    // QA reflects the approval; the version detail shows it.
    const qa = await call("kim", "POST", `${kbase}/templates/${kimTemplateId}/versions/${versionId}/qa`, {});
    assert.equal(qa.status, 200, qa.text);
    const states = Object.fromEntries(qa.body.data.checks.map((entry) => [entry.id, entry.status]));
    assert.equal(states.approvals_state, "PASS");
    assert.equal(states.link_tracking, "UNKNOWN");
    assert.equal(states.unsubscribe_present, "PASS");
    const detail = (await call("kim", "GET", `${kbase}/templates/${kimTemplateId}`)).body.data;
    assert.equal(detail.versions[0].approval.approved, true);
    // Approving a MARKETING version is not a thing.
    const notNeeded = await call("erin", "POST", `${mbase}/templates/${state.marketingTemplateId}/versions/${state.marketingVersionId}/approve`, { stepUpId: await stepUp("erin", "MARKETING_TEMPLATE_APPROVE") });
    assert.equal(notNeeded.status, 409);
  });

  await t.test("preflight states: UNKNOWN when the provider is unavailable, BLOCKED for an unverified domain, statuses on every check", async () => {
    const campaignId = state.honestCampaignId;
    const run = async () => (await call("dave", "POST", `${mbase}/campaigns/${campaignId}/preflight`)).body.data;
    const verified = await run();
    const byId = (result) => Object.fromEntries(result.checks.map((entry) => [entry.id, entry.status]));
    assert.equal(verified.ok, true, JSON.stringify(verified.checks));
    assert.ok(verified.checks.every((entry) => ["PASS", "WARNING", "BLOCKED", "UNKNOWN"].includes(entry.status) && entry.ok === (entry.status !== "BLOCKED")));
    const states = byId(verified);
    assert.equal(states.provider_domain_verified, "PASS");
    assert.equal(states.spf, "PASS");
    assert.equal(states.dkim, "PASS");
    assert.equal(states.dmarc, "UNKNOWN", "Resend does not report DMARC");
    assert.equal(states.sender_reputation, "UNKNOWN", "too little data");
    assert.equal(states.link_tracking, "UNKNOWN");
    for (const id of ["template_classification", "sender_domain_brand_owned", "unsubscribe_present", "business_identity", "plaintext_consistency", "approvals_state", "consent_backed_recipients", "suppression_applied", "frequency_cap", "links_safe"]) assert.equal(states[id], "PASS", id);
    assert.equal(verified.summary.BLOCKED, 0);
    assert.match(verified.preflightSha256, /^[0-9a-f]{64}$/);

    // Provider unreachable: UNKNOWN, never PASS from the local flag.
    const down = { ...harness.adapter, validateDomain: async () => { throw Object.assign(new Error("down"), { code: "RESEND_HTTP_503" }); } };
    const variant = harness.build({}, { adapter: down });
    const erin = await client.adminUser.findUnique({ where: { id: ids.erin } });
    const unavailable = await variant.services.marketing.runPreflight(erin, cf.organization.id, campaignId);
    assert.equal(byId(unavailable).provider_domain_verified, "UNKNOWN");
    assert.equal(byId(unavailable).spf, "UNKNOWN");
    assert.equal(unavailable.ok, true, "UNKNOWN does not block");
    registerDeliverability(client, { validateDomain: (id) => harness.adapter.validateDomain(id) });

    // Provider says the domain failed: BLOCKED.
    harness.adapter.state.domains.set("fake_cosmicforge", { status: "FAILED", sendingStatus: "FAILED", receivingStatus: "VERIFIED", records: [{ record: "DKIM", status: "failed" }] });
    const failed = await run();
    assert.equal(failed.ok, false);
    assert.equal(byId(failed).provider_domain_verified, "BLOCKED");
    assert.equal(byId(failed).dkim, "BLOCKED");
    // Locally unverified: BLOCKED as before.
    await client.mailDomain.update({ where: { id: cf.domain.id }, data: { sendingStatus: "PENDING" } });
    assert.equal(byId(await run()).sender_domain_verified, "BLOCKED");
    await client.mailDomain.update({ where: { id: cf.domain.id }, data: { sendingStatus: "VERIFIED" } });
    // Pending at the provider: WARNING (sendable, needs a look).
    harness.adapter.state.domains.set("fake_cosmicforge", { status: "PENDING", sendingStatus: "PENDING", receivingStatus: "VERIFIED", records: [] });
    const pending = await run();
    assert.equal(byId(pending).provider_domain_verified, "WARNING");
    assert.equal(pending.ok, true);
  });

  await t.test("approval binds the preflight hash and records the check summary", async () => {
    const audienceId = await audienceWith(["b1@reader.example"]);
    const campaign = await call("dave", "POST", `${mbase}/campaigns`, { name: "Bound", topic: "newsletter", templateVersionId: state.marketingVersionId, audienceId, senderAddressId: cf.sender.id });
    const id = campaign.body.data.id;
    assert.equal((await call("dave", "POST", `${mbase}/campaigns/${id}/submit`, { revision: 1 })).status, 200);
    const seen = (await call("erin", "POST", `${mbase}/campaigns/${id}/preflight`)).body.data;
    // The provider state changes after the reviewer looked: the hash no longer matches.
    harness.adapter.state.domains.set("fake_cosmicforge", { status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "VERIFIED", records: [{ record: "SPF", status: "verified" }, { record: "DKIM", status: "verified" }] });
    const stale = await call("erin", "POST", `${mbase}/campaigns/${id}/approve`, { revision: 1, stepUpId: await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL"), contactSetSha256: seen.contactSetSha256, preflightSha256: seen.preflightSha256 });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.errors[0].reason, "PREFLIGHT_CHANGED_SINCE_REVIEW");
    const fresh = (await call("erin", "POST", `${mbase}/campaigns/${id}/preflight`)).body.data;
    const approved = await call("erin", "POST", `${mbase}/campaigns/${id}/approve`, { revision: 1, stepUpId: await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL"), contactSetSha256: fresh.contactSetSha256, preflightSha256: fresh.preflightSha256 });
    assert.equal(approved.status, 200, approved.text);
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MARKETING_CAMPAIGN_APPROVED", targetId: id } });
    assert.equal(audit.metadata.preflightSha256, fresh.preflightSha256);
    assert.equal(audit.metadata.preflightConfirmedByReviewer, true);
    assert.equal(audit.metadata.preflightSummary.BLOCKED, 0);
    assert.ok(audit.metadata.preflightUnknown.includes("dmarc"));
  });

  await t.test("template QA endpoint: previews, locale, accessibility, personalization, unsafe links, brand isolation", async () => {
    const templateId = await template("QA sample");
    const created = await version(templateId, [{ type: "heading", text: "Offers", level: 2 }, { type: "image", src: "https://cdn.cosmicforge.example/hero.png", alt: "" }, { type: "button", label: "Click here", url: "https://bit.ly/offer" }, { type: "text", text: "Hi {{first_name}} {{last_name}}" }]);
    assert.equal(created.status, 201, created.text);
    const qa = await call("dave", "POST", `${mbase}/templates/${templateId}/versions/${created.body.data.id}/qa`, { locale: "fr-FR", sampleData: { first_name: "Ada", last_name: "" } });
    assert.equal(qa.status, 200, qa.text);
    const report = qa.body.data;
    const states = Object.fromEntries(report.checks.map((entry) => [entry.id, entry.status]));
    assert.match(report.disclaimer, /do not prove/);
    assert.equal(report.classification, "MARKETING");
    assert.match(report.renders.desktop.html, /<html lang="fr-FR">/);
    assert.match(report.renders.desktop.html, /Hi Ada/);
    assert.match(report.renders.dark.html, /color-scheme/);
    assert.ok(report.renders.plaintext.includes("Unsubscribe:"));
    assert.equal(states.a11y_alt_text, "WARNING");
    assert.equal(states.a11y_link_text, "WARNING");
    assert.equal(states.a11y_heading_order, "WARNING");
    assert.equal(states.missing_personalization, "WARNING");
    assert.equal(states.links_safe, "BLOCKED");
    assert.equal(states.client_compatibility, "PASS");
    assert.equal(states.business_identity, "PASS", "brand postal address applied");
    const other = await call("kim", "POST", `${mbase}/templates/${templateId}/versions/${created.body.data.id}/qa`, {});
    assert.ok([403, 404].includes(other.status), `other brands cannot run QA: ${other.status}`);
    const crossVersion = await call("dave", "POST", `${mbase}/templates/${templateId}/versions/${state.marketingVersionId}/qa`, {});
    assert.equal(crossVersion.status, 404, "the version must belong to the template");
    // Render preview accepts a classification (the transactional preview path).
    const preview = await call("dave", "POST", `${mbase}/templates/render`, { subject: "Receipt", blocks: SIMPLE, classification: "TRANSACTIONAL" });
    assert.equal(preview.status, 200, preview.text);
    assert.doesNotMatch(preview.body.data.html, /Unsubscribe/);
  });
});

test("final gaps 1 + 7 before migration 37: classification answers 503, templates stay MARKETING, campaigns and QA keep working", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  await client.$executeRawUnsafe(fs.readFileSync(ROLLBACK_37, "utf8"));
  const harness = createHarness(client);
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const { server, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  const cf = brands.cosmicforge;
  const mbase = `/marketing/${cf.organization.id}`;
  const { stepUp, audienceWith, template, version } = helpers(harness, call, mbase);
  t.after(async () => {
    await closeServer(server);
    await db.close();
  });
  harness.adapter.state.domains.set("fake_cosmicforge", { status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "VERIFIED", records: [] });

  const templateId = await template("Pre-37 newsletter");
  const created = await version(templateId, SIMPLE);
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.data.classification, "MARKETING");
  const list = (await call("dave", "GET", `${mbase}/templates`)).body.data.find((row) => row.id === templateId);
  assert.equal(list.classification, "MARKETING");
  assert.equal(list.classificationAvailable, false);
  for (const response of [
    await call("dave", "GET", `${mbase}/templates/${templateId}/classification`),
    await call("erin", "PUT", `${mbase}/templates/${templateId}/classification`, { classification: "TRANSACTIONAL", reason: "Service mail only", stepUpId: await stepUp("erin", "MARKETING_TEMPLATE_CLASSIFY") }),
    await call("erin", "POST", `${mbase}/templates/${templateId}/versions/${created.body.data.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_TEMPLATE_APPROVE") }),
  ]) {
    assert.equal(response.status, 503, response.text);
    assert.equal(response.body.code, "MAIL_FEATURE_NOT_READY");
    assert.equal(response.body.retryable, true);
  }
  // Campaign create, preflight, submit and approve work exactly as before.
  const audienceId = await audienceWith(["p1@reader.example"]);
  const campaign = await call("dave", "POST", `${mbase}/campaigns`, { name: "Pre-37", topic: "newsletter", templateVersionId: created.body.data.id, audienceId, senderAddressId: cf.sender.id });
  assert.equal(campaign.status, 201, campaign.text);
  const preflight = (await call("dave", "POST", `${mbase}/campaigns/${campaign.body.data.id}/preflight`)).body.data;
  assert.equal(preflight.ok, true, JSON.stringify(preflight.checks));
  assert.equal(preflight.checks.find((entry) => entry.id === "template_classification").status, "PASS");
  assert.equal((await call("dave", "POST", `${mbase}/campaigns/${campaign.body.data.id}/submit`, { revision: 1 })).status, 200);
  const approved = await call("erin", "POST", `${mbase}/campaigns/${campaign.body.data.id}/approve`, { revision: 1, stepUpId: await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL") });
  assert.equal(approved.status, 200, approved.text);
  // QA works (MARKETING).
  const qa = await call("dave", "POST", `${mbase}/templates/${templateId}/versions/${created.body.data.id}/qa`, {});
  assert.equal(qa.status, 200, qa.text);
  assert.equal(qa.body.data.classification, "MARKETING");
});
