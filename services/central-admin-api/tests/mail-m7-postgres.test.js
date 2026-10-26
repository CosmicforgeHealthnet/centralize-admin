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
      const again = await call("erin", "POST", `${mbase}/campaigns/${c1.id}/cancel`, {});
      assert.equal(again.status, 200, "a repeated cancel is idempotent");
      assert.equal(again.body.data.status, "CANCELLED");

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
      // The automation's 24 h frequency cap includes its own first email: the
      // follow-up waits until 24 h after the welcome.
      assert.equal(fake.state.emails.slice(before + 1).filter((entry) => entry.to[0].address === "welcome@reader.example").length, 0, "follow-up held by the frequency cap");
      assert.equal((await client.marketingAutomationEnrollment.findUnique({ where: { id: enrollment.id } })).status, "WAITING");
      harness.advance(24 * 3600000);
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
      // Provider quota exhausted: the step is held until the reset, never failed.
      const quotaBuyer = await newContact("quota-buyer@reader.example");
      await work(2, 61000);
      fake.failNext("sendEmail", "QUOTA_EXHAUSTED", "DAILY", { now: harness.clock() });
      await automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "karryam.booking.completed", version: 1, eventId: "bk-4", contactEmail: quotaBuyer.email });
      await work(2, 61000);
      const heldJob = await client.mailOutboxJob.findFirst({ where: { kind: "AUTOMATION_STEP", lastErrorCode: "PROVIDER_QUOTA_EXHAUSTED" } });
      assert.ok(heldJob, "automation step deferred for the quota reset");
      assert.equal(heldJob.status, "RETRY_SCHEDULED");
      const heldRun = await client.marketingAutomationStepRun.findFirst({ where: { recipientEmail: "quota-buyer@reader.example", stepType: "send_email", enrollment: { automationId: product.body.data.id } } });
      assert.notEqual(heldRun?.status, "FAILED");
      harness.advance(25 * 3600000);
      await work(3, 61000);
      const sentRun = await client.marketingAutomationStepRun.findFirst({ where: { recipientEmail: "quota-buyer@reader.example", stepType: "send_email", enrollment: { automationId: product.body.data.id } } });
      assert.equal(sentRun.status, "SUCCEEDED", JSON.stringify(sentRun));

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
    await t.test("closure: campaign test sends reach active staff only, are flag-gated, rate-limited and audited; brand webhook secrets rotate", async () => {
      const draft = await call("dave", "POST", `${mbase}/campaigns`, { name: "Test-send draft", topic: "newsletter", templateVersionId, senderAddressId: cf.sender.id });
      assert.equal(draft.status, 201, draft.text);
      const path = `${mbase}/campaigns/${draft.body.data.id}/test-send`;
      assert.equal((await call("dave", "POST", path, {})).body.code, "MAIL_TEST_SEND_DISABLED", "off unless MAIL_MARKETING_TEST_SENDS_ENABLED");

      const app2 = harness.build({ MAIL_MARKETING_TEST_SENDS_ENABLED: "true", MAIL_MARKETING_TEST_SENDS_PER_HOUR: "3" });
      const server2 = await listen(harness.mountApp(app2));
      const call2 = caller(server2.base, ids);
      try {
        const external = await call2("dave", "POST", path, { recipients: ["ada@reader.example"] });
        assert.equal(external.status, 400);
        assert.equal(external.body.errors[0].reason, "TEST_RECIPIENT_NOT_STAFF", "customers and external addresses are never test recipients");
        const many = await call2("dave", "POST", path, { recipients: ["a@staff.example.invalid", "b@staff.example.invalid", "c@staff.example.invalid", "d@staff.example.invalid", "e@staff.example.invalid", "f@staff.example.invalid"] });
        assert.equal(many.body.errors[0].reason, "TOO_MANY_RECIPIENTS");
        assert.equal((await call2("kim", "POST", path, {})).status, 404, "another brand's marketer cannot see the campaign");
        assert.equal((await call2("erin", "POST", path, {})).status, 403, "approvers without author rights cannot test-send");

        const before = fake.state.emails.length;
        const queued = await call2("dave", "POST", path, { recipients: ["dave@staff.example.invalid", "erin@staff.example.invalid"] });
        assert.equal(queued.status, 202, queued.text);
        assert.equal(queued.body.data.recipientCount, 2);
        await app2.createWorker({ queues: ["MARKETING"] }).drain();
        const sent = fake.state.emails.slice(before);
        assert.deepEqual(sent.map((email) => email.to[0].address).sort(), ["dave@staff.example.invalid", "erin@staff.example.invalid"]);
        assert.ok(sent.every((email) => email.subject.startsWith("[TEST] ") && email.headers["X-CosmicForge-Test-Send"] === "1" && email.to.length === 1 && email.from.address === cf.sender.address));
        assert.match(sent[0].html, /Ada/, "rendered with sample data, not a real contact");
        assert.equal(await client.marketingBroadcastRecipient.count({ where: { email: { in: ["dave@staff.example.invalid", "erin@staff.example.invalid"] } } }), 0, "test sends never touch broadcast records");
        assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MARKETING_TEST_SEND_HANDED_TO_PROVIDER", targetId: draft.body.data.id } }));

        assert.equal((await call2("dave", "POST", path, {})).status, 202, "defaults to the requester's own address");
        harness.advance(61000);
        assert.equal((await call2("dave", "POST", path, {})).status, 202);
        harness.advance(61000);
        const limited = await call2("dave", "POST", path, {});
        assert.equal(limited.status, 429, "per-campaign hourly limit");

        // Emergency stop holds test sends too.
        const halted = harness.build({ MAIL_MARKETING_TEST_SENDS_ENABLED: "true", MAIL_EMERGENCY_STOP_MARKETING: "true" });
        await assert.rejects(halted.services.testSends.requestTestSend(await client.adminUser.findUnique({ where: { id: ids.dave } }), cf.organization.id, draft.body.data.id, {}), (error) => error.code === "MAIL_EMERGENCY_STOP");
      } finally {
        await closeServer(server2.server);
      }

      // Spec §19.3: a brand's previous webhook secret is accepted only while configured.
      const previous = BRAND_WEBHOOK_SECRETS.cosmicforge;
      const rotated = `whsec_${crypto.randomBytes(24).toString("base64")}`;
      const app3 = harness.build({ RESEND_WEBHOOK_SECRET__COSMICFORGE: rotated, RESEND_WEBHOOK_SECRET__COSMICFORGE_PREVIOUS: previous });
      const server3 = await listen(harness.mountApp(app3));
      const app4 = harness.build({ RESEND_WEBHOOK_SECRET__COSMICFORGE: rotated });
      const server4 = await listen(harness.mountApp(app4));
      try {
        const event = { id: "ct_rot", email: "nobody@reader.example", unsubscribed: false };
        const opts = (secret) => ({ path: "/webhooks/resend/brand/cosmicforge", secret });
        assert.equal((await postWebhook(server3.base, harness.clock, "contact.updated", event, opts(rotated))).status, 200);
        assert.equal((await postWebhook(server3.base, harness.clock, "contact.updated", event, opts(previous))).status, 200, "grace period");
        assert.equal((await postWebhook(server4.base, harness.clock, "contact.updated", event, opts(previous))).status, 401, "after the previous secret is removed");
        assert.equal((await postWebhook(server3.base, harness.clock, "contact.updated", event, opts(BRAND_WEBHOOK_SECRETS.karryam))).status, 401, "another brand's secret never verifies");
      } finally {
        await closeServer(server3.server);
        await closeServer(server4.server);
      }
    });

    await t.test("concurrent provider events never regress a recipient's status", async () => {
      const recipient = await client.marketingBroadcastRecipient.findFirst({ where: { email: "ada@reader.example", dispatch: { providerBroadcastId: { not: null } } }, include: { dispatch: true } });
      assert.ok(recipient, "pilot recipient exists");
      const event = (type) => ({ eventType: type, receivedAt: harness.clock(), payload: { created_at: harness.clock().toISOString(), data: { email_id: "bc_race", broadcast_id: recipient.dispatch.providerBroadcastId, to: [recipient.email] } } });
      const router = harness.mail.processors.marketingEvents;
      for (let round = 0; round < 10; round += 1) {
        await client.marketingBroadcastRecipient.update({ where: { id: recipient.id }, data: { status: "PROVIDER_ACCEPTED" } });
        await Promise.all([router.route(event("email.sent")), router.route(event("email.delivered")), router.route(event("email.sent"))]);
        assert.equal((await client.marketingBroadcastRecipient.findUnique({ where: { id: recipient.id } })).status, "DELIVERED", `round ${round}`);
      }
    });
  } finally {
    await closeServer(server);
    await db.close();
  }
});

// Audit fixes D1-D20 (marketing email + automation), each with a regression
// test on a fresh database.
test("CosmicForge Mail marketing audit fixes on real PostgreSQL", { timeout: 600000 }, async (t) => {
  const { TOTP_SECRET } = require("./helpers/mail-test-harness");
  const { decodeBase32, encryptSecret } = require("../src/shared/auth/mfa-core");
  const { createBroadcastProcessor } = require("../src/modules/mail/marketing/broadcast.processor");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client);
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const { server, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  const cf = brands.cosmicforge;
  const org = cf.organization.id;
  const mbase = `/marketing/${org}`;
  const fake = harness.marketingAdapter;
  const marketing = harness.mail.services.marketing;
  const worker = harness.mail.createWorker({ queues: ["MARKETING", "EVENTS"] });
  const work = async (rounds = 6, stepMs = 2000) => {
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
  const userOf = (key) => client.adminUser.findUnique({ where: { id: ids[key] } });
  // Extra staff: gil authors AND approves for the brand, hal only authors.
  const addUser = async (key, sections) => {
    const id = crypto.randomUUID();
    ids[key] = id;
    await client.adminUser.create({ data: { id, email: `${key}@staff.example.invalid`, password: "test-only-hash", name: key, tier: "EMPLOYEE", status: "ACTIVE", mustChangePassword: false } });
    await client.adminMfaEnrollment.create({ data: { adminUserId: id, enrolledAt: new Date(harness.clock().getTime() - 86400000), secretEncrypted: encryptSecret(decodeBase32(TOTP_SECRET), id), updatedAt: new Date() } });
    const session = await client.adminSession.create({ data: { id: crypto.randomUUID(), adminUserId: id, mode: "dual", authMethod: "PASSWORD", csrfNonce: "n", idleExpiresAt: new Date(harness.clock().getTime() + 3650 * 86400000), absoluteExpiresAt: new Date(harness.clock().getTime() + 3650 * 86400000) } });
    harness.state.sessions.set(id, session.id);
    for (const section of sections) await client.adminSectionGrant.create({ data: { adminUserId: id, module: "mail-marketing", section, mode: "EDIT", grantedBy: ids.super } });
  };
  await addUser("gil", ["cosmicforge", "approve:cosmicforge"]);
  await addUser("hal", ["cosmicforge"]);

  const consent = (topic = "newsletter", extra = {}) => ({ topic, source: "WEB_FORM", policyVersion: "2026-10", evidence: { reference: `form-${crypto.randomUUID().slice(0, 8)}` }, ...extra });
  const newContact = async (email, topic = "newsletter", extra = {}) => {
    const response = await call("dave", "POST", `${mbase}/contacts`, { email, firstName: email.split("@")[0], consent: consent(topic, extra) });
    assert.equal(response.status, 201, response.text);
    return response.body.data;
  };
  const newVersion = async (key, name, blocks = [{ type: "heading", text: "Hello {{first_name}}" }, { type: "text", text: "News." }]) => {
    const template = await call(key, "POST", `${mbase}/templates`, { name });
    assert.equal(template.status, 201, template.text);
    const version = await call(key, "POST", `${mbase}/templates/${template.body.data.id}/versions`, { subject: `${name} for {{first_name}}`, blocks });
    assert.equal(version.status, 201, version.text);
    return version.body.data.id;
  };
  const audienceWith = async (name, contacts) => {
    const audience = await call("dave", "POST", `${mbase}/audiences`, { name, topic: "newsletter" });
    await call("dave", "POST", `${mbase}/audiences/${audience.body.data.id}/contacts`, { contactIds: contacts.map((contact) => contact.id) });
    return audience.body.data.id;
  };
  const draftCampaign = async (name, audienceId, extra = {}) => {
    const response = await call("dave", "POST", `${mbase}/campaigns`, { name, topic: "newsletter", templateVersionId: state.templateVersionId, audienceId, senderAddressId: cf.sender.id, frequencyCapHours: 0, ...extra });
    assert.equal(response.status, 201, response.text);
    return response.body.data;
  };
  const preflight = async (campaignId) => (await call("erin", "POST", `${mbase}/campaigns/${campaignId}/preflight`)).body.data;
  const approve = async (campaignId, revision, extra = {}, key = "erin") => {
    const seen = await preflight(campaignId);
    return call(key, "POST", `${mbase}/campaigns/${campaignId}/approve`, { revision, stepUpId: await stepUp(key, "MARKETING_CAMPAIGN_APPROVAL"), contactSetSha256: seen.contactSetSha256, eligibleCount: seen.eligibleCount, ...extra });
  };
  const publishAutomation = async (name, triggerType, definition, triggerConfig, extra = {}) => {
    const created = await call("dave", "POST", `${mbase}/automations`, { name, triggerType, frequencyCapHours: 0, ...extra });
    assert.equal(created.status, 201, created.text);
    const draft = await call("dave", "PUT", `${mbase}/automations/${created.body.data.id}/draft`, { definition, triggerConfig });
    assert.equal(draft.status, 200, draft.text);
    const submitted = await call("dave", "POST", `${mbase}/automations/${created.body.data.id}/versions/${draft.body.data.id}/submit`);
    assert.equal(submitted.status, 200, submitted.text);
    const published = await call("erin", "POST", `${mbase}/automations/${created.body.data.id}/versions/${draft.body.data.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_PUBLISH") });
    assert.equal(published.status, 200, published.text);
    assert.equal((await call("erin", "POST", `${mbase}/automations/${created.body.data.id}/activate`)).status, 200);
    return created.body.data.id;
  };
  const state = {};

  try {
    await t.test("D17: each claim has its own lease token; a stale run cannot complete or extend a newer lease", async () => {
      const jobs = harness.mail.jobs;
      await jobs.enqueue(null, { queue: "MARKETING", kind: "LEASE_PROBE", idempotencyKey: `lease:${crypto.randomUUID()}` });
      const [first] = await jobs.claim({ queues: ["MARKETING"], leaseOwner: "worker-a", leaseSeconds: 30 });
      assert.ok(first.leaseOwner.startsWith("worker-a:"));
      harness.advance(31000);
      await jobs.recoverExpiredLeases();
      const [second] = await jobs.claim({ queues: ["MARKETING"], leaseOwner: "worker-a", leaseSeconds: 30 });
      assert.equal(second.id, first.id);
      assert.notEqual(second.leaseOwner, first.leaseOwner, "same worker, new lease token");
      assert.equal(await jobs.complete(first), false, "the stale run cannot close the newer lease");
      assert.equal(await jobs.heartbeat(first, { leaseSeconds: 60 }), false);
      assert.equal(await jobs.heartbeat(second, { leaseSeconds: 60 }), true);
      const extended = await client.mailOutboxJob.findUnique({ where: { id: second.id } });
      assert.ok(extended.leaseExpiresAt.getTime() >= harness.clock().getTime() + 59000, "heartbeat extends the lease");
      assert.equal(await jobs.complete(second), true);
    });

    await t.test("setup: brand template version", async () => {
      state.templateVersionId = await newVersion("dave", "Fixes newsletter");
    });

    await t.test("D9/D9b/D19: personal aliases are never brand senders; Reply-To needs a shared mailbox; legacy links are validated", async () => {
      const personalBox = await client.mailMailbox.create({ data: { organizationId: org, type: "PERSONAL", purpose: "GENERAL", name: "Dave personal", ownerAdminUserId: ids.dave } });
      const primary = await client.mailAddress.create({ data: { organizationId: org, domainId: cf.domain.id, mailboxId: personalBox.id, localPart: "dave.p", address: "dave.p@cosmicforge.example", kind: "PRIMARY", status: "ACTIVE" } });
      state.alias = await client.mailAddress.create({ data: { organizationId: org, domainId: cf.domain.id, mailboxId: personalBox.id, localPart: "deals", address: "deals@cosmicforge.example", kind: "ALIAS", aliasOfAddressId: primary.id, status: "ACTIVE" } });
      state.system = await client.mailAddress.create({ data: { organizationId: org, domainId: cf.domain.id, mailboxId: null, localPart: "noreply", address: "noreply@cosmicforge.example", kind: "SYSTEM", status: "ACTIVE" } });
      const identities = (await call("dave", "GET", `${mbase}/sender-identities`)).body.data.map((row) => row.address);
      assert.ok(identities.includes("news@cosmicforge.example") && identities.includes("noreply@cosmicforge.example"));
      assert.ok(!identities.includes("deals@cosmicforge.example"), "an alias on a personal mailbox is not offered");

      const contact = await newContact("reply@reader.example");
      const audienceId = await audienceWith("Reply audience", [contact]);
      const aliasCampaign = await draftCampaign("Alias sender", audienceId, { senderAddressId: state.alias.id });
      assert.equal((await preflight(aliasCampaign.id)).checks.find((check) => check.id === "sender_identity").ok, false, "campaign sender");
      assert.equal((await call("erin", "PATCH", `${mbase}/settings`, { confirmationSenderAddressId: state.alias.id })).status, 400, "confirmation sender");
      const aliasDraft = await call("dave", "POST", `${mbase}/automations`, { name: "Alias automation", triggerType: "CONSENT_GRANTED" });
      const aliasSave = await call("dave", "PUT", `${mbase}/automations/${aliasDraft.body.data.id}/draft`, { definition: { topic: "newsletter", steps: [{ id: "a", type: "send_email", templateVersionId: state.templateVersionId, senderAddressId: state.alias.id }] }, triggerConfig: { topic: "newsletter" } });
      assert.equal(aliasSave.status, 400, "automation sender");
      assert.equal(aliasSave.body.errors[0].errors[0].detail, "PERSONAL_MAILBOX_SENDER");

      let campaign = await draftCampaign("Reply-To policy", audienceId);
      const replyCheck = async (replyTo) => {
        const patched = await call("dave", "PATCH", `${mbase}/campaigns/${campaign.id}`, { revision: campaign.revision, replyTo });
        assert.equal(patched.status, 200, patched.text);
        campaign = patched.body.data;
        return (await preflight(campaign.id)).checks.find((check) => check.id === "reply_to_policy");
      };
      assert.equal((await replyCheck("nobody@cosmicforge.example")).ok, false, "brand domain alone is not enough");
      assert.equal((await replyCheck("deals@cosmicforge.example")).ok, false, "a person's alias is not a team inbox");
      assert.equal((await replyCheck("noreply@cosmicforge.example")).ok, false, "a system address has no mailbox");
      assert.equal((await replyCheck("news@cosmicforge.example")).ok, true, "shared mailbox");

      const badFormat = await call("dave", "POST", `${mbase}/campaigns`, { name: "Legacy bad", topic: "newsletter", legacyCampaignId: "not-a-uuid" });
      assert.equal(badFormat.status, 422, badFormat.text);
      assert.equal((await call("dave", "POST", `${mbase}/campaigns`, { name: "Legacy missing", topic: "newsletter", legacyCampaignId: crypto.randomUUID() })).status, 422);
      const legacy = await client.marketing_campaigns.create({ data: { title: "Legacy autumn", type: "Email" } });
      const linked = await call("dave", "POST", `${mbase}/campaigns`, { name: "Legacy linked", topic: "newsletter", legacyCampaignId: legacy.id });
      assert.equal(linked.status, 201, linked.text);
      assert.equal((await call("dave", "PATCH", `${mbase}/campaigns/${linked.body.data.id}`, { revision: 1, legacyCampaignId: "x'; drop" })).status, 422, "updates are validated too");

      const event = await client.marketing_notification_events.create({ data: { eventCode: "LEG1", event: "Legacy event" } });
      await client.marketing_email_templates.create({ data: { eventId: event.id, validFrom: new Date("2026-01-01"), validTo: new Date("2027-01-01"), language: "en" } });
      assert.deepEqual((await call("dave", "GET", `${mbase}/legacy-templates`)).body.data, [], "legacy rows have no brand: hidden without the legacy section");
      await client.adminSectionGrant.create({ data: { adminUserId: ids.dave, module: "marketing", section: "content", mode: "VIEW", grantedBy: ids.super } });
      assert.equal((await call("dave", "GET", `${mbase}/legacy-templates`)).body.data.length, 1);
    });

    await t.test("D5/D6/D7: reviewer separation covers template authors and intermediate editors; approval binds the audience; reject starts a new revision", async () => {
      const contacts = [await newContact("r1@reader.example"), await newContact("r2@reader.example")];
      const audienceId = await audienceWith("Review audience", contacts);

      // Template authored by the would-be approver.
      const gilVersion = await newVersion("gil", "Gil template");
      const byTemplate = await draftCampaign("Gil template campaign", audienceId, { templateVersionId: gilVersion });
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${byTemplate.id}/submit`, { revision: 1 })).status, 200);
      const refused = await approve(byTemplate.id, 1, {}, "gil");
      assert.equal(refused.status, 403, refused.text);
      assert.equal(refused.body.errors[0].reason, "REVIEWER_AUTHORED_TEMPLATE_VERSION");

      // gil edits, hal saves last, dave submits: gil is still an author.
      const edited = await draftCampaign("Edited campaign", audienceId);
      assert.equal((await call("gil", "PATCH", `${mbase}/campaigns/${edited.id}`, { revision: 1, subjectOverride: "Gil's subject" })).status, 200);
      assert.equal((await call("hal", "PATCH", `${mbase}/campaigns/${edited.id}`, { revision: 2, subjectOverride: "Hal's subject" })).status, 200);
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${edited.id}/submit`, { revision: 3 })).status, 200);
      const byEditor = await approve(edited.id, 3, {}, "gil");
      assert.equal(byEditor.status, 403, byEditor.text);
      assert.equal(byEditor.body.errors[0].reason, "REVIEWER_EDITED_CAMPAIGN");
      assert.equal((await approve(edited.id, 3)).status, 200, "an uninvolved approver may approve");

      // Audience binding.
      const bound = await draftCampaign("Bound audience", audienceId);
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${bound.id}/submit`, { revision: 1 })).status, 200);
      const seen = await preflight(bound.id);
      assert.match(seen.contactSetSha256, /^[0-9a-f]{64}$/);
      const late = await newContact("r3@reader.example");
      await call("dave", "POST", `${mbase}/audiences/${audienceId}/contacts`, { contactIds: [late.id] });
      const stepUpId = await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL");
      const stale = await call("erin", "POST", `${mbase}/campaigns/${bound.id}/approve`, { revision: 1, stepUpId, contactSetSha256: seen.contactSetSha256, eligibleCount: seen.eligibleCount });
      assert.equal(stale.status, 409, stale.text);
      assert.equal(stale.body.errors[0].reason, "AUDIENCE_CHANGED_SINCE_REVIEW");
      assert.equal(stale.body.errors[0].eligibleCount, 3);
      const implicit = await call("erin", "POST", `${mbase}/campaigns/${bound.id}/approve`, { revision: 1, stepUpId });
      assert.equal(implicit.body.errors[0].reason, "AUDIENCE_CHANGED_SINCE_SUBMISSION", "without an explicit set the submitted audience is binding");
      const reviewed = await approve(bound.id, 1);
      assert.equal(reviewed.status, 200, reviewed.text);
      const approvedEvent = await client.mailAuditEvent.findFirst({ where: { action: "MARKETING_CAMPAIGN_APPROVED", targetId: bound.id } });
      assert.equal(approvedEvent.metadata.eligibleCount, 3);
      assert.equal(approvedEvent.metadata.audienceConfirmedByReviewer, true);
      assert.match(approvedEvent.metadata.contactSetSha256, /^[0-9a-f]{64}$/);

      // Reject bumps the revision; an unchanged resubmission is snapshotted again.
      const rejected = await draftCampaign("Rejected campaign", audienceId);
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${rejected.id}/submit`, { revision: 1 })).status, 200);
      const rejection = await call("erin", "POST", `${mbase}/campaigns/${rejected.id}/reject`, { revision: 1, comment: "Not this week" });
      assert.equal(rejection.status, 200, rejection.text);
      assert.equal(rejection.body.data.status, "REJECTED");
      assert.equal(rejection.body.data.revision, 2);
      assert.equal((await call("erin", "POST", `${mbase}/campaigns/${rejected.id}/reject`, { revision: 1, comment: "again" })).status, 409, "stale reject");
      const extra = await newContact("r4@reader.example");
      await call("dave", "POST", `${mbase}/audiences/${audienceId}/contacts`, { contactIds: [extra.id] });
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${rejected.id}/submit`, { revision: 2 })).status, 200);
      const snapshots = await client.marketingCampaignSnapshot.findMany({ where: { campaignId: rejected.id, kind: "SUBMISSION" }, orderBy: { revision: "asc" } });
      assert.deepEqual(snapshots.map((row) => [row.revision, row.eligibleCount]), [[1, 3], [2, 4]], "fresh submission snapshot for the current audience");
      assert.equal((await call("erin", "POST", `${mbase}/campaigns/${rejected.id}/approve`, { revision: 2, stepUpId: await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL") })).status, 200);
    });

    await t.test("D20/D3/D4: withdrawn consent needs double opt-in; CSV import is previewed, approved by a second person, never upgrades consent and never triggers welcomes", async () => {
      const withdrawn = await newContact("w20@reader.example");
      await call("dave", "POST", `${mbase}/contacts/${withdrawn.id}/consents/newsletter/withdraw`, { source: "admin" });
      const regrant = await call("dave", "POST", `${mbase}/contacts/${withdrawn.id}/consents`, consent());
      assert.equal(regrant.status, 400, regrant.text);
      assert.equal(regrant.body.errors[0].reason, "WITHDRAWN_CONSENT_REQUIRES_DOUBLE_OPT_IN");
      const doi = await call("dave", "POST", `${mbase}/contacts/${withdrawn.id}/consents`, consent("newsletter", { doubleOptIn: true }));
      assert.equal(doi.status, 201, doi.text);
      assert.equal(doi.body.data.status, "PENDING_CONFIRMATION", "only the contact's confirmation re-grants");

      // An active welcome automation must not fire for imported consents.
      const welcomeId = await publishAutomation("NL welcome", "CONSENT_GRANTED", { topic: "newsletter", steps: [{ id: "hi", type: "send_email", templateVersionId: state.templateVersionId, senderAddressId: cf.sender.id }] }, { topic: "newsletter" });
      const pending = await newContact("pend@reader.example", "newsletter", { doubleOptIn: true });
      const gone = await newContact("gone@reader.example");
      await call("dave", "POST", `${mbase}/contacts/${gone.id}/consents/newsletter/withdraw`, {});
      await newContact("supp@reader.example");
      await call("dave", "POST", `${mbase}/suppressions`, { email: "supp@reader.example", reason: "MANUAL" });
      const buffer = Buffer.from("email,first_name\nfresh@reader.example,Fresh\npend@reader.example,P\ngone@reader.example,G\nsupp@reader.example,S\nnot-an-email,X\n");
      const input = { buffer, topic: "newsletter", source: "IMPORT", policyVersion: "2026-10", evidenceReference: "crm-export-2026-10", attestOptIn: "true", fileName: "crm.csv" };
      const sha = crypto.createHash("sha256").update(buffer).digest("hex");
      const [dave, erin, gil] = [await userOf("dave"), await userOf("erin"), await userOf("gil")];

      const preview = await marketing.importCsv(dave, org, input, {});
      assert.equal(preview.dryRun, true);
      assert.equal(preview.fileSha256, sha);
      assert.deepEqual(preview.counts, { new: 1, updated: 1, skippedWithdrawn: 1, skippedPendingConfirmation: 1, suppressed: 1, invalid: 1, duplicateInFile: 0 });
      assert.equal(await client.marketingContact.count({ where: { organizationId: org, email: "fresh@reader.example" } }), 0, "a preview writes nothing");
      const code = (expected) => (error) => error.errors?.[0]?.code === expected || error.code === expected;
      await assert.rejects(marketing.importCsv(dave, org, { ...input, mode: "commit", fileSha256: sha }, {}), code("MAIL_FORBIDDEN"), "authors cannot commit");
      await assert.rejects(marketing.importCsv(erin, org, { ...input, mode: "commit", fileSha256: "0".repeat(64) }, {}), code("MAIL_VALIDATION_FAILED"), "fingerprint must match");
      await assert.rejects(marketing.importCsv(erin, org, { ...input, policyVersion: "2026-11", mode: "commit", fileSha256: sha }, {}), code("MAIL_INVALID_TRANSITION"), "parameters must match the preview");
      const committed = await marketing.importCsv(erin, org, { ...input, mode: "commit", fileSha256: sha }, {});
      assert.equal(committed.created, 1);
      await assert.rejects(marketing.importCsv(erin, org, { ...input, mode: "commit", fileSha256: sha }, {}), code("MAIL_INVALID_TRANSITION"), "single use");

      const fresh = await client.marketingContact.findUnique({ where: { organizationId_email: { organizationId: org, email: "fresh@reader.example" } }, include: { consents: true } });
      assert.equal(fresh.consents[0].status, "GRANTED");
      assert.equal(fresh.consents[0].consentedAt, null, "unknown consent time is not invented");
      assert.equal(fresh.consents[0].sourceEvidence.importFileSha256, sha);
      assert.equal(fresh.consents[0].sourceEvidence.importFileName, "crm.csv");
      assert.equal(fresh.consents[0].sourceEvidence.importApprovedBy, ids.erin);
      assert.equal((await client.marketingConsent.findFirst({ where: { contactId: pending.id } })).status, "PENDING_CONFIRMATION", "never upgraded by import");
      assert.equal((await client.marketingConsent.findFirst({ where: { contactId: gone.id } })).status, "WITHDRAWN");
      const trigger = await client.marketingTriggerEvent.findFirst({ where: { contactId: fresh.id } });
      assert.equal(trigger.status, "IGNORED");
      assert.equal(trigger.payload.origin, "IMPORT");
      await harness.mail.processors.automations.processTriggerEvents();
      assert.equal(await client.marketingAutomationEnrollment.count({ where: { automationId: welcomeId, contactId: fresh.id } }), 0, "imports never enroll welcome flows");

      // The previewer can never approve their own upload.
      const other = Buffer.from("email\nself@reader.example\n");
      await marketing.importCsv(gil, org, { ...input, buffer: other }, {});
      await assert.rejects(marketing.importCsv(gil, org, { ...input, buffer: other, mode: "commit", fileSha256: crypto.createHash("sha256").update(other).digest("hex") }, {}), code("MAIL_FORBIDDEN"));
      // A preview expires after 24 hours.
      harness.advance(25 * 3600000);
      await assert.rejects(marketing.importCsv(erin, org, { ...input, buffer: other, mode: "commit", fileSha256: crypto.createHash("sha256").update(other).digest("hex") }, {}), code("MAIL_INVALID_TRANSITION"));

      // Over HTTP the default is the preview; mode/fileSha256 are form fields.
      const form = new FormData();
      form.append("file", new Blob(["email\nhttp@reader.example\n"], { type: "text/csv" }), "http.csv");
      for (const [key, value] of Object.entries({ topic: "newsletter", source: "IMPORT", policyVersion: "2026-10", evidenceReference: "crm", attestOptIn: "true" })) form.append(key, value);
      const viaHttp = await fetch(`${base}${mbase}/contacts/import`, { method: "POST", headers: { "x-test-user": ids.dave }, body: form });
      const httpBody = await viaHttp.json();
      assert.equal(viaHttp.status, 200, JSON.stringify(httpBody));
      assert.equal(httpBody.data.dryRun, true);
      assert.equal(await client.marketingContact.count({ where: { organizationId: org, email: "http@reader.example" } }), 0);
      await call("erin", "POST", `${mbase}/automations/${welcomeId}/archive`);
    });

    await t.test("D1/D14/D15/D16/D18: bounce types, complaint, provider suppression, monotonic delivered, early replies, idempotent pause/cancel", async () => {
      const people = [];
      for (const name of ["b1", "b2", "b3", "b4"]) people.push(await newContact(`${name}@reader.example`));
      const audienceId = await audienceWith("Events audience", people);
      const campaign = await draftCampaign("Events", audienceId);
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${campaign.id}/submit`, { revision: 1 })).status, 200);
      assert.equal((await approve(campaign.id, 1)).status, 200);
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${campaign.id}/schedule`, { revision: 1, sendAtUtc: new Date(harness.clock().getTime() + 120000).toISOString() })).status, 201);
      harness.advance(180000);
      await work(6);
      const dispatch = await client.marketingBroadcastDispatch.findUnique({ where: { campaignId: campaign.id } });
      assert.equal(dispatch.status, "SENDING", JSON.stringify(dispatch));
      assert.equal(dispatch.providerSentAt, null, "not finalised yet");

      // D15: a reply that arrives while the broadcast is still sending counts.
      const inboundId = `in_fix_${crypto.randomUUID().slice(0, 8)}`;
      harness.adapter.addInbound(inboundId, { from: { address: "b1@reader.example", name: "B1" }, to: [{ address: cf.sender.address, name: null }], cc: [], envelopeRecipients: [], subject: "Re: Events", html: null, text: "thanks", rfcMessageId: `<${inboundId}@reader.example>`, inReplyTo: "<x@resend.dev>", references: [], receivedAt: harness.clock() });
      await harness.mail.processors.inbound.process({ id: crypto.randomUUID(), payload: { providerEmailId: inboundId, to: [cf.sender.address] }, webhookEventId: null });
      assert.equal(await client.marketingCampaignReply.count({ where: { campaignId: campaign.id } }), 1, "attributed from the recipient's acceptance time");

      const event = (type, email, data = {}) => postWebhook(base, harness.clock, type, { email_id: `bc_${crypto.randomUUID().slice(0, 6)}`, broadcast_id: dispatch.providerBroadcastId, to: [email], ...data });
      await event("email.bounced", "b2@reader.example", { bounce: { type: "Transient", message: "mailbox full" } });
      await event("email.bounced", "b3@reader.example", { bounce: { type: "Permanent", message: "no such user" } });
      await event("email.suppressed", "b4@reader.example");
      await event("email.delivered", "b1@reader.example");
      await work(2);
      const consentOf = async (contact) => (await client.marketingConsent.findFirst({ where: { contactId: contact.id } })).status;
      const suppression = (email) => client.marketingSuppression.findFirst({ where: { organizationId: org, email, liftedAt: null } });
      const contactStatus = async (contact) => (await client.marketingContact.findUnique({ where: { id: contact.id } })).status;
      assert.equal((await client.marketingBroadcastRecipient.findFirst({ where: { dispatchId: dispatch.id, email: "b2@reader.example" } })).status, "BOUNCED");
      assert.equal(await suppression("b2@reader.example"), null, "a soft bounce never suppresses");
      assert.equal(await consentOf(people[1]), "GRANTED", "a soft bounce never touches consent");
      assert.equal(await contactStatus(people[1]), "ACTIVE");
      const hard = await suppression("b3@reader.example");
      assert.equal(hard.reason, "BOUNCED");
      assert.equal(hard.source, "provider_hard_bounce");
      assert.equal(await consentOf(people[2]), "GRANTED", "a hard bounce suppresses the address but is not a withdrawal of consent");
      assert.equal(await contactStatus(people[2]), "BOUNCED");
      const providerSuppressed = await suppression("b4@reader.example");
      assert.equal(providerSuppressed?.source, "provider_suppressed", "provider suppression is mirrored for the brand");
      assert.equal(await contactStatus(people[3]), "SUPPRESSED");
      assert.equal(await consentOf(people[3]), "GRANTED");

      const report = async () => (await call("erin", "GET", `${mbase}/campaigns/${campaign.id}/report`)).body.data;
      assert.equal((await report()).totals.delivered, 1);
      await event("email.complained", "b1@reader.example");
      await work(2);
      const after = await report();
      assert.equal(after.counts.COMPLAINED, 1);
      assert.equal(after.totals.delivered, 1, "delivered never falls when a complaint arrives");
      assert.equal(after.rates.deliveredPercent, 25);
      assert.ok(after.denominators.rates && after.denominators.window.from, "denominator and window labels");
      assert.equal(await consentOf(people[0]), "WITHDRAWN", "a complaint withdraws consent for the brand");
      assert.equal((await suppression("b1@reader.example")).reason, "COMPLAINED");
      const overview = (await call("dave", "GET", `${mbase}/reports/overview`)).body.data;
      assert.ok(overview.subscriptions.subscribed > 0 && overview.subscriptions.optedOut > 0 && overview.subscriptions.denominator);

      // D18: repeated pause / cancel are idempotent.
      const p1 = await newContact("p1@reader.example");
      const pausedCampaign = await draftCampaign("Pause twice", await audienceWith("Pause audience", [p1]));
      await call("dave", "POST", `${mbase}/campaigns/${pausedCampaign.id}/submit`, { revision: 1 });
      assert.equal((await approve(pausedCampaign.id, 1)).status, 200);
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${pausedCampaign.id}/schedule`, { revision: 1, sendAtUtc: new Date(harness.clock().getTime() + 120000).toISOString() })).status, 201);
      for (let index = 0; index < 2; index += 1) {
        const paused = await call("dave", "POST", `${mbase}/campaigns/${pausedCampaign.id}/pause`);
        assert.equal(paused.status, 200, paused.text);
        assert.equal(paused.body.data.status, "PAUSED");
      }
      // A worker that loaded the dispatch before the pause cannot overwrite it.
      const pausedDispatch = await client.marketingBroadcastDispatch.findUnique({ where: { campaignId: pausedCampaign.id } });
      let staleReads = 0;
      const staleClient = new Proxy(client, {
        get(target, prop) {
          const value = target[prop];
          if (prop !== "marketingBroadcastDispatch") return typeof value === "function" ? value.bind(target) : value;
          return new Proxy(value, {
            get(delegate, method) {
              if (method === "findUnique") return async (args) => {
                const row = await delegate.findUnique(args);
                return row && staleReads++ === 0 ? { ...row, status: "SCHEDULED" } : row;
              };
              const member = delegate[method];
              return typeof member === "function" ? member.bind(delegate) : member;
            },
          });
        },
      });
      const racing = createBroadcastProcessor({ client: staleClient, config: harness.mail.config, audit: harness.mail.audit, jobs: harness.mail.jobs, marketingProviders: harness.mail.marketingProviders, eligibility: marketing.eligibleContacts, clock: harness.clock });
      harness.advance(180000);
      const outcome = await racing.processDispatch({ payload: { dispatchId: pausedDispatch.id } });
      assert.equal(outcome.defer?.code, "DISPATCH_STATE_CHANGED");
      assert.equal((await client.marketingBroadcastDispatch.findUnique({ where: { id: pausedDispatch.id } })).status, "PAUSED", "the pause wins");
      for (let index = 0; index < 2; index += 1) {
        const cancelled = await call("dave", "POST", `${mbase}/campaigns/${pausedCampaign.id}/cancel`, { reason: "not needed" });
        assert.equal(cancelled.status, 200, cancelled.text);
        assert.equal(cancelled.body.data.status, "CANCELLED");
      }
    });

    await t.test("D2/D5/D8/D13 + caps: engagement branches, editor separation, automation preflight and Reply-To, crash-loop safe retries, enrollment caps", async () => {
      // D5 (automations): editors are tracked; the creator is never overwritten.
      const definition = (extra = {}) => ({ topic: "offers", steps: [{ id: "a", type: "send_email", templateVersionId: state.templateVersionId, senderAddressId: cf.sender.id, ...extra }] });
      const shared = await call("dave", "POST", `${mbase}/automations`, { name: "Shared edit", triggerType: "CONSENT_GRANTED" });
      const sid = shared.body.data.id;
      const v1 = await call("dave", "PUT", `${mbase}/automations/${sid}/draft`, { definition: definition(), triggerConfig: { topic: "offers" } });
      await call("gil", "PUT", `${mbase}/automations/${sid}/draft`, { definition: definition({ subjectOverride: "gil" }), triggerConfig: { topic: "offers" } });
      await call("hal", "PUT", `${mbase}/automations/${sid}/draft`, { definition: definition({ subjectOverride: "hal" }), triggerConfig: { topic: "offers" } });
      assert.equal((await client.marketingAutomationVersion.findUnique({ where: { id: v1.body.data.id } })).createdByAdminUserId, ids.dave, "creator kept");
      assert.equal((await call("hal", "POST", `${mbase}/automations/${sid}/versions/${v1.body.data.id}/submit`)).status, 200);
      const byEditor = await call("gil", "POST", `${mbase}/automations/${sid}/versions/${v1.body.data.id}/approve`, { stepUpId: await stepUp("gil", "MARKETING_AUTOMATION_PUBLISH") });
      assert.equal(byEditor.status, 403, "an intermediate editor cannot approve");
      assert.equal((await call("erin", "POST", `${mbase}/automations/${sid}/versions/${v1.body.data.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_PUBLISH") })).status, 200);

      // D8: automation submit runs the campaign preflight subset.
      const phish = await newVersion("dave", "Phish", [{ type: "heading", text: "Verify" }, { type: "button", label: "Verify account", url: "https://bit.ly/verify" }]);
      const checks = async (name, step) => {
        const created = await call("dave", "POST", `${mbase}/automations`, { name, triggerType: "CONSENT_GRANTED" });
        const draft = await call("dave", "PUT", `${mbase}/automations/${created.body.data.id}/draft`, { definition: { topic: "offers", steps: [{ id: "a", type: "send_email", templateVersionId: state.templateVersionId, senderAddressId: cf.sender.id, ...step }] }, triggerConfig: { topic: "offers" } });
        assert.equal(draft.status, 200, draft.text);
        const submitted = await call("dave", "POST", `${mbase}/automations/${created.body.data.id}/versions/${draft.body.data.id}/submit`);
        return { status: submitted.status, failed: (submitted.body?.errors?.[0]?.checks || []).map((check) => check.id) };
      };
      assert.deepEqual(await checks("Phish link", { templateVersionId: phish }), { status: 422, failed: ["a:links_safe"] });
      assert.deepEqual(await checks("System sender", { senderAddressId: state.system.id }), { status: 422, failed: ["a:reply_to_policy"] }, "a system sender needs an explicit shared Reply-To");
      assert.deepEqual(await checks("Personal reply", { replyTo: "deals@cosmicforge.example" }), { status: 422, failed: ["a:reply_to_policy"] });
      assert.equal((await checks("System sender, shared reply", { senderAddressId: state.system.id, replyTo: "news@cosmicforge.example" })).status, 200);

      // D2: engagement.previous_send_opened is fed by provider open events.
      const offersId = await publishAutomation("Offers", "CONSENT_GRANTED", { topic: "offers", entryStepId: "first", steps: [
        { id: "first", type: "send_email", templateVersionId: state.templateVersionId, senderAddressId: cf.sender.id, next: "wait" },
        { id: "wait", type: "delay", minutes: 30, next: "check" },
        { id: "check", type: "condition", condition: { field: "engagement.previous_send_opened", op: "equals", value: "true" }, then: "done", else: "nudge" },
        { id: "nudge", type: "send_email", templateVersionId: state.templateVersionId, senderAddressId: cf.sender.id, subjectOverride: "Did you see this?", next: null },
        { id: "done", type: "exit" },
      ] }, { topic: "offers" });
      const before = fake.state.emails.length;
      const opener = await newContact("o1@reader.example", "offers");
      const ignorer = await newContact("o2@reader.example", "offers");
      await work(3, 61000);
      const firsts = fake.state.emails.slice(before);
      assert.equal(firsts.length, 2);
      assert.ok(firsts.every((email) => email.replyTo?.address === "news@cosmicforge.example"), "automation sends carry the shared Reply-To");
      const openerMail = firsts.find((email) => email.to[0].address === "o1@reader.example");
      await postWebhook(base, harness.clock, "email.opened", { email_id: openerMail.providerMessageId, to: ["o1@reader.example"] });
      await work(2);
      const openerRun = await client.marketingAutomationStepRun.findFirst({ where: { providerMessageId: openerMail.providerMessageId } });
      assert.equal(openerRun.outcome.opened, true);
      harness.advance(31 * 60000);
      await work(4, 61000);
      const enrollmentOf = (contact) => client.marketingAutomationEnrollment.findFirst({ where: { automationId: offersId, contactId: contact.id } });
      assert.equal((await enrollmentOf(opener)).exitReason, "EXIT_STEP", "opened -> then branch");
      const nudges = fake.state.emails.slice(before).filter((email) => email.subject === "Did you see this?").map((email) => email.to[0].address);
      assert.deepEqual(nudges, ["o2@reader.example"], "not opened -> else branch");
      assert.equal((await enrollmentOf(ignorer)).status, "COMPLETED");

      // D13: a RUNNING row from an earlier attempt + consent withdrawn -> EXITED, no dead letter.
      const crash = await newContact("o3@reader.example", "offers");
      await harness.mail.processors.automations.processTriggerEvents();
      const enrollment = await enrollmentOf(crash);
      await client.marketingAutomationStepRun.create({ data: { enrollmentId: enrollment.id, organizationId: org, stepId: "first", stepType: "send_email", sequence: 0, status: "RUNNING", idempotencyKey: `auto:${enrollment.id}:0`, recipientEmail: "o3@reader.example", templateVersionId: state.templateVersionId, firstAttemptAt: harness.clock() } });
      await call("dave", "POST", `${mbase}/contacts/${crash.id}/consents/offers/withdraw`, {});
      await work(3, 61000);
      const exited = await client.marketingAutomationEnrollment.findUnique({ where: { id: enrollment.id } });
      assert.equal(exited.status, "EXITED");
      assert.equal(exited.exitReason, "CONSENT_NOT_GRANTED");
      const crashRun = await client.marketingAutomationStepRun.findUnique({ where: { enrollmentId_sequence: { enrollmentId: enrollment.id, sequence: 0 } } });
      assert.equal(crashRun.status, "OUTCOME_UNKNOWN", "an earlier attempt may have reached the provider");
      assert.equal(await client.mailOutboxJob.count({ where: { idempotencyKey: { startsWith: `auto-step:${enrollment.id}:` }, status: { in: ["DEAD_LETTER", "FAILED"] } } }), 0);

      // Enrollment caps: ENROLLMENT_LIMIT and MAX_ACTIVE_ENROLLMENTS.
      const cappedId = await publishAutomation("Capped", "CONSENT_GRANTED", { topic: "caps", steps: [
        { id: "one", type: "send_email", templateVersionId: state.templateVersionId, senderAddressId: cf.sender.id, next: "pause" },
        { id: "pause", type: "delay", minutes: 600, next: "two" },
        { id: "two", type: "send_email", templateVersionId: state.templateVersionId, senderAddressId: cf.sender.id, next: null },
      ] }, { topic: "caps" }, { enrollmentLimit: 1, maxActiveEnrollments: 1 });
      const k1 = await newContact("k1@reader.example", "caps");
      await harness.mail.processors.automations.processTriggerEvents();
      const k2 = await newContact("k2@reader.example", "caps");
      await harness.mail.processors.automations.processTriggerEvents();
      assert.equal(await client.marketingAutomationEnrollment.count({ where: { automationId: cappedId, contactId: k2.id } }), 0, "MAX_ACTIVE_ENROLLMENTS");
      assert.equal((await client.marketingTriggerEvent.findFirst({ where: { contactId: k2.id } })).status, "IGNORED");
      await client.marketingTriggerEvent.create({ data: { organizationId: org, source: "CONSENT", eventType: "consent.granted", eventId: `manual:${crypto.randomUUID()}`, contactId: k1.id, payload: { topic: "caps" }, occurredAt: harness.clock() } });
      await client.marketingAutomationEnrollment.updateMany({ where: { automationId: cappedId, contactId: k1.id }, data: { status: "COMPLETED", completedAt: harness.clock() } });
      await harness.mail.processors.automations.processTriggerEvents();
      assert.equal(await client.marketingAutomationEnrollment.count({ where: { automationId: cappedId, contactId: k1.id } }), 1, "ENROLLMENT_LIMIT");
      for (const id of [sid, offersId, cappedId]) await call("erin", "POST", `${mbase}/automations/${id}/archive`);
    });

    await t.test("D10/D11: schedules page large audiences across ticks; resuming never fires a stale occurrence", async () => {
      const people = [];
      for (const name of ["s1", "s2", "s3"]) people.push(await newContact(`${name}@reader.example`));
      const audienceId = await audienceWith("Daily audience", people);
      const dailyId = await publishAutomation("Daily digest", "SCHEDULE", { topic: "newsletter", steps: [{ id: "digest", type: "send_email", templateVersionId: state.templateVersionId, senderAddressId: cf.sender.id }] }, { frequency: "daily", localTime: "07:00", timeZone: "UTC", audienceId });
      const small = harness.build({ MAIL_AUTOMATION_SCHEDULE_MAX_PER_RUN: "2" });
      const now = harness.clock();
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7, 0, 0));
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      harness.advance(next.getTime() - now.getTime() + 60000);
      const activatedAt = (await client.marketingAutomation.findUnique({ where: { id: dailyId } })).lastScheduledRunAt;
      assert.equal((await small.processors.automations.processSchedules()).enrolled, 2);
      assert.equal((await client.marketingAutomation.findUnique({ where: { id: dailyId } })).lastScheduledRunAt.getTime(), activatedAt.getTime(), "occurrence not done yet");
      assert.equal((await small.processors.automations.processSchedules()).enrolled, 1, "next tick continues the same occurrence");
      assert.equal((await client.marketingAutomation.findUnique({ where: { id: dailyId } })).lastScheduledRunAt.toISOString(), next.toISOString());
      assert.equal((await small.processors.automations.processSchedules()).enrolled, 0);
      assert.equal(await client.marketingAutomationEnrollment.count({ where: { automationId: dailyId } }), 3, "nobody truncated");

      // Paused across the next occurrence, then resumed: nothing stale fires.
      assert.equal((await call("dave", "POST", `${mbase}/automations/${dailyId}/pause`)).status, 200);
      harness.advance(86400000 + 3600000);
      assert.equal((await call("erin", "POST", `${mbase}/automations/${dailyId}/activate`)).status, 200);
      assert.equal((await small.processors.automations.processSchedules()).enrolled, 0, "the occurrence missed while paused is not fired on resume");
      assert.equal(await client.marketingAutomationEnrollment.count({ where: { automationId: dailyId } }), 3);
    });
  } finally {
    await closeServer(server);
    await db.close();
  }
});
