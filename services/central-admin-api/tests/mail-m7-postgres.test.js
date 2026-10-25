"use strict";

// CosmicForge Mail M7 (broadcasts and automation) on real PostgreSQL with the
// offline fake marketing provider. Covers the M7 exit criteria offline:
// controlled pilot campaign flow, opt-out and complaint handling, worker
// restart / ambiguous provider outcomes, plus approval integrity, brand
// isolation, cancellation, pause, caps and automation versioning.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp, postWebhook, BRAND_WEBHOOK_SECRETS } = require("./helpers/mail-test-harness");
const { signUnsubscribeToken } = require("../src/modules/mail/marketing/unsubscribe-token");
const { closeServer } = require("./helpers/server-close");

test("CosmicForge Mail M7 broadcasts and automation on real PostgreSQL", { timeout: 600000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client);
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const app = harness.mountApp(harness.mail);
  const { server, base } = await listen(app);
  const call = caller(base, ids);
  const cf = brands.cosmicforge;
  const kg = brands.karryam;
  const mbase = `/marketing/${cf.organization.id}`;
  const fake = harness.marketingAdapter;
  const worker = harness.mail.createWorker({ queues: ["MARKETING", "EVENTS"] });
  const work = async (rounds = 8, stepMs = 2000) => {
    for (let index = 0; index < rounds; index += 1) {
      harness.advance(stepMs);
      await worker.drain({ maxTicks: 20 });
    }
  };
  const stepUp = async (key, purpose) => {
    harness.advance(31000);
    const response = await call(key, "POST", "/security/step-up", { code: totp(harness.clock), purpose });
    assert.equal(response.status, 201, response.text);
    return response.body.data.stepUpId;
  };
  const consent = (topic = "newsletter", extra = {}) => ({ topic, source: "WEB_FORM", policyVersion: "2026-10", evidence: { reference: `form-${crypto.randomUUID().slice(0, 8)}` }, ...extra });
  const newContact = async (email, extra = {}) => {
    const response = await call("dave", "POST", `${mbase}/contacts`, { email, firstName: email.split("@")[0], consent: consent(), ...extra });
    assert.equal(response.status, 201, response.text);
    return response.body.data;
  };

  let templateVersionId;
  const approvedCampaign = async (name, emails, { frequencyCapHours = 0 } = {}) => {
    const contacts = [];
    for (const email of emails) contacts.push(await newContact(email));
    const audience = await call("dave", "POST", `${mbase}/audiences`, { name: `${name} audience`, topic: "newsletter" });
    await call("dave", "POST", `${mbase}/audiences/${audience.body.data.id}/contacts`, { contactIds: contacts.map((contact) => contact.id) });
    const campaign = await call("dave", "POST", `${mbase}/campaigns`, { name, topic: "newsletter", templateVersionId, audienceId: audience.body.data.id, senderAddressId: cf.sender.id, frequencyCapHours });
    assert.equal(campaign.status, 201, campaign.text);
    const submitted = await call("dave", "POST", `${mbase}/campaigns/${campaign.body.data.id}/submit`, { revision: 1 });
    assert.equal(submitted.status, 200, submitted.text);
    const approved = await call("erin", "POST", `${mbase}/campaigns/${campaign.body.data.id}/approve`, { revision: 1, stepUpId: await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL") });
    assert.equal(approved.status, 200, approved.text);
    return { id: campaign.body.data.id, audienceId: audience.body.data.id, contacts };
  };
  const schedule = (campaignId, extra = {}) => call("dave", "POST", `${mbase}/campaigns/${campaignId}/schedule`, { revision: 1, sendAtUtc: new Date(harness.clock().getTime() + 120000).toISOString(), ...extra });
  const dispatchOf = (campaignId) => client.marketingBroadcastDispatch.findUnique({ where: { campaignId } });

  try {
    await t.test("setup: template version for the brand", async () => {
      const template = await call("dave", "POST", `${mbase}/templates`, { name: "M7 newsletter" });
      const version = await call("dave", "POST", `${mbase}/templates/${template.body.data.id}/versions`, { subject: "News for {{first_name}}", blocks: [{ type: "heading", text: "Hello {{first_name}}" }, { type: "text", text: "Autumn update from {{brand_name}}." }] });
      assert.equal(version.status, 201, version.text);
      templateVersionId = version.body.data.id;
    });

    await t.test("pilot campaign: schedule (time zones), dispatch-time eligibility, provider handoff, delivery reconciliation, report", async () => {
      const campaign = await approvedCampaign("Pilot", ["ada@reader.example", "ben@reader.example", "cy@reader.example"]);
      const [ada, ben, cy] = campaign.contacts;
      // Approved recipients snapshot (evidence) is immutable.
      const snapshot = await client.marketingCampaignSnapshot.findFirst({ where: { campaignId: campaign.id, kind: "APPROVAL" } });
      assert.equal(await client.marketingCampaignApprovedContact.count({ where: { snapshotId: snapshot.id } }), 3);
      await assert.rejects(client.$executeRawUnsafe(`DELETE FROM marketing_campaign_approved_contacts WHERE snapshot_id = '${snapshot.id}'`), /immutable/);
      // Postal address lands in the approved content.
      assert.match(snapshot.html, /1 Marina Road, Lagos/);

      // Validation: DST gap, too soon, cross-brand, authorisation.
      assert.equal((await schedule(campaign.id, { sendAtUtc: undefined, sendAt: "2026-03-29T01:30", timeZone: "Europe/London" })).body.errors?.[0]?.reason || (await schedule(campaign.id, { sendAtUtc: undefined, sendAt: "2026-03-29T01:30", timeZone: "Europe/London" })).body.code, "SCHEDULE_TIME_NONEXISTENT");
      const tooSoon = await schedule(campaign.id, { sendAtUtc: new Date(harness.clock().getTime() + 5000).toISOString() });
      assert.equal(tooSoon.status, 400, tooSoon.text);
      assert.equal((await call("kim", "POST", `${mbase}/campaigns/${campaign.id}/schedule`, { revision: 1 })).status, 404, "other brand cannot see the campaign");
      assert.equal((await call("super", "POST", `${mbase}/campaigns/${campaign.id}/schedule`, { revision: 1 })).status, 404, "SUPER has no implicit marketing scope");

      // Local wall-clock time in the brand time zone (Lagos, UTC+1).
      const tomorrow = new Date(harness.clock().getTime() + 2 * 86400000).toISOString().slice(0, 10);
      const scheduled = await schedule(campaign.id, { sendAtUtc: undefined, sendAt: `${tomorrow}T09:00`, timeZone: "Africa/Lagos" });
      assert.equal(scheduled.status, 201, scheduled.text);
      assert.equal(scheduled.body.data.scheduledFor, `${tomorrow}T08:00:00.000Z`);
      assert.equal((await schedule(campaign.id)).status, 409, "a campaign is dispatched once");
      assert.equal((await call("dave", "PATCH", `${mbase}/campaigns/${campaign.id}`, { revision: 1, subjectOverride: "late edit" })).status, 409, "scheduled campaigns cannot be edited");

      // Before dispatch: cy unsubscribes through the signed link; a new contact joins the audience.
      const token = signUnsubscribeToken({ organizationId: cf.organization.id, contactId: cy.id, topic: "newsletter" }, harness.environment.MAIL_MARKETING_UNSUBSCRIBE_SECRET);
      const pageView = await call(null, "GET", `/public/unsubscribe/${token}`);
      assert.equal(pageView.status, 200);
      assert.match(pageView.headers.get("content-security-policy"), /default-src 'none'/);
      assert.ok(!pageView.text.includes("cy@reader.example"), "email is masked on the page");
      assert.equal((await client.marketingConsent.findFirst({ where: { contactId: cy.id } })).status, "GRANTED", "GET never changes consent");
      const unsubscribed = await call(null, "POST", `/public/unsubscribe/${token}`, "scope=all");
      assert.equal(unsubscribed.status, 200, unsubscribed.text);
      const late = await newContact("late@reader.example");
      await call("dave", "POST", `${mbase}/audiences/${campaign.audienceId}/contacts`, { contactIds: [late.id] });

      // Not due yet: nothing happens.
      await work(2);
      assert.equal((await dispatchOf(campaign.id)).status, "SCHEDULED");
      harness.advance(3 * 86400000);
      await work(6);
      const dispatch = await dispatchOf(campaign.id);
      assert.equal(dispatch.status, "SENDING", JSON.stringify(dispatch));
      assert.equal(dispatch.recipientCount, 2);
      const broadcast = fake.state.broadcasts.get(dispatch.providerBroadcastId);
      assert.equal(broadcast.sendCalls, 1);
      assert.match(broadcast.html, /\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/, "provider unsubscribe link merged in");
      assert.match(broadcast.html, /\{\{\{contact\.first_name\}\}\}/);
      assert.equal(broadcast.html.includes("{{unsubscribe_url}}"), false);
      const members = fake.segmentMembers(dispatch.providerSegmentId).map((contact) => contact.email).sort();
      assert.deepEqual(members, ["ada@reader.example", "ben@reader.example"], "only approved AND still-eligible contacts reach the provider");
      const cyRow = await client.marketingBroadcastRecipient.findFirst({ where: { dispatchId: dispatch.id, contactId: cy.id } });
      assert.equal(cyRow.status, "EXCLUDED");
      assert.equal(await client.marketingBroadcastRecipient.count({ where: { dispatchId: dispatch.id, contactId: late.id } }), 0, "contacts added after approval are not sent");
      assert.equal((await client.marketingEmailCampaign.findUnique({ where: { id: campaign.id } })).status, "SENDING");

      // Provider events: delivered for ada (out of order with sent), bounce for ben; replay deduped.
      const delivered = await postWebhook(base, harness.clock, "email.delivered", { email_id: "bc_1", broadcast_id: dispatch.providerBroadcastId, to: ["ada@reader.example"] });
      assert.equal(delivered.status, 200);
      const replay = await postWebhook(base, harness.clock, "email.delivered", { email_id: "bc_1", broadcast_id: dispatch.providerBroadcastId, to: ["ada@reader.example"] }, { id: delivered.id });
      assert.equal(replay.body.duplicate, true);
      await postWebhook(base, harness.clock, "email.sent", { email_id: "bc_1", broadcast_id: dispatch.providerBroadcastId, to: ["ada@reader.example"] });
      await postWebhook(base, harness.clock, "email.bounced", { email_id: "bc_2", broadcast_id: dispatch.providerBroadcastId, to: ["ben@reader.example"], bounce: { type: "Permanent", message: "mailbox unavailable" } });
      await postWebhook(base, harness.clock, "email.opened", { email_id: "bc_1", broadcast_id: dispatch.providerBroadcastId, to: ["ada@reader.example"] });
      await work(2);
      const adaRow = await client.marketingBroadcastRecipient.findFirst({ where: { dispatchId: dispatch.id, contactId: ada.id } });
      assert.equal(adaRow.status, "DELIVERED", "a late 'sent' event never regresses delivered");
      assert.ok(adaRow.openedAt);
      assert.equal((await client.marketingBroadcastRecipient.findFirst({ where: { dispatchId: dispatch.id, contactId: ben.id } })).status, "BOUNCED");
      assert.ok(await client.marketingSuppression.findFirst({ where: { organizationId: cf.organization.id, email: "ben@reader.example", reason: "BOUNCED", liftedAt: null } }), "bounce suppresses for the brand");
      assert.equal(await client.marketingSuppression.count({ where: { organizationId: kg.organization.id, email: "ben@reader.example" } }), 0, "and only for that brand");

      // Provider finishes; reconcile finalises.
      fake.completeBroadcast(dispatch.providerBroadcastId);
      harness.advance(61000);
      await work(2);
      const finished = await dispatchOf(campaign.id);
      assert.equal(finished.status, "COMPLETED");
      assert.equal((await client.marketingEmailCampaign.findUnique({ where: { id: campaign.id } })).status, "COMPLETE");
      const report = await call("erin", "GET", `${mbase}/campaigns/${campaign.id}/report`);
      assert.equal(report.status, 200, report.text);
      assert.equal(report.body.data.totals.handedToProvider, 2);
      assert.equal(report.body.data.rates.deliveredPercent, 50);
      assert.equal(report.body.data.rates.bouncePercent, 50);
      assert.equal(report.body.data.rates.openPercentIndicative, 50);
      assert.ok(report.body.data.timeline.some((entry) => entry.action === "MARKETING_BROADCAST_FINALIZED"));
      assert.equal((await call("kim", "GET", `${mbase}/campaigns/${campaign.id}/report`)).status, 404, "reports are brand-scoped");
      const overview = await call("dave", "GET", `${mbase}/reports/overview`);
      assert.equal(overview.status, 200, overview.text);
      assert.equal(overview.body.data.campaigns.COMPLETE, 1);
    });

    await t.test("opt-out and complaints: provider unsubscribe (brand webhook), complaint suppression, cross-brand events rejected", async () => {
      const campaign = await approvedCampaign("Optout", ["dee@reader.example", "eve@reader.example"]);
      assert.equal((await schedule(campaign.id)).status, 201);
      harness.advance(180000);
      await work(6);
      const dispatch = await dispatchOf(campaign.id);
      assert.equal(dispatch.status, "SENDING");
      const dee = await client.marketingBroadcastRecipient.findFirst({ where: { dispatchId: dispatch.id, email: "dee@reader.example" } });
      // The karryam endpoint cannot affect cosmicforge contacts, even with a matching provider id.
      const crossBrand = await postWebhook(base, harness.clock, "contact.updated", { id: dee.providerContactId, email: "dee@reader.example", unsubscribed: true, created_at: harness.clock().toISOString(), updated_at: harness.clock().toISOString() }, { path: "/webhooks/resend/brand/karryam", secret: BRAND_WEBHOOK_SECRETS.karryam });
      assert.equal(crossBrand.status, 200);
      // Wrong secret for the brand endpoint is rejected; unknown brands look the same.
      assert.equal((await postWebhook(base, harness.clock, "contact.updated", { id: "x", unsubscribed: true }, { path: "/webhooks/resend/brand/cosmicforge", secret: BRAND_WEBHOOK_SECRETS.karryam })).status, 401);
      assert.equal((await postWebhook(base, harness.clock, "contact.updated", { id: "x", unsubscribed: true }, { path: "/webhooks/resend/brand/nobrand", secret: BRAND_WEBHOOK_SECRETS.karryam })).status, 401);
      await work(2);
      assert.equal((await client.marketingConsent.findFirst({ where: { contactId: dee.contactId } })).status, "GRANTED", "cross-brand unsubscribe ignored");
      const own = await postWebhook(base, harness.clock, "contact.updated", { id: dee.providerContactId, email: "dee@reader.example", unsubscribed: true, created_at: harness.clock().toISOString(), updated_at: harness.clock().toISOString() }, { path: "/webhooks/resend/brand/cosmicforge", secret: BRAND_WEBHOOK_SECRETS.cosmicforge });
      assert.equal(own.status, 200);
      await postWebhook(base, harness.clock, "email.complained", { email_id: "bc_c1", broadcast_id: dispatch.providerBroadcastId, to: ["eve@reader.example"] });
      await work(2);
      assert.equal((await client.marketingConsent.findFirst({ where: { contactId: dee.contactId } })).status, "WITHDRAWN", "provider unsubscribe withdraws consent");
      assert.ok(await client.marketingSuppression.findFirst({ where: { organizationId: cf.organization.id, email: "dee@reader.example", reason: "UNSUBSCRIBED" } }));
      assert.ok(await client.marketingSuppression.findFirst({ where: { organizationId: cf.organization.id, email: "eve@reader.example", reason: "COMPLAINED" } }), "complaint suppresses");
      assert.equal((await client.marketingContact.findUnique({ where: { organizationId_email: { organizationId: cf.organization.id, email: "eve@reader.example" } } })).status, "COMPLAINED");
      assert.equal((await call("dave", "POST", `${mbase}/suppressions/${(await client.marketingSuppression.findFirst({ where: { email: "eve@reader.example" } })).id}/lift`)).status, 409, "complaints cannot be lifted");
      // Provider-side unsubscribe discovered during sync is honoured before send.
      const next = await approvedCampaign("Optout2", ["fox@reader.example", "gus@reader.example"]);
      await client.marketingContact.findUnique({ where: { id: next.contacts[0].id } });
      fake.state.contacts.set("fox@reader.example", { id: "fake_contact_fox", email: "fox@reader.example", unsubscribed: true, segments: new Set() });
      assert.equal((await schedule(next.id)).status, 201);
      harness.advance(180000);
      await work(6);
      const nextDispatch = await dispatchOf(next.id);
      assert.equal((await client.marketingBroadcastRecipient.findFirst({ where: { dispatchId: nextDispatch.id, email: "fox@reader.example" } })).status, "UNSUBSCRIBED");
      assert.equal((await client.marketingConsent.findFirst({ where: { contactId: next.contacts[0].id } })).status, "WITHDRAWN");
      assert.deepEqual(fake.segmentMembers(nextDispatch.providerSegmentId).map((contact) => contact.email), ["gus@reader.example"]);
    });

    await t.test("restart and ambiguity: lost responses are reconciled by status, never re-posted; unknown outcomes are honest", async () => {
      // Ambiguous broadcast creation: adopted by name on retry (one broadcast).
      const c1 = await approvedCampaign("Ambiguous create", ["h1@reader.example"]);
      fake.failNext("createBroadcast", "AMBIGUOUS", "PROVIDER_TIMEOUT", { acceptBeforeFailing: true });
      // Ambiguous send: provider accepted, response lost.
      fake.failNext("sendBroadcast", "AMBIGUOUS", "PROVIDER_TIMEOUT", { acceptBeforeFailing: true });
      // Transient sync failure mid-batch.
      fake.failNext("createContact", "RETRYABLE", "RESEND_HTTP_503");
      assert.equal((await schedule(c1.id)).status, 201);
      harness.advance(180000);
      await work(10, 40000);
      const d1 = await dispatchOf(c1.id);
      assert.equal(d1.status, "SENDING", JSON.stringify(d1));
      const named = [...fake.state.broadcasts.values()].filter((entry) => entry.name === `cf-dispatch-${d1.id}`);
      assert.equal(named.length, 1, "no duplicate broadcast after an ambiguous create");
      assert.equal(named[0].sendCalls, 1, "an ambiguous send is never re-posted");
      assert.equal([...fake.state.contacts.values()].filter((contact) => contact.email === "h1@reader.example").length, 1, "contact sync is idempotent by email");

      // Worker crash mid-lease: lease expires, another worker resumes safely.
      const c2 = await approvedCampaign("Crash", ["h2@reader.example"]);
      assert.equal((await schedule(c2.id)).status, 201);
      harness.advance(180000);
      const d2 = await dispatchOf(c2.id);
      await client.mailOutboxJob.updateMany({ where: { idempotencyKey: `broadcast:${d2.id}` }, data: { status: "LEASED", leaseOwner: "dead-worker", leaseExpiresAt: new Date(harness.clock().getTime() - 1000) } });
      await work(6);
      assert.equal((await dispatchOf(c2.id)).status, "SENDING");

      // A lost send whose status stays unreadable for over an hour becomes
      // OUTCOME_UNKNOWN and is never re-posted. (If the status had read
      // "draft", re-sending would be safe and is what the dispatcher does.)
      const c3 = await approvedCampaign("Unknown", ["h3@reader.example"]);
      assert.equal((await schedule(c3.id)).status, 201);
      fake.failNext("sendBroadcast", "AMBIGUOUS", "PROVIDER_TIMEOUT", { acceptBeforeFailing: true });
      for (let index = 0; index < 60; index += 1) fake.failNext("getBroadcast", "RETRYABLE", "RESEND_HTTP_503");
      harness.advance(180000);
      await work(4);
      harness.advance(2 * 3600000);
      await work(4, 600000);
      const d3 = await dispatchOf(c3.id);
      assert.equal(d3.status, "OUTCOME_UNKNOWN", JSON.stringify(d3));
      assert.equal((await client.marketingEmailCampaign.findUnique({ where: { id: c3.id } })).status, "OUTCOME_UNKNOWN");
      assert.equal((await client.marketingBroadcastRecipient.findFirst({ where: { dispatchId: d3.id } })).status, "OUTCOME_UNKNOWN", "never reported as delivered");
      const sendsForUnknown = [...fake.state.broadcasts.values()].filter((entry) => entry.name === `cf-dispatch-${d3.id}`).reduce((sum, entry) => sum + entry.sendCalls, 0);
      assert.ok(sendsForUnknown <= 1);
      fake.state.failures.length = 0;
    });

    await t.test("cancellation, pause and emergency controls", async () => {
      // Cancel before dispatch: immediate, nothing reaches the provider.
      const c1 = await approvedCampaign("Cancel early", ["i1@reader.example"]);
      assert.equal((await schedule(c1.id)).status, 201);
      const cancelled = await call("erin", "POST", `${mbase}/campaigns/${c1.id}/cancel`, { reason: "wrong audience" });
      assert.equal(cancelled.status, 200, cancelled.text);
      assert.equal(cancelled.body.data.status, "CANCELLED");
      harness.advance(180000);
      await work(3);
      const d1 = await dispatchOf(c1.id);
      assert.equal(d1.providerSegmentId, null);
      assert.equal((await client.mailOutboxJob.findUnique({ where: { idempotencyKey: `broadcast:${d1.id}` } })).status, "CANCELLED");
      assert.equal((await call("erin", "POST", `${mbase}/campaigns/${c1.id}/cancel`, {})).status, 409);

      // Cancel while the provider is sending: provider cancel; unsent mail stops.
      const c2 = await approvedCampaign("Cancel late", ["i2@reader.example", "i3@reader.example"]);
      assert.equal((await schedule(c2.id)).status, 201);
      harness.advance(180000);
      await work(6);
      assert.equal((await dispatchOf(c2.id)).status, "SENDING");
      const late = await call("dave", "POST", `${mbase}/campaigns/${c2.id}/cancel`, { reason: "error in copy" });
      assert.match(late.body.data.note, /cannot be recalled/);
      await work(3, 61000);
      const d2 = await dispatchOf(c2.id);
      assert.equal(d2.status, "CANCELLED", JSON.stringify(d2));
      assert.ok(fake.state.calls.some((entry) => entry.operation === "cancelBroadcast" && entry.broadcastId === d2.providerBroadcastId));

      // Pause / resume a scheduled dispatch; brand pause defers without burning attempts.
      const c3 = await approvedCampaign("Paused", ["i4@reader.example"]);
      assert.equal((await schedule(c3.id)).status, 201);
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${c3.id}/pause`)).body.data.status, "PAUSED");
      harness.advance(180000);
      await work(3);
      assert.equal((await dispatchOf(c3.id)).status, "PAUSED");
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${c3.id}/resume`)).body.data.status, "SCHEDULED");
      assert.equal((await call("dave", "POST", `${mbase}/dispatch/pause`, { reason: "deliverability review" })).status, 200);
      await work(3, 400000);
      const d3 = await dispatchOf(c3.id);
      assert.equal(d3.lastErrorCode, "BRAND_DISPATCH_PAUSED");
      const job = await client.mailOutboxJob.findUnique({ where: { idempotencyKey: `broadcast:${d3.id}` } });
      assert.equal(job.attemptCount, 0, "deferral does not consume attempts");
      assert.equal((await call("dave", "POST", `${mbase}/dispatch/resume`, { stepUpId: "x" })).status, 403, "authors cannot resume a brand pause");
      assert.equal((await call("erin", "POST", `${mbase}/dispatch/resume`, {})).body.code, "MAIL_STEP_UP_REQUIRED");
      assert.equal((await call("erin", "POST", `${mbase}/dispatch/resume`, { stepUpId: await stepUp("erin", "MARKETING_BROADCAST_OVERRIDE") })).status, 200);
      await work(6, 310000);
      assert.equal((await dispatchOf(c3.id)).status, "SENDING");

      // Emergency stop (worker config) defers dispatch and keeps records.
      const stopped = harness.build({ MAIL_EMERGENCY_STOP_MARKETING: "true" });
      const c4 = await approvedCampaign("Emergency", ["i5@reader.example"]);
      assert.equal((await schedule(c4.id)).status, 201);
      harness.advance(180000);
      const stoppedWorker = stopped.createWorker({ queues: ["MARKETING"] });
      await stoppedWorker.drain();
      const d4 = await dispatchOf(c4.id);
      assert.equal(d4.status, "SCHEDULED");
      assert.equal(d4.lastErrorCode, "MARKETING_EMERGENCY_STOP");
      const stoppedApp = harness.mountApp(stopped);
      const stoppedServer = await listen(stoppedApp);
      const stoppedCall = caller(stoppedServer.base, ids);
      assert.equal((await stoppedCall("dave", "POST", `${mbase}/campaigns/${c4.id}/schedule`, { revision: 1 })).body.code, "MAIL_EMERGENCY_STOP");
      await closeServer(stoppedServer.server);
    });

    await t.test("approval integrity, sender revocation and caps fail closed before any provider call", async () => {
      const callsBefore = fake.state.calls.length;
      // Approval expired by the time of dispatch.
      const expired = await approvedCampaign("Expired", ["j1@reader.example"]);
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${expired.id}/schedule`, { revision: 1, sendAtUtc: new Date(harness.clock().getTime() + 15 * 86400000).toISOString() })).status, 201);
      harness.advance(16 * 86400000);
      await work(2);
      const de = await dispatchOf(expired.id);
      assert.equal(de.status, "FAILED");
      assert.equal(de.lastErrorCode, "APPROVAL_EXPIRED");
      // Sender identity suspended after scheduling.
      const revoked = await approvedCampaign("Revoked sender", ["j2@reader.example"]);
      assert.equal((await schedule(revoked.id)).status, 201);
      await client.mailAddress.update({ where: { id: cf.sender.id }, data: { status: "SUSPENDED" } });
      harness.advance(180000);
      await work(2);
      assert.equal((await dispatchOf(revoked.id)).lastErrorCode, "SENDER_NOT_AUTHORIZED");
      await client.mailAddress.update({ where: { id: cf.sender.id }, data: { status: "ACTIVE" } });
      // Domain kill-switch.
      const killed = await approvedCampaign("Domain kill", ["j3@reader.example"]);
      assert.equal((await schedule(killed.id)).status, 201);
      await client.mailDomain.update({ where: { id: cf.domain.id }, data: { sendingStatus: "DISABLED" } });
      harness.advance(180000);
      await work(2);
      assert.equal((await dispatchOf(killed.id)).lastErrorCode, "SENDER_DOMAIN_SENDING_DISABLED");
      await client.mailDomain.update({ where: { id: cf.domain.id }, data: { sendingStatus: "VERIFIED" } });
      // Recipient cap from brand settings.
      const capped = await approvedCampaign("Capped", ["j4@reader.example", "j5@reader.example"]);
      assert.equal((await call("erin", "PATCH", `${mbase}/settings`, { maxBroadcastRecipients: 1 })).status, 200);
      assert.equal((await call("erin", "PATCH", `${mbase}/settings`, { maxBroadcastRecipients: 999999 })).status, 400, "cannot exceed the hard ceiling");
      assert.equal((await schedule(capped.id)).status, 201);
      harness.advance(180000);
      await work(2);
      assert.equal((await dispatchOf(capped.id)).lastErrorCode, "BROADCAST_RECIPIENT_CAP_EXCEEDED");
      await call("erin", "PATCH", `${mbase}/settings`, { maxBroadcastRecipients: 1000 });
      const providerCalls = fake.state.calls.slice(callsBefore).filter((entry) => ["createSegment", "createBroadcast", "sendBroadcast", "createContact"].includes(entry.operation));
      assert.equal(providerCalls.length, 0, "none of the failed dispatches touched the provider");
      // Frequency cap: a contact mailed recently is excluded from the next broadcast.
      const first = await approvedCampaign("Freq A", ["k1@reader.example"]);
      assert.equal((await schedule(first.id)).status, 201);
      harness.advance(180000);
      await work(6);
      const audience = await call("dave", "POST", `${mbase}/audiences`, { name: "Freq B audience", topic: "newsletter" });
      const k2 = await newContact("k2@reader.example");
      await call("dave", "POST", `${mbase}/audiences/${audience.body.data.id}/contacts`, { contactIds: [first.contacts[0].id, k2.id] });
      const second = await call("dave", "POST", `${mbase}/campaigns`, { name: "Freq B", topic: "newsletter", templateVersionId, audienceId: audience.body.data.id, senderAddressId: cf.sender.id, frequencyCapHours: 72 });
      await call("dave", "POST", `${mbase}/campaigns/${second.body.data.id}/submit`, { revision: 1 });
      await call("erin", "POST", `${mbase}/campaigns/${second.body.data.id}/approve`, { revision: 1, stepUpId: await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL") });
      assert.equal((await schedule(second.body.data.id)).status, 201);
      harness.advance(180000);
      await work(6);
      const d2 = await dispatchOf(second.body.data.id);
      assert.equal((await client.marketingBroadcastRecipient.findFirst({ where: { dispatchId: d2.id, contactId: first.contacts[0].id } })).exclusionReason, "FREQUENCY_CAP");
    });

    let welcomeId;
    let welcomeV1;
    await t.test("automation: versioned review with distinct approver + MFA, activation guard, consent-triggered welcome", async () => {
      const definition = (subject) => ({ topic: "newsletter", entryStepId: "welcome", steps: [
        { id: "welcome", type: "send_email", templateVersionId, senderAddressId: cf.sender.id, subjectOverride: subject, next: "wait" },
        { id: "wait", type: "delay", minutes: 60, next: "check" },
        { id: "check", type: "condition", condition: { field: "engagement.previous_send_delivered", op: "equals", value: "true" }, then: "followup", else: "done" },
        { id: "followup", type: "send_email", templateVersionId, senderAddressId: cf.sender.id, next: null },
        { id: "done", type: "exit" },
      ] });
      const created = await call("dave", "POST", `${mbase}/automations`, { name: "Welcome", triggerType: "CONSENT_GRANTED" });
      assert.equal(created.status, 201, created.text);
      welcomeId = created.body.data.id;
      const cyclic = await call("dave", "PUT", `${mbase}/automations/${welcomeId}/draft`, { definition: { topic: "newsletter", entryStepId: "a", steps: [{ id: "a", type: "delay", minutes: 5, next: "b" }, { id: "b", type: "send_email", templateVersionId, senderAddressId: cf.sender.id, next: "a" }] }, triggerConfig: { topic: "newsletter" } });
      assert.equal(cyclic.status, 400, "cycles are rejected");
      const foreignSender = await call("dave", "PUT", `${mbase}/automations/${welcomeId}/draft`, { definition: { topic: "newsletter", steps: [{ id: "a", type: "send_email", templateVersionId, senderAddressId: kg.sender.id }] }, triggerConfig: { topic: "newsletter" } });
      assert.equal(foreignSender.status, 400, "senders of another brand are rejected");
      const draft = await call("dave", "PUT", `${mbase}/automations/${welcomeId}/draft`, { definition: definition("Welcome {{first_name}}"), triggerConfig: { topic: "newsletter" } });
      assert.equal(draft.status, 200, draft.text);
      welcomeV1 = draft.body.data.id;
      assert.equal((await call("dave", "POST", `${mbase}/automations/${welcomeId}/versions/${welcomeV1}/submit`)).body.data.status, "PENDING_REVIEW");
      await assert.rejects(client.$executeRawUnsafe(`UPDATE marketing_automation_versions SET definition = '{}' WHERE id = '${welcomeV1}'`), /immutable/);
      assert.equal((await call("dave", "POST", `${mbase}/automations/${welcomeId}/versions/${welcomeV1}/approve`, {})).status, 403, "authors cannot approve");
      assert.equal((await call("erin", "POST", `${mbase}/automations/${welcomeId}/versions/${welcomeV1}/approve`, {})).body.code, "MAIL_STEP_UP_REQUIRED");
      const wrongPurpose = await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL");
      assert.equal((await call("erin", "POST", `${mbase}/automations/${welcomeId}/versions/${welcomeV1}/approve`, { stepUpId: wrongPurpose })).body.code, "MAIL_STEP_UP_REQUIRED", "purpose-bound");
      const published = await call("erin", "POST", `${mbase}/automations/${welcomeId}/versions/${welcomeV1}/approve`, { stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_PUBLISH"), definitionSha256: draft.body.data.definitionSha256 });
      assert.equal(published.status, 200, published.text);
      assert.equal(published.body.data.activeVersionId, welcomeV1);
      assert.equal((await call("dave", "POST", `${mbase}/automations/${welcomeId}/activate`)).status, 403, "only approvers start execution");
      assert.equal((await call("erin", "POST", `${mbase}/automations/${welcomeId}/activate`)).body.data.status, "ACTIVE");

      // A new consent triggers the welcome email once.
      const before = fake.state.emails.length;
      const contact = await newContact("welcome@reader.example");
      await work(3, 61000);
      const sent = fake.state.emails.slice(before);
      assert.equal(sent.length, 1, JSON.stringify(sent.map((entry) => entry.to)));
      assert.equal(sent[0].to[0].address, "welcome@reader.example");
      assert.equal(sent[0].subject, "Welcome welcome");
      assert.match(sent[0].headers["List-Unsubscribe"], /^<https:\/\/admin-api\.cosmicforge\.example\/api\/mail\/v1\/public\/unsubscribe\//);
      assert.equal(sent[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
      assert.match(sent[0].html, /1 Marina Road/);
      const enrollment = await client.marketingAutomationEnrollment.findFirst({ where: { automationId: welcomeId, contactId: contact.id } });
      assert.equal(enrollment.status, "WAITING");
      // Duplicate trigger (same consent event) does not re-enroll; job replay does not re-send.
      const event = await client.marketingTriggerEvent.findFirst({ where: { contactId: contact.id } });
      await client.marketingTriggerEvent.update({ where: { id: event.id }, data: { status: "RECEIVED" } });
      await work(2, 61000);
      assert.equal(await client.marketingAutomationEnrollment.count({ where: { automationId: welcomeId, contactId: contact.id } }), 1);
      assert.equal(fake.state.emails.length - before, 1);

      // Publish v2 while v1 enrollment waits; the running enrollment stays on v1.
      const v2 = await call("dave", "PUT", `${mbase}/automations/${welcomeId}/draft`, { definition: { ...definition("Welcome v2"), steps: definition("Welcome v2").steps.map((step) => (step.id === "followup" ? { ...step, subjectOverride: "Follow-up v2" } : step)) }, triggerConfig: { topic: "newsletter" } });
      await call("dave", "POST", `${mbase}/automations/${welcomeId}/versions/${v2.body.data.id}/submit`);
      assert.equal((await call("fay", "POST", `${mbase}/automations/${welcomeId}/versions/${v2.body.data.id}/approve`, { stepUpId: await stepUp("fay", "MARKETING_AUTOMATION_PUBLISH") })).status, 200);
      assert.equal((await client.marketingAutomationVersion.findUnique({ where: { id: welcomeV1 } })).status, "SUPERSEDED");
      // Provider reports delivery of the first email; after the delay the condition picks the follow-up.
      await postWebhook(base, harness.clock, "email.delivered", { email_id: sent[0].providerMessageId, to: ["welcome@reader.example"] });
      await work(2);
      harness.advance(61 * 60000);
      await work(4, 61000);
      const followups = fake.state.emails.slice(before + 1).filter((entry) => entry.to[0].address === "welcome@reader.example");
      assert.equal(followups.length, 1);
      assert.notEqual(followups[0].subject, "Follow-up v2", "v1 enrollment keeps v1 definition");
      assert.equal((await client.marketingAutomationEnrollment.findUnique({ where: { id: enrollment.id } })).status, "COMPLETED");
      const history = await call("erin", "GET", `${mbase}/automations/${welcomeId}/history?enrollmentId=${enrollment.id}`);
      assert.deepEqual(history.body.data.runs.map((run) => run.stepId), ["welcome", "wait", "check", "followup"]);
    });

    await t.test("automation: consent withdrawal, pause, product events, ambiguous sends and frequency caps", async () => {
      const contact = await newContact("withdraw@reader.example");
      await work(3, 61000);
      const enrollment = await client.marketingAutomationEnrollment.findFirst({ where: { automationId: welcomeId, contactId: contact.id } });
      assert.equal(enrollment.status, "WAITING");
      await call("dave", "POST", `${mbase}/contacts/${contact.id}/consents/newsletter/withdraw`, { source: "admin" });
      harness.advance(61 * 60000);
      await postWebhook(base, harness.clock, "email.delivered", { email_id: (await client.marketingAutomationStepRun.findFirst({ where: { enrollmentId: enrollment.id, stepId: "welcome" } })).providerMessageId, to: ["withdraw@reader.example"] });
      await work(4, 61000);
      const after = await client.marketingAutomationEnrollment.findUnique({ where: { id: enrollment.id } });
      assert.equal(after.status, "EXITED");
      assert.equal(after.exitReason, "CONSENT_NOT_GRANTED");

      // Pause stops sending; nothing is lost.
      assert.equal((await call("dave", "POST", `${mbase}/automations/${welcomeId}/pause`)).body.data.status, "PAUSED");
      const before = fake.state.emails.length;
      const paused = await newContact("paused@reader.example");
      await work(3, 61000);
      assert.equal(fake.state.emails.length, before, "paused automations do not send");
      assert.equal((await call("erin", "POST", `${mbase}/automations/${welcomeId}/activate`)).body.data.status, "ACTIVE");
      await work(3, 61000);
      assert.equal(fake.state.emails.filter((entry) => entry.to[0].address === "paused@reader.example").length, 0, "events received while paused are not replayed later");
      assert.equal((await client.marketingTriggerEvent.findFirst({ where: { contactId: paused.id } })).status, "IGNORED");

      // Product events: approved registry only; payload minimised.
      const automations = harness.mail.services.automations;
      await assert.rejects(automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "healthnet.patient.diagnosis", eventId: "e1", contactEmail: "x@y.example" }), (error) => error.code === "MAIL_INTEGRATION_FORBIDDEN_CONTENT");
      const ingested = await automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "karryam.booking.completed", version: 1, eventId: "bk-1", contactEmail: "WELCOME@reader.example", payload: { service: "ride", city: "Lagos", cardNumber: "4111", notes: "<script>" } });
      assert.equal(ingested.matchedContact, true);
      assert.deepEqual(ingested.droppedFields.sort(), ["cardNumber", "notes"]);
      const stored = await client.marketingTriggerEvent.findFirst({ where: { eventId: "bk-1" } });
      assert.deepEqual(stored.payload, { service: "ride", city: "Lagos" });
      assert.equal((await automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "karryam.booking.completed", version: 1, eventId: "bk-1", contactEmail: "welcome@reader.example" })).duplicate, true);

      // Ambiguous automation send: retried with the same key; outside the window it becomes unknown.
      const product = await call("dave", "POST", `${mbase}/automations`, { name: "Booking thanks", triggerType: "PRODUCT_EVENT", frequencyCapHours: 0, enrollmentLimit: 5 });
      const draft = await call("dave", "PUT", `${mbase}/automations/${product.body.data.id}/draft`, { definition: { topic: "newsletter", steps: [{ id: "thanks", type: "send_email", templateVersionId, senderAddressId: cf.sender.id }] }, triggerConfig: { eventType: "karryam.booking.completed", version: 1 } });
      assert.equal(draft.status, 200, draft.text);
      await call("dave", "POST", `${mbase}/automations/${product.body.data.id}/versions/${draft.body.data.id}/submit`);
      await call("erin", "POST", `${mbase}/automations/${product.body.data.id}/versions/${draft.body.data.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_PUBLISH") });
      await call("erin", "POST", `${mbase}/automations/${product.body.data.id}/activate`);
      const buyer = await newContact("buyer@reader.example");
      await work(2, 61000); // the welcome automation's own send happens first
      fake.failNext("sendEmail", "AMBIGUOUS", "PROVIDER_TIMEOUT", { acceptBeforeFailing: true });
      await automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "karryam.booking.completed", version: 1, eventId: "bk-2", contactEmail: buyer.email, payload: { service: "ride" } });
      await work(6, 61000);
      const buyerSends = fake.state.emails.filter((entry) => entry.to[0].address === "buyer@reader.example" && entry.idempotencyKey.startsWith("auto:") && entry.subject.startsWith("News for"));
      assert.equal(buyerSends.length, 1, "retry reused the idempotency key");
      const run = await client.marketingAutomationStepRun.findFirst({ where: { recipientEmail: "buyer@reader.example", stepType: "send_email", enrollment: { automationId: product.body.data.id } } });
      assert.equal(run.status, "SUCCEEDED");
      // Outside the 23h window: unknown, not retried.
      const late = await newContact("late-buyer@reader.example");
      await work(2, 61000);
      for (let index = 0; index < 3; index += 1) fake.failNext("sendEmail", "AMBIGUOUS", "PROVIDER_TIMEOUT");
      await automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "karryam.booking.completed", version: 1, eventId: "bk-3", contactEmail: late.email });
      await work(2, 61000);
      harness.advance(24 * 3600000);
      await work(3, 3600000);
      const lateRun = await client.marketingAutomationStepRun.findFirst({ where: { recipientEmail: "late-buyer@reader.example", enrollment: { automationId: product.body.data.id } } });
      assert.equal(lateRun.status, "OUTCOME_UNKNOWN", JSON.stringify(lateRun));
      assert.equal((await client.marketingAutomationEnrollment.findUnique({ where: { id: lateRun.enrollmentId } })).exitReason, "OUTCOME_UNKNOWN");
      fake.state.failures.length = 0;

      // Cross-brand: kim cannot read or act on cosmicforge automations.
      assert.equal((await call("kim", "GET", `${mbase}/automations/${welcomeId}`)).status, 404);
      assert.equal((await call("kim", "POST", `${mbase}/automations/${welcomeId}/pause`)).status, 404);
    });

    await t.test("automation: scheduled newsletter enrolls the audience once per occurrence", async () => {
      const audience = await call("dave", "POST", `${mbase}/audiences`, { name: "Weekly", topic: "newsletter" });
      const subscribers = [await newContact("w1@reader.example"), await newContact("w2@reader.example")];
      await call("dave", "POST", `${mbase}/audiences/${audience.body.data.id}/contacts`, { contactIds: subscribers.map((contact) => contact.id) });
      const weekly = await call("dave", "POST", `${mbase}/automations`, { name: "Weekly digest", triggerType: "SCHEDULE", frequencyCapHours: 0 });
      const weekday = new Date(harness.clock().getTime() + 86400000).getUTCDay();
      const draft = await call("dave", "PUT", `${mbase}/automations/${weekly.body.data.id}/draft`, { definition: { topic: "newsletter", steps: [{ id: "digest", type: "send_email", templateVersionId, senderAddressId: cf.sender.id }] }, triggerConfig: { frequency: "weekly", weekday, localTime: "07:00", timeZone: "UTC", audienceId: audience.body.data.id } });
      assert.equal(draft.status, 200, draft.text);
      await call("dave", "POST", `${mbase}/automations/${weekly.body.data.id}/versions/${draft.body.data.id}/submit`);
      await call("erin", "POST", `${mbase}/automations/${weekly.body.data.id}/versions/${draft.body.data.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_PUBLISH") });
      await call("erin", "POST", `${mbase}/automations/${weekly.body.data.id}/activate`);
      harness.advance(2 * 86400000);
      await work(4, 61000);
      const enrollments = await client.marketingAutomationEnrollment.count({ where: { automationId: weekly.body.data.id } });
      assert.equal(enrollments, 2);
      await work(3, 61000);
      assert.equal(await client.marketingAutomationEnrollment.count({ where: { automationId: weekly.body.data.id } }), 2, "same occurrence never enrolls twice");
    });

    await t.test("double opt-in confirmation email: token never returned, GET landing does not confirm, POST does", async () => {
      const app2 = harness.build({ MAIL_MARKETING_CONFIRMATION_EMAILS_ENABLED: "true" });
      const server2 = await listen(harness.mountApp(app2));
      const call2 = caller(server2.base, ids);
      const created = await call2("dave", "POST", `${mbase}/contacts`, { email: "doi@reader.example", consent: consent("newsletter", { doubleOptIn: true }) });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.body.data.confirmationToken, null, "token is not exposed to admins when emails are on");
      assert.equal(created.body.data.confirmationEmail.queued, true);
      const before = fake.state.emails.length;
      await app2.createWorker({ queues: ["MARKETING"] }).drain();
      const email = fake.state.emails.slice(before).find((entry) => entry.to[0].address === "doi@reader.example");
      assert.ok(email, "confirmation email handed to the provider");
      const link = email.text.match(/Confirm: (\S+)/)[1];
      const path = new URL(link).pathname.replace("/api/mail/v1", "");
      const job = await client.mailOutboxJob.findFirst({ where: { kind: "MARKETING_CONFIRMATION_EMAIL" } });
      assert.ok(!JSON.stringify(job.payload).includes(path.split("/").pop()), "token is sealed in the job payload");
      const landing = await call2(null, "GET", path);
      assert.equal(landing.status, 200);
      const contactId = created.body.data.id;
      assert.equal((await client.marketingConsent.findFirst({ where: { contactId } })).status, "PENDING_CONFIRMATION", "link scanners cannot confirm");
      const confirmed = await call2(null, "POST", path, "");
      assert.equal(confirmed.status, 200, confirmed.text);
      assert.equal((await client.marketingConsent.findFirst({ where: { contactId } })).status, "GRANTED");
      assert.ok(await client.marketingTriggerEvent.findFirst({ where: { contactId, eventType: "consent.granted" } }));
      assert.equal((await call2(null, "POST", path, "")).status, 404, "single use");
      await closeServer(server2.server);
    });

    await t.test("public unsubscribe: tampered and cross-brand tokens are rejected; one-click works", async () => {
      const contact = await newContact("oneclick@reader.example");
      const secret = harness.environment.MAIL_MARKETING_UNSUBSCRIBE_SECRET;
      const good = signUnsubscribeToken({ organizationId: cf.organization.id, contactId: contact.id, topic: "newsletter" }, secret);
      const tampered = `${good.slice(0, -2)}xx`;
      assert.equal((await call(null, "GET", `/public/unsubscribe/${tampered}`)).status, 404);
      const crossBrand = signUnsubscribeToken({ organizationId: kg.organization.id, contactId: contact.id, topic: "newsletter" }, secret);
      assert.equal((await call(null, "POST", `/public/unsubscribe/${crossBrand}`, "scope=all")).status, 404);
      const wrongSecret = signUnsubscribeToken({ organizationId: cf.organization.id, contactId: contact.id, topic: "newsletter" }, crypto.randomBytes(32).toString("hex"));
      assert.equal((await call(null, "GET", `/public/unsubscribe/${wrongSecret}`)).status, 404);
      const oneClick = await call(null, "POST", `/public/unsubscribe/${good}`, "List-Unsubscribe=One-Click");
      assert.equal(oneClick.status, 200, oneClick.text);
      assert.equal((await client.marketingConsent.findFirst({ where: { contactId: contact.id, topic: "newsletter" } })).status, "WITHDRAWN");
      assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MARKETING_ONE_CLICK_UNSUBSCRIBE", targetId: contact.id } }));
    });
  } finally {
    await closeServer(server);
    await db.close();
  }
});
