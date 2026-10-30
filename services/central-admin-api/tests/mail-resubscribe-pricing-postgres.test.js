"use strict";

// Final gaps 2 + 3 on real PostgreSQL with the offline fake providers:
// provider subscription state, re-subscription after a verified double
// opt-in (flag ON and OFF), refusals, retries, broadcast sync behaviour,
// approved pricing, per-dispatch cost estimates (stability, re-estimate),
// provider quota observations / defer, brand isolation and the behaviour of
// the same code on a database without migration 37.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp, postWebhook, BRAND_WEBHOOK_SECRETS } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");
const { signResendWebhook } = require("../src/modules/mail/webhooks/resend-webhook.verifier");

const ROLLBACK_37 = path.join(__dirname, "..", "..", "..", "docs", "sql", "cosmicforge-mail-final-gap-closure-rollback.sql");
const errorOf = (response) => response.body?.errors?.[0] || {};

function scenario(t, { rollback = false } = {}) {
  return (async () => {
    const db = await openDatabase();
    const { client } = db;
    if (rollback) await client.$executeRawUnsafe(fs.readFileSync(ROLLBACK_37, "utf8"));
    const harness = createHarness(client);
    const seeded = await seed(client, { clock: harness.clock });
    for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
    const { ids, brands } = seeded;
    const servers = [];
    const serve = async (application) => {
      const listening = await listen(harness.mountApp(application));
      servers.push(listening.server);
      return { ...listening, call: caller(listening.base, ids) };
    };
    const main = await serve(harness.mail);
    t.after(async () => {
      for (const server of servers) await closeServer(server);
      await db.close();
    });
    return { db, client, harness, ids, brands, serve, main };
  })();
}

test("final gaps 2+3: re-subscription, provider state, pricing, cost estimates and quota on real PostgreSQL", { timeout: 900000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const { client, harness, ids, brands, serve, main } = await scenario(t);
  const call = main.call;
  const base = main.base;
  const cf = brands.cosmicforge;
  const kg = brands.karryam;
  const mbase = `/marketing/${cf.organization.id}`;
  const fake = harness.marketingAdapter;
  // Same database and fakes, provider re-subscription flag ON.
  const onApp = harness.build({ MAIL_MARKETING_PROVIDER_RESUBSCRIBE_ENABLED: "true" });
  const on = await serve(onApp);
  const worker = harness.mail.createWorker({ queues: ["MARKETING", "EVENTS"] });
  const onWorker = onApp.createWorker({ queues: ["MARKETING", "EVENTS"] });
  const work = async (rounds = 2, stepMs = 2000, which = worker) => {
    for (let index = 0; index < rounds; index += 1) {
      harness.advance(stepMs);
      await which.drain({ maxTicks: 20 });
    }
  };
  const stepUp = async (key, purpose) => {
    harness.advance(31000);
    const response = await call(key, "POST", "/security/step-up", { code: totp(harness.clock), purpose });
    assert.equal(response.status, 201, response.text);
    return response.body.data.stepUpId;
  };
  const consent = (extra = {}) => ({ topic: "newsletter", source: "WEB_FORM", policyVersion: "2026-10", evidence: { reference: `form-${crypto.randomUUID().slice(0, 8)}` }, ...extra });
  const newContact = async (email) => {
    const response = await call("dave", "POST", `${mbase}/contacts`, { email, firstName: email.split("@")[0], consent: consent() });
    assert.equal(response.status, 201, response.text);
    return response.body.data;
  };
  // The contact unsubscribes through the provider's link (brand webhook).
  const providerUnsubscribe = async (email) => {
    let remote = fake.state.contacts.get(email);
    if (!remote) {
      remote = { id: `fake_contact_${crypto.randomUUID()}`, email, unsubscribed: true, segments: new Set() };
      fake.state.contacts.set(email, remote);
    }
    remote.unsubscribed = true;
    const at = harness.clock().toISOString();
    const posted = await postWebhook(base, harness.clock, "contact.updated", { id: remote.id, email, unsubscribed: true, created_at: at, updated_at: at }, { path: "/webhooks/resend/brand/cosmicforge", secret: BRAND_WEBHOOK_SECRETS.cosmicforge });
    assert.equal(posted.status, 200);
    await work(1);
    return remote;
  };
  const postRawWebhook = async (payload, { id = `msg_${crypto.randomUUID()}`, secret = BRAND_WEBHOOK_SECRETS.cosmicforge } = {}) => {
    const timestamp = Math.floor(harness.clock().getTime() / 1000);
    const rawBody = Buffer.from(JSON.stringify(payload));
    const response = await fetch(`${base}/webhooks/resend/brand/cosmicforge`, { method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": signResendWebhook({ rawBody, secret, id, timestamp }) }, body: rawBody });
    return { status: response.status };
  };
  // A fresh, verified double opt-in by the contact.
  const doubleOptIn = async (contactId) => {
    const recorded = await call("dave", "POST", `${mbase}/contacts/${contactId}/consents`, consent({ doubleOptIn: true }));
    assert.equal(recorded.status, 201, recorded.text);
    assert.ok(recorded.body.data.confirmationToken, "non-production test token");
    harness.advance(1000);
    const confirmed = await call(null, "POST", "/public/consent/confirm", { token: recorded.body.data.confirmationToken });
    assert.equal(confirmed.status, 200, confirmed.text);
    return client.marketingProviderResubscription.findFirst({ where: { contactId }, orderBy: { createdAt: "desc" } });
  };
  const unsubscribedAndReconfirmed = async (email) => {
    const contact = await newContact(email);
    await providerUnsubscribe(email);
    const request = await doubleOptIn(contact.id);
    return { contact, request };
  };

  let templateVersionId;
  const approvedCampaign = async (name, contacts) => {
    const audience = await call("dave", "POST", `${mbase}/audiences`, { name: `${name} audience`, topic: "newsletter" });
    await call("dave", "POST", `${mbase}/audiences/${audience.body.data.id}/contacts`, { contactIds: contacts.map((contact) => contact.id) });
    const campaign = await call("dave", "POST", `${mbase}/campaigns`, { name, topic: "newsletter", templateVersionId, audienceId: audience.body.data.id, senderAddressId: cf.sender.id, frequencyCapHours: 0 });
    assert.equal(campaign.status, 201, campaign.text);
    assert.equal((await call("dave", "POST", `${mbase}/campaigns/${campaign.body.data.id}/submit`, { revision: 1 })).status, 200);
    const approved = await call("erin", "POST", `${mbase}/campaigns/${campaign.body.data.id}/approve`, { revision: 1, stepUpId: await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL") });
    assert.equal(approved.status, 200, approved.text);
    return campaign.body.data.id;
  };
  const schedule = (campaignId) => call("dave", "POST", `${mbase}/campaigns/${campaignId}/schedule`, { revision: 1, sendAtUtc: new Date(harness.clock().getTime() + 120000).toISOString() });
  const dispatchOf = (campaignId) => client.marketingBroadcastDispatch.findUnique({ where: { campaignId } });
  const consentOf = async (contactId) => (await client.marketingConsent.findFirst({ where: { contactId, topic: "newsletter" } })).status;
  const stateOf = (contactId) => client.marketingContactProviderState.findUnique({ where: { contactId } });

  const template = await call("dave", "POST", `${mbase}/templates`, { name: "Gap 2/3 newsletter" });
  const version = await call("dave", "POST", `${mbase}/templates/${template.body.data.id}/versions`, { subject: "News for {{first_name}}", blocks: [{ type: "heading", text: "Hello {{first_name}}" }, { type: "text", text: "Update from {{brand_name}}." }] });
  assert.equal(version.status, 201, version.text);
  templateVersionId = version.body.data.id;

  let ann;
  await t.test("provider unsubscribe is recorded as provider state; a later verified double opt-in opens a PENDING_APPROVAL request with evidence", async () => {
    const result = await unsubscribedAndReconfirmed("ann@reader.example");
    ann = result.contact;
    const state = await stateOf(ann.id);
    assert.equal(state.state, "UNSUBSCRIBED");
    assert.equal(state.reason, "USER_UNSUBSCRIBE");
    assert.equal(await consentOf(ann.id), "GRANTED", "local consent (the new double opt-in) is the source of truth");
    assert.ok(await client.marketingSuppression.findFirst({ where: { organizationId: cf.organization.id, email: "ann@reader.example", reason: "UNSUBSCRIBED", source: "provider_unsubscribe", liftedAt: null } }), "the old unsubscribe's mirror suppression is still active");
    assert.equal(result.request.status, "PENDING_APPROVAL");
    assert.equal(result.request.requestedBy, null, "opened by the system; a human approver is required");
    assert.equal(result.request.consentEvidence.doubleOptIn, true);
    assert.ok(result.request.consentEvidence.confirmedAt);
    assert.equal(result.request.consentEvidence.providerState.reason, "USER_UNSUBSCRIBE");
    const listed = await call("erin", "GET", `${mbase}/resubscriptions`);
    assert.equal(listed.status, 200, listed.text);
    const entry = listed.body.data.items.find((item) => item.id === result.request.id);
    assert.equal(entry.providerState.state, "UNSUBSCRIBED");
    assert.equal(listed.body.data.flags.providerResubscribeEnabled, false);
    const detail = await call("dave", "GET", `${mbase}/contacts/${ann.id}/provider-state`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.data.providerState.state, "UNSUBSCRIBED");
    assert.equal(detail.body.data.resubscriptions.length, 1);
    const batch = await call("dave", "GET", `${mbase}/provider-states?contactIds=${ann.id},${crypto.randomUUID()}`);
    assert.deepEqual(batch.body.data.items.map((item) => item.state), ["UNSUBSCRIBED", "UNKNOWN"]);
  });

  await t.test("brand isolation: another brand cannot see, approve or read state; authors cannot approve; approval needs a step-up", async () => {
    const request = await client.marketingProviderResubscription.findFirst({ where: { contactId: ann.id } });
    assert.equal((await call("kim", "GET", `${mbase}/resubscriptions`)).status, 404);
    assert.equal((await call("kim", "POST", `/marketing/${kg.organization.id}/resubscriptions/${request.id}/approve`, { stepUpId: "x" })).status, 404, "the karryam scope does not find a cosmicforge request");
    assert.equal((await call("kim", "GET", `${mbase}/contacts/${ann.id}/provider-state`)).status, 404);
    assert.equal((await call("kim", "GET", `/marketing/${kg.organization.id}/contacts/${ann.id}/provider-state`)).status, 404);
    const author = await call("dave", "POST", `${mbase}/resubscriptions/${request.id}/approve`, {});
    assert.equal(author.status, 403);
    const noStepUp = await call("erin", "POST", `${mbase}/resubscriptions/${request.id}/approve`, {});
    assert.equal(noStepUp.status, 403);
    assert.equal(noStepUp.body.code, "MAIL_STEP_UP_REQUIRED");
    const wrongPurpose = await call("erin", "POST", `${mbase}/resubscriptions/${request.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL") });
    assert.equal(wrongPurpose.status, 403);
    assert.equal((await client.marketingProviderResubscription.findUnique({ where: { id: request.id } })).status, "PENDING_APPROVAL");
  });

  await t.test("flag ON: approval PATCHes the provider, reads it back, then APPLIED + SUBSCRIBED; mirror suppression lifted; audit has ids only", async () => {
    const request = await client.marketingProviderResubscription.findFirst({ where: { contactId: ann.id } });
    const approved = await on.call("erin", "POST", `${mbase}/resubscriptions/${request.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_RESUBSCRIBE_APPROVE") });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.body.data.status, "APPLIED");
    assert.equal(approved.body.data.approvedBy, ids.erin);
    assert.equal(fake.state.contacts.get("ann@reader.example").unsubscribed, false);
    assert.ok(fake.state.calls.some((entry) => entry.operation === "resubscribeContact"));
    const state = await stateOf(ann.id);
    assert.equal(state.state, "SUBSCRIBED");
    assert.equal(await client.marketingSuppression.count({ where: { organizationId: cf.organization.id, email: "ann@reader.example", liftedAt: null } }), 0);
    assert.equal((await client.marketingContact.findUnique({ where: { id: ann.id } })).status, "ACTIVE");
    const events = await client.mailAuditEvent.findMany({ where: { action: { startsWith: "MARKETING_RESUBSCRIPTION_" }, targetId: ann.id } });
    assert.deepEqual(events.map((event) => event.action).sort(), ["MARKETING_RESUBSCRIPTION_APPLIED", "MARKETING_RESUBSCRIPTION_APPROVED", "MARKETING_RESUBSCRIPTION_REQUESTED"]);
    for (const event of events) assert.equal(JSON.stringify(event.metadata).includes("reader.example"), false, "no email address in audit metadata");
    assert.equal((await on.call("erin", "POST", `${mbase}/resubscriptions/${request.id}/approve`, { stepUpId: "x" })).status, 409, "an applied request cannot be approved again");
  });

  await t.test("a stale (pre-re-subscription) provider unsubscribe no longer withdraws the newer verified consent", async () => {
    const applied = await client.marketingProviderResubscription.findFirst({ where: { contactId: ann.id, status: "APPLIED" } });
    const before = new Date(applied.completedAt.getTime() - 60000).toISOString();
    const remote = fake.state.contacts.get("ann@reader.example");
    // A webhook retry delivers the old event late: its created_at predates the re-subscription.
    const stale = await postRawWebhook({ type: "contact.updated", created_at: before, data: { id: remote.id, email: "ann@reader.example", unsubscribed: true, created_at: before, updated_at: before } });
    assert.equal(stale.status, 200);
    await work(1);
    assert.equal(await consentOf(ann.id), "GRANTED");
    assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MARKETING_PROVIDER_UNSUBSCRIBE_SUPERSEDED", targetId: ann.id } }), "not silent: audited");
    assert.equal((await stateOf(ann.id)).state, "SUBSCRIBED");
  });

  let bob;
  let gil;
  let dispatchId;
  let pricingA;
  await t.test("pricing: mail admin + step-up only; invalid values, bad currency and overlapping periods are 422", async () => {
    const valid = { provider: "fake", currency: "USD", unitCost: "0.0009", includedMonthly: 3000, effectiveFrom: "2020-01-01T00:00:00.000Z", source: "CONTRACT", reference: "Resend Pro 2026 order form" };
    assert.equal((await call("dave", "POST", "/admin/pricing", valid)).status, 403, "brand users cannot set pricing");
    assert.equal((await call("dave", "GET", "/admin/pricing")).status, 403);
    for (const [patch, field] of [[{ unitCost: "-1" }, "unitCost"], [{ unitCostMicros: "-900" }, "unitCostMicros"], [{ currency: "usd" }, "currency"], [{ currency: "ABC" }, "currency"], [{ source: "GUESS" }, "source"], [{ reference: "" }, "reference"], [{ effectiveTo: "2019-01-01T00:00:00.000Z" }, "effectiveTo"], [{ includedMonthly: -5 }, "includedMonthly"], [{ effectiveFrom: "not a date" }, "effectiveFrom"]]) {
      const response = await call("ops", "POST", "/admin/pricing", { ...valid, ...patch });
      assert.equal(response.status, 422, `${field}: ${response.text}`);
      assert.equal(errorOf(response).field, field);
    }
    assert.equal((await call("ops", "POST", "/admin/pricing", valid)).status, 403, "valid input still needs the step-up");
    const created = await call("ops", "POST", "/admin/pricing", { ...valid, stepUpId: await stepUp("ops", "MAIL_PRICING_CHANGE") });
    assert.equal(created.status, 201, created.text);
    pricingA = created.body.data;
    assert.equal(pricingA.unitCostMicros, 900);
    assert.equal(pricingA.label, "estimated (not billed)");
    const overlap = await call("ops", "POST", "/admin/pricing", { ...valid, unitCost: "0.001", effectiveFrom: "2025-01-01T00:00:00.000Z", stepUpId: await stepUp("ops", "MAIL_PRICING_CHANGE") });
    assert.equal(overlap.status, 422, overlap.text);
    assert.equal(errorOf(overlap).reason, "PRICING_PERIOD_OVERLAP");
    const brandRow = await call("ops", "POST", "/admin/pricing", { ...valid, organizationId: kg.organization.id, unitCost: "0.002", stepUpId: await stepUp("ops", "MAIL_PRICING_CHANGE") });
    assert.equal(brandRow.status, 201, "a brand-specific row is a separate scope");
    const listed = await call("ops", "GET", "/admin/pricing");
    assert.equal(listed.body.data.items.length, 2);
    assert.equal(listed.body.data.billed.status, "UNAVAILABLE");
    assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MAIL_PROVIDER_PRICING_CREATED", targetId: pricingA.id } }));
  });

  await t.test("broadcast sync: provider-unsubscribed contacts excluded without touching consent; APPLIED contact sent; mismatch flagged; cost estimated at finalize", async () => {
    bob = await newContact("bob@reader.example");
    // bob: provider still unsubscribed, no re-subscription applied.
    await harness.mail.services.resubscriptions.observe({ organizationId: cf.organization.id, contactId: bob.id, state: "UNSUBSCRIBED", reason: "USER_UNSUBSCRIBE", observedAt: harness.clock() });
    // gil: re-subscribed and verified, but the provider flag is set again (no unsubscribe event seen since).
    const gilResult = await unsubscribedAndReconfirmed("gil@reader.example");
    gil = gilResult.contact;
    const approved = await on.call("erin", "POST", `${mbase}/resubscriptions/${gilResult.request.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_RESUBSCRIBE_APPROVE") });
    assert.equal(approved.body.data.status, "APPLIED", approved.text);
    fake.state.contacts.get("gil@reader.example").unsubscribed = true;
    const cy = await newContact("cy@reader.example");

    const campaignId = await approvedCampaign("Gap23", [ann, bob, gil, cy]);
    assert.equal((await schedule(campaignId)).status, 201);
    harness.advance(180000);
    await work(6);
    const dispatch = await dispatchOf(campaignId);
    dispatchId = dispatch.id;
    assert.equal(dispatch.status, "SENDING", JSON.stringify(dispatch));
    const rows = Object.fromEntries((await client.marketingBroadcastRecipient.findMany({ where: { dispatchId } })).map((row) => [row.email, row]));
    assert.equal(rows["bob@reader.example"].status, "EXCLUDED");
    assert.equal(rows["bob@reader.example"].exclusionReason, "PROVIDER_UNSUBSCRIBED");
    assert.equal(await consentOf(bob.id), "GRANTED", "a stale provider state never silently withdraws local consent");
    assert.equal(rows["gil@reader.example"].exclusionReason, "PROVIDER_STATE_MISMATCH");
    assert.equal(await consentOf(gil.id), "GRANTED");
    assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MARKETING_PROVIDER_STATE_MISMATCH", targetId: gil.id } }));
    assert.equal(rows["ann@reader.example"].status, "PROVIDER_ACCEPTED", "the re-subscribed contact is sent");
    assert.equal(rows["cy@reader.example"].status, "PROVIDER_ACCEPTED");
    assert.equal((await stateOf(cy.id))?.state ?? "UNKNOWN", "UNKNOWN", "a contact created at the provider during sync has no prior provider state");
    assert.equal((await stateOf(ann.id)).state, "SUBSCRIBED", "sync confirms the provider state");

    fake.completeBroadcast(dispatch.providerBroadcastId);
    harness.advance(61000);
    await work(2);
    assert.equal((await dispatchOf(campaignId)).status, "COMPLETED");
    const cost = await client.marketingDispatchCost.findUnique({ where: { dispatchId } });
    assert.equal(cost.status, "ESTIMATED");
    assert.equal(cost.basis, "ACCEPTED_RECIPIENTS");
    assert.equal(cost.basisCount, 2);
    assert.equal(Number(cost.estimatedCostMicros), 1800);
    assert.equal(cost.pricingId, pricingA.id);

    const report = await call("erin", "GET", `${mbase}/campaigns/${campaignId}/report`);
    assert.equal(report.status, 200, report.text);
    const spend = report.body.data.spend;
    assert.equal(spend.status, "ESTIMATED");
    assert.equal(spend.amount, "0.001800");
    assert.equal(spend.currency, "USD");
    assert.equal(spend.basisCount, 2);
    assert.equal(spend.pricingSource, "CONTRACT");
    assert.equal(spend.pricingReference, "Resend Pro 2026 order form");
    assert.equal(spend.billed, null);
    assert.equal(spend.billedStatus, "UNAVAILABLE");
    assert.equal(spend.label, "estimated (not billed)");
    assert.match(spend.includedAllowanceNote, /not subtracted/);
    assert.equal(report.body.data.denominators.eventsStillArriving, true, "inside the settle window after the send");
    assert.ok(report.body.data.denominators.reportWindowEnd);
    assert.equal(report.body.data.denominators.sent.count, 2);
    assert.equal(report.body.data.providerQuota.status, "HIDDEN", "the brand shares the account: quota only for mail admins");
    assert.equal((await call("kim", "GET", `${mbase}/campaigns/${campaignId}/report`)).status, 404, "costs are brand-scoped");
    const kimOverview = await call("kim", "GET", `/marketing/${kg.organization.id}/reports/overview`);
    assert.deepEqual(kimOverview.body.data.spend.estimated, [], "another brand never sees this dispatch's estimate");
    const overview = await call("dave", "GET", `${mbase}/reports/overview`);
    assert.deepEqual(overview.body.data.spend.estimated, [{ currency: "USD", amount: "0.001800", dispatches: 1, acceptedRecipients: 2 }]);
  });

  await t.test("cost stability: a pricing change never rewrites a stored estimate; effective boundary is exact; explicit re-estimate is audited", async () => {
    const boundary = new Date(harness.clock().getTime() + 3600000);
    const closed = await call("ops", "PATCH", `/admin/pricing/${pricingA.id}`, { effectiveTo: boundary.toISOString(), stepUpId: await stepUp("ops", "MAIL_PRICING_CHANGE") });
    assert.equal(closed.status, 200, closed.text);
    const pricingB = await call("ops", "POST", "/admin/pricing", { provider: "fake", currency: "USD", unitCost: "0.0015", effectiveFrom: boundary.toISOString(), source: "PRICE_LIST", reference: "2026-11 price list", stepUpId: await stepUp("ops", "MAIL_PRICING_CHANGE") });
    assert.equal(pricingB.status, 201, pricingB.text);
    const { pricing } = harness.mail.services;
    assert.equal((await pricing.effectiveAt(client, "fake", cf.organization.id, boundary)).id, pricingB.body.data.id, "a period starting exactly at send time applies");
    assert.equal((await pricing.effectiveAt(client, "fake", cf.organization.id, new Date(boundary.getTime() - 1))).id, pricingA.id, "one ms earlier the old period applies");
    assert.equal((await pricing.effectiveAt(client, "fake", kg.organization.id, new Date(boundary.getTime() - 1))).organizationId, kg.organization.id, "a brand-specific row wins over the account row");
    const cost = await client.marketingDispatchCost.findUnique({ where: { dispatchId } });
    assert.equal(Number(cost.estimatedCostMicros), 1800, "stored estimate unchanged");
    assert.equal((await call("ops", "DELETE", `/admin/pricing/${pricingA.id}`, { stepUpId: await stepUp("ops", "MAIL_PRICING_CHANGE") })).status, 409, "pricing used by an estimate cannot be deleted");
    assert.equal((await call("dave", "POST", `/admin/pricing/dispatch-costs/${dispatchId}/re-estimate`, {})).status, 403);
    const again = await call("ops", "POST", `/admin/pricing/dispatch-costs/${dispatchId}/re-estimate`, { provider: "fake", stepUpId: await stepUp("ops", "MAIL_PRICING_CHANGE") });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.body.data.amount, "0.001800", "re-estimate uses the pricing effective at the send, not today's");
    assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MARKETING_DISPATCH_COST_REESTIMATED", targetId: dispatchId } }));
  });

  await t.test("soft bounces never change consent or provider state; a hard bounce marks SUPPRESSED/HARD_BOUNCE without withdrawing consent", async () => {
    const dispatch = await client.marketingBroadcastDispatch.findUnique({ where: { id: dispatchId } });
    const events = harness.mail.processors.marketingEvents;
    const event = (type, to, bounce) => ({ id: null, eventType: type, receivedAt: harness.clock(), payload: { created_at: harness.clock().toISOString(), data: { email_id: `bc_${crypto.randomUUID()}`, broadcast_id: dispatch.providerBroadcastId, to: [to], ...(bounce ? { bounce } : {}) } } });
    await events.handleBroadcastEvent(event("email.bounced", "ann@reader.example", { type: "Transient", message: "mailbox full" }));
    assert.equal(await consentOf(ann.id), "GRANTED");
    assert.equal((await stateOf(ann.id)).state, "SUBSCRIBED", "soft bounce: provider state unchanged");
    assert.equal(await client.marketingSuppression.count({ where: { email: "ann@reader.example", liftedAt: null } }), 0);
    harness.advance(1000);
    await events.handleBroadcastEvent(event("email.bounced", "cy@reader.example", { type: "Permanent", message: "no such user" }));
    const cyContact = await client.marketingContact.findUnique({ where: { organizationId_email: { organizationId: cf.organization.id, email: "cy@reader.example" } } });
    const cyState = await stateOf(cyContact.id);
    assert.equal(cyState.state, "SUPPRESSED");
    assert.equal(cyState.reason, "HARD_BOUNCE");
    assert.equal(await consentOf(cyContact.id), "GRANTED", "a bounce is not a withdrawal of consent");
  });

  await t.test("refusals: complaint, hard bounce, other local suppression and global suppression are never re-subscribed", async () => {
    // One active brand suppression per address: a later complaint / bounce /
    // admin decision replaces the unsubscribe's mirror suppression.
    const replaceMirror = (reason, source) => (email) => client.marketingSuppression.updateMany({ where: { organizationId: cf.organization.id, email, liftedAt: null }, data: { reason, source } });
    const cases = [
      ["dana@reader.example", replaceMirror("COMPLAINED", "provider_event"), "COMPLAINT"],
      ["ed@reader.example", replaceMirror("BOUNCED", "provider_hard_bounce"), "HARD_BOUNCE"],
      ["flo@reader.example", replaceMirror("MANUAL", "admin"), "LOCAL_SUPPRESSION_ACTIVE"],
      ["gwen@reader.example", (email) => client.marketingSuppression.create({ data: { organizationId: null, email, reason: "LEGAL", source: "admin" } }), "GLOBAL_SUPPRESSION"],
      ["hal@reader.example", (email) => harness.mail.services.resubscriptions.observe({ organizationId: cf.organization.id, email, state: "SUPPRESSED", reason: "HARD_BOUNCE", observedAt: harness.clock() }), "HARD_BOUNCE"],
    ];
    for (const [email, block, reason] of cases) {
      const contact = await newContact(email);
      await providerUnsubscribe(email);
      await block(email);
      const request = await doubleOptIn(contact.id);
      assert.equal(request.status, "REFUSED", email);
      assert.match(request.lastError, new RegExp(reason));
      assert.equal(fake.state.contacts.get(email).unsubscribed, true, "nothing was sent to the provider");
    }
    // A contact the provider never unsubscribed needs no request at all.
    const plain = await newContact("hana@reader.example");
    const none = await doubleOptIn(plain.id);
    assert.equal(none, null);
    // A request blocked after it was opened is refused at approval time.
    const late = await unsubscribedAndReconfirmed("ivy@reader.example");
    assert.equal(late.request.status, "PENDING_APPROVAL");
    await replaceMirror("COMPLAINED", "provider_event")("ivy@reader.example");
    const blocked = await on.call("erin", "POST", `${mbase}/resubscriptions/${late.request.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_RESUBSCRIBE_APPROVE") });
    assert.equal(blocked.status, 409, blocked.text);
    assert.deepEqual(errorOf(blocked).reasons, ["COMPLAINT"]);
    assert.equal((await client.marketingProviderResubscription.findUnique({ where: { id: late.request.id } })).status, "REFUSED");
    // An approver may refuse explicitly.
    const manual = await unsubscribedAndReconfirmed("jo@reader.example");
    assert.equal((await call("erin", "POST", `${mbase}/resubscriptions/${manual.request.id}/refuse`, { reason: "x" })).status, 400, "a reason is required");
    const refused = await call("erin", "POST", `${mbase}/resubscriptions/${manual.request.id}/refuse`, { reason: "Contact asked us by phone not to resume" });
    assert.equal(refused.body.data.status, "REFUSED", refused.text);
  });

  await t.test("flag OFF: approval ends UNSUPPORTED with the operator workflow; manual confirmation needs a step-up and is verified against the provider", async () => {
    const { contact, request } = await unsubscribedAndReconfirmed("kai@reader.example");
    const approved = await call("erin", "POST", `${mbase}/resubscriptions/${request.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_RESUBSCRIBE_APPROVE") });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.body.data.status, "UNSUPPORTED");
    assert.match(approved.body.data.operatorMessage, /Resend support|Resend dashboard/);
    assert.equal(fake.state.calls.filter((entry) => entry.operation === "resubscribeContact" && entry.contactId === fake.state.contacts.get("kai@reader.example").id).length, 0, "no undocumented provider call");
    assert.equal((await stateOf(contact.id)).state, "UNSUBSCRIBED");
    assert.equal((await call("erin", "POST", `${mbase}/resubscriptions/${request.id}/confirm-manual`, {})).status, 403, "manual confirmation needs a step-up");
    assert.equal((await call("dave", "POST", `${mbase}/resubscriptions/${request.id}/confirm-manual`, {})).status, 403, "authors cannot confirm");
    // Operator claims it is done, but the provider still says unsubscribed.
    const mismatch = await call("erin", "POST", `${mbase}/resubscriptions/${request.id}/confirm-manual`, { stepUpId: await stepUp("erin", "MARKETING_RESUBSCRIBE_CONFIRM"), note: "Ticket 4411" });
    assert.equal(mismatch.status, 200, mismatch.text);
    assert.equal(mismatch.body.data.status, "FAILED");
    assert.equal(mismatch.body.data.lastError, "PROVIDER_VERIFICATION_MISMATCH");
    // Re-added at the provider; confirmed again.
    fake.state.contacts.get("kai@reader.example").unsubscribed = false;
    const confirmed = await call("erin", "POST", `${mbase}/resubscriptions/${request.id}/confirm-manual`, { stepUpId: await stepUp("erin", "MARKETING_RESUBSCRIBE_CONFIRM") });
    assert.equal(confirmed.body.data.status, "APPLIED", confirmed.text);
    assert.equal(confirmed.body.data.providerResult.manual, true);
    assert.equal((await stateOf(contact.id)).state, "SUBSCRIBED");
    assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MARKETING_RESUBSCRIPTION_MANUAL_CONFIRMATION", targetId: contact.id } }));
  });

  await t.test("partial provider failure: retried with backoff by a MARKETING_RESUBSCRIBE job; verification mismatch is FAILED", async () => {
    const { request } = await unsubscribedAndReconfirmed("lea@reader.example");
    fake.failNext("resubscribeContact", "RETRYABLE", "FAKE_HTTP_503");
    const approved = await on.call("erin", "POST", `${mbase}/resubscriptions/${request.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_RESUBSCRIBE_APPROVE") });
    assert.equal(approved.body.data.status, "APPROVED", approved.text);
    assert.equal(approved.body.data.attempts, 1);
    assert.equal(approved.body.data.lastError, "FAKE_HTTP_503");
    assert.ok(new Date(approved.body.data.nextAttemptAt) > harness.clock());
    assert.ok(await client.mailOutboxJob.findUnique({ where: { idempotencyKey: `resubscribe:${request.id}:1` } }));
    await work(2, 2000, onWorker);
    assert.equal((await client.marketingProviderResubscription.findUnique({ where: { id: request.id } })).status, "APPROVED", "not due yet");
    harness.advance(61000);
    await work(1, 1000, onWorker);
    const done = await client.marketingProviderResubscription.findUnique({ where: { id: request.id } });
    assert.equal(done.status, "APPLIED");
    assert.equal(done.attempts, 2);

    const mismatch = await unsubscribedAndReconfirmed("max@reader.example");
    fake.state.ignoreResubscribe = true;
    const failed = await on.call("erin", "POST", `${mbase}/resubscriptions/${mismatch.request.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_RESUBSCRIBE_APPROVE") });
    fake.state.ignoreResubscribe = false;
    assert.equal(failed.body.data.status, "FAILED", failed.text);
    assert.equal(failed.body.data.lastError, "PROVIDER_VERIFICATION_MISMATCH");
    assert.equal((await stateOf(mismatch.contact.id)).state, "UNSUBSCRIBED", "never marked SUBSCRIBED without verification");
  });

  await t.test("re-audit: one guard in approve, the provider attempt and manual confirmation (consent, DOI evidence, shared provider account)", async () => {
    const resubscribeCalls = (email) => fake.state.calls.filter((entry) => entry.operation === "resubscribeContact" && entry.contactId === fake.state.contacts.get(email)?.id).length;
    // (a) consent withdrawn after approval, before the retried provider call.
    const nia = await unsubscribedAndReconfirmed("nia@reader.example");
    fake.failNext("resubscribeContact", "RETRYABLE", "FAKE_HTTP_503");
    const approved = await on.call("erin", "POST", `${mbase}/resubscriptions/${nia.request.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_RESUBSCRIBE_APPROVE") });
    assert.equal(approved.body.data.status, "APPROVED", approved.text);
    const callsBefore = resubscribeCalls("nia@reader.example");
    assert.equal((await call("dave", "POST", `${mbase}/contacts/${nia.contact.id}/consents/newsletter/withdraw`, { source: "admin" })).status, 200);
    harness.advance(120000);
    await work(1, 1000, onWorker);
    const niaRow = await client.marketingProviderResubscription.findUnique({ where: { id: nia.request.id } });
    assert.equal(niaRow.status, "REFUSED");
    assert.match(niaRow.lastError, /CONSENT_NO_LONGER_GRANTED/);
    assert.equal(niaRow.providerResult.refusedBy, "system_before_provider_call");
    assert.equal(resubscribeCalls("nia@reader.example"), callsBefore, "no provider call after the withdrawal");
    assert.equal(fake.state.contacts.get("nia@reader.example").unsubscribed, true);
    assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MARKETING_RESUBSCRIPTION_REFUSED", targetId: nia.contact.id } }));

    // (b) a later non-double-opt-in grant replaces the verified evidence.
    const oli = await unsubscribedAndReconfirmed("oli@reader.example");
    assert.equal(oli.request.status, "PENDING_APPROVAL");
    await client.marketingConsent.update({ where: { id: oli.request.consentEvidence.consentId }, data: { source: "MANUAL", doubleOptIn: false, confirmedAt: null } });
    const blocked = await on.call("erin", "POST", `${mbase}/resubscriptions/${oli.request.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_RESUBSCRIBE_APPROVE") });
    assert.equal(blocked.status, 409, blocked.text);
    assert.deepEqual(errorOf(blocked).reasons, ["CONSENT_EVIDENCE_CHANGED"]);
    assert.equal((await client.marketingProviderResubscription.findUnique({ where: { id: oli.request.id } })).status, "REFUSED");

    // (c) manual confirmation re-checks consent too.
    const pia = await unsubscribedAndReconfirmed("pia@reader.example");
    const unsupported = await call("erin", "POST", `${mbase}/resubscriptions/${pia.request.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_RESUBSCRIBE_APPROVE") });
    assert.equal(unsupported.body.data.status, "UNSUPPORTED", unsupported.text);
    assert.equal((await call("dave", "POST", `${mbase}/contacts/${pia.contact.id}/consents/newsletter/withdraw`, { source: "admin" })).status, 200);
    fake.state.contacts.get("pia@reader.example").unsubscribed = false;
    const manual = await call("erin", "POST", `${mbase}/resubscriptions/${pia.request.id}/confirm-manual`, { stepUpId: await stepUp("erin", "MARKETING_RESUBSCRIBE_CONFIRM") });
    assert.equal(manual.status, 409, manual.text);
    assert.deepEqual(errorOf(manual).reasons, ["CONSENT_NO_LONGER_GRANTED"]);
    assert.equal((await client.marketingProviderResubscription.findUnique({ where: { id: pia.request.id } })).status, "REFUSED");
    assert.notEqual((await stateOf(pia.contact.id)).state, "SUBSCRIBED");

    // (d) shared provider account: Resend's unsubscribe is account-global.
    const quin = await unsubscribedAndReconfirmed("quin@reader.example");
    assert.equal(quin.request.status, "PENDING_APPROVAL");
    fake.accountSource = "shared";
    try {
      const shared = await on.call("erin", "POST", `${mbase}/resubscriptions/${quin.request.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_RESUBSCRIBE_APPROVE") });
      assert.equal(shared.status, 409, shared.text);
      assert.deepEqual(errorOf(shared).reasons, ["SHARED_PROVIDER_ACCOUNT"]);
      assert.equal(resubscribeCalls("quin@reader.example"), 0);
      const ray = await unsubscribedAndReconfirmed("ray@reader.example");
      assert.equal(ray.request.status, "REFUSED", "refused when the request is opened");
      assert.match(ray.request.lastError, /SHARED_PROVIDER_ACCOUNT/);
    } finally {
      delete fake.accountSource;
    }
  });

  await t.test("provider quota: observations sampled per scope, limits only when configured, admin-only; quota exhaustion defers the dispatch until UTC midnight", async () => {
    const quota = harness.mail.services.providerQuota;
    quota.record("account", "fake", { headers: new Headers({ "x-resend-monthly-quota": "321", "x-resend-daily-quota": "12" }), status: 200 });
    quota.record("account", "fake", { headers: new Headers({ "x-resend-monthly-quota": "322" }), status: 200 });
    await quota.flush();
    assert.equal(await client.mailProviderQuotaObservation.count({ where: { scope: "account", source: "RESPONSE_HEADER" } }), 1, "sampled: one row per minute");
    assert.equal((await call("dave", "GET", "/admin/provider-quota")).status, 403, "brand users never see account quota");
    const unknownLimit = await call("ops", "GET", "/admin/provider-quota");
    assert.equal(unknownLimit.status, 200, unknownLimit.text);
    const account = unknownLimit.body.data.items.find((item) => item.scope === "account" && item.provider === "fake");
    assert.equal(account.monthlyUsed, 321);
    assert.equal(account.dailyUsed, 12);
    assert.equal(account.monthlyLimit, null);
    assert.equal(account.remainingStatus, "UNKNOWN");
    assert.equal(unknownLimit.body.data.billing.status, "UNAVAILABLE");
    const limitedApp = harness.build({ MAIL_PROVIDER_MONTHLY_LIMIT: "1000", MAIL_PROVIDER_DAILY_LIMIT: "100" });
    const limited = await serve(limitedApp);
    const known = (await limited.call("ops", "GET", "/admin/provider-quota")).body.data.items.find((item) => item.scope === "account" && item.provider === "fake");
    assert.equal(known.remaining.monthly, 679);
    assert.equal(known.remaining.daily, 88);
    assert.ok(await client.mailProviderQuotaObservation.findFirst({ where: { scope: "account", source: "CONFIGURED_LIMIT", monthlyLimit: 1000 } }));
    // Brand with its own provider key: its brand-scope quota is in the report.
    const brandKeyApp = harness.build({ RESEND_MARKETING_API_KEY__COSMICFORGE: "re_test_brand_key_not_used" });
    const brandKey = await serve(brandKeyApp);
    const campaign = await client.marketingEmailCampaign.findFirst({ where: { dispatch: { is: { id: dispatchId } } } });
    const brandReport = await brandKey.call("dave", "GET", `${mbase}/campaigns/${campaign.id}/report`);
    assert.equal(brandReport.body.data.providerQuota.scope, "brand:cosmicforge", brandReport.text);
    assert.equal(brandReport.body.data.providerQuota.status, "UNKNOWN", "nothing observed for the brand account yet");
    // Re-audit: a shared-marketing-account brand reports the "marketing-shared"
    // scope (where its observations are recorded) with its own limits.
    const sharedApp = harness.build({ RESEND_MARKETING_API_KEY: "re_test_shared_key_not_used", MAIL_BROADCAST_ALLOW_SHARED_PROVIDER_ACCOUNT: "true", MAIL_PROVIDER_DAILY_LIMIT__MARKETING_SHARED: "50", MAIL_PROVIDER_MONTHLY_LIMIT__MARKETING_SHARED: "1500" });
    const sharedServer = await serve(sharedApp);
    sharedApp.services.providerQuota.record("marketing-shared", "resend", { headers: new Headers({ "x-resend-monthly-quota": "40" }), status: 200 });
    await sharedApp.services.providerQuota.flush();
    const opsGrant = await client.adminSectionGrant.create({ data: { adminUserId: ids.ops, module: "mail-marketing", section: "cosmicforge", mode: "VIEW", grantedBy: ids.super } });
    try {
      const adminView = await sharedServer.call("ops", "GET", `${mbase}/campaigns/${campaign.id}/report`);
      assert.equal(adminView.status, 200, adminView.text);
      assert.equal(adminView.body.data.providerQuota.scope, "marketing-shared", adminView.text);
      assert.equal(adminView.body.data.providerQuota.monthlyUsed, 40);
      assert.equal(adminView.body.data.providerQuota.monthlyLimit, 1500);
      assert.equal(adminView.body.data.providerQuota.dailyLimit, 50);
      assert.equal(adminView.body.data.providerQuota.visibleBecause, "MAIL_ADMIN");
      const brandView = await sharedServer.call("dave", "GET", `${mbase}/campaigns/${campaign.id}/report`);
      assert.equal(brandView.body.data.providerQuota.status, "HIDDEN");
      const sharedAdmin = (await sharedServer.call("ops", "GET", "/admin/provider-quota")).body.data.items.find((item) => item.scope === "marketing-shared");
      assert.ok(sharedAdmin, "the shared marketing scope is listed for mail admins");
      assert.equal(sharedAdmin.monthlyLimit, 1500);
    } finally {
      await client.adminSectionGrant.delete({ where: { id: opsGrant.id } });
      await client.mailProviderQuotaObservation.deleteMany({ where: { scope: "marketing-shared" } });
    }

    // 429 daily_quota_exceeded during sync: deferred to the reset, no attempt consumed.
    const quotaContact = await newContact("quota@reader.example");
    const campaignId = await approvedCampaign("Quota", [quotaContact]);
    assert.equal((await schedule(campaignId)).status, 201);
    harness.advance(180000);
    fake.failNext("findSegmentByName", "QUOTA_EXHAUSTED", "DAILY", { now: harness.clock() });
    await worker.drain({ maxTicks: 5 });
    const dispatch = await dispatchOf(campaignId);
    const job = await client.mailOutboxJob.findUnique({ where: { idempotencyKey: `broadcast:${dispatch.id}` } });
    assert.equal(job.status, "RETRY_SCHEDULED");
    assert.equal(job.lastErrorCode, "PROVIDER_QUOTA_EXHAUSTED");
    assert.equal(job.attemptCount, 0, "deferral consumes no attempt");
    const now = harness.clock();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    assert.ok(Math.abs(job.nextAttemptAt.getTime() - midnight) <= 2000, `deferred to next UTC midnight (${job.nextAttemptAt.toISOString()})`);
    assert.equal(dispatch.lastErrorCode, "RESEND_DAILY_QUOTA_EXCEEDED");
    assert.equal((await call("dave", "POST", `${mbase}/campaigns/${campaignId}/cancel`, { reason: "test cleanup" })).status, 200);
  });
});

test("final gaps 2+3 on a database without migration 37: endpoints answer 503, consent, sends and reports keep working", { timeout: 600000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const { client, harness, ids, brands, main } = await scenario(t, { rollback: true });
  const call = main.call;
  const cf = brands.cosmicforge;
  const mbase = `/marketing/${cf.organization.id}`;
  const fake = harness.marketingAdapter;
  const worker = harness.mail.createWorker({ queues: ["MARKETING", "EVENTS"] });
  const work = async (rounds = 2, stepMs = 2000) => {
    for (let index = 0; index < rounds; index += 1) {
      harness.advance(stepMs);
      await worker.drain({ maxTicks: 20 });
    }
  };
  const stepUp = async (key, purpose) => {
    harness.advance(31000);
    return (await call(key, "POST", "/security/step-up", { code: totp(harness.clock), purpose })).body.data.stepUpId;
  };
  for (const [user, method, route, body] of [
    ["erin", "GET", `${mbase}/resubscriptions`],
    ["erin", "POST", `${mbase}/resubscriptions/${crypto.randomUUID()}/approve`, {}],
    ["dave", "GET", `${mbase}/provider-states?contactIds=${crypto.randomUUID()}`],
    ["ops", "GET", "/admin/provider-quota"],
    ["ops", "GET", "/admin/pricing"],
    ["ops", "POST", "/admin/pricing", { provider: "fake", currency: "USD", unitCost: "0.001", effectiveFrom: "2020-01-01T00:00:00Z", source: "CONTRACT", reference: "x" }],
  ]) {
    const response = await call(user, method, route, body);
    assert.equal(response.status, 503, `${method} ${route}: ${response.text}`);
    assert.equal(response.body.code, "MAIL_FEATURE_NOT_READY");
    assert.equal(response.body.retryable, true);
  }
  // Quota recording is a no-op, never an error.
  harness.mail.services.providerQuota.record("account", "fake", { headers: new Headers({ "x-resend-monthly-quota": "5" }), status: 200 });
  await harness.mail.services.providerQuota.flush();

  // Consent: provider unsubscribe withdraws, a double opt-in confirms, no request table needed.
  const contact = (await call("dave", "POST", `${mbase}/contacts`, { email: "pre@reader.example", consent: { topic: "newsletter", source: "WEB_FORM", policyVersion: "2026-10", evidence: { reference: "form-pre" } } })).body.data;
  const remote = { id: "fake_contact_pre", email: "pre@reader.example", unsubscribed: true, segments: new Set() };
  fake.state.contacts.set("pre@reader.example", remote);
  const at = harness.clock().toISOString();
  await postWebhook(main.base, harness.clock, "contact.updated", { id: remote.id, email: "pre@reader.example", unsubscribed: true, created_at: at, updated_at: at }, { path: "/webhooks/resend/brand/cosmicforge", secret: BRAND_WEBHOOK_SECRETS.cosmicforge });
  await work(1);
  assert.equal((await client.marketingConsent.findFirst({ where: { contactId: contact.id } })).status, "WITHDRAWN", "provider unsubscribe still withdraws consent");
  const recorded = await call("dave", "POST", `${mbase}/contacts/${contact.id}/consents`, { topic: "newsletter", source: "WEB_FORM", policyVersion: "2026-10", evidence: { reference: "form-pre-2" }, doubleOptIn: true });
  const confirmed = await call(null, "POST", "/public/consent/confirm", { token: recorded.body.data.confirmationToken });
  assert.equal(confirmed.status, 200, confirmed.text);

  // A broadcast still dispatches and finalizes; the report says spend UNAVAILABLE.
  const sendTo = (await call("dave", "POST", `${mbase}/contacts`, { email: "send@reader.example", consent: { topic: "newsletter", source: "WEB_FORM", policyVersion: "2026-10", evidence: { reference: "form-send" } } })).body.data;
  const template = await call("dave", "POST", `${mbase}/templates`, { name: "Pre-37" });
  const version = await call("dave", "POST", `${mbase}/templates/${template.body.data.id}/versions`, { subject: "Hi {{first_name}}", blocks: [{ type: "text", text: "Hello from {{brand_name}}." }] });
  assert.equal(version.status, 201, version.text);
  const audience = await call("dave", "POST", `${mbase}/audiences`, { name: "Pre-37", topic: "newsletter" });
  await call("dave", "POST", `${mbase}/audiences/${audience.body.data.id}/contacts`, { contactIds: [sendTo.id] });
  const campaign = await call("dave", "POST", `${mbase}/campaigns`, { name: "Pre-37", topic: "newsletter", templateVersionId: version.body.data.id, audienceId: audience.body.data.id, senderAddressId: cf.sender.id, frequencyCapHours: 0 });
  assert.equal(campaign.status, 201, campaign.text);
  await call("dave", "POST", `${mbase}/campaigns/${campaign.body.data.id}/submit`, { revision: 1 });
  const approved = await call("erin", "POST", `${mbase}/campaigns/${campaign.body.data.id}/approve`, { revision: 1, stepUpId: await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL") });
  assert.equal(approved.status, 200, approved.text);
  assert.equal((await call("dave", "POST", `${mbase}/campaigns/${campaign.body.data.id}/schedule`, { revision: 1, sendAtUtc: new Date(harness.clock().getTime() + 120000).toISOString() })).status, 201);
  harness.advance(180000);
  await work(6);
  const dispatch = await client.marketingBroadcastDispatch.findUnique({ where: { campaignId: campaign.body.data.id } });
  assert.equal(dispatch.status, "SENDING", JSON.stringify(dispatch));
  fake.completeBroadcast(dispatch.providerBroadcastId);
  harness.advance(61000);
  await work(2);
  assert.equal((await client.marketingBroadcastDispatch.findUnique({ where: { id: dispatch.id } })).status, "COMPLETED");
  const report = await call("erin", "GET", `${mbase}/campaigns/${campaign.body.data.id}/report`);
  assert.equal(report.status, 200, report.text);
  assert.equal(report.body.data.spend.status, "UNAVAILABLE");
  assert.equal(report.body.data.spend.billedStatus, "UNAVAILABLE");
  assert.equal(report.body.data.providerQuota.status, "UNAVAILABLE");
  const overview = await call("dave", "GET", `${mbase}/reports/overview`);
  assert.equal(overview.status, 200, overview.text);
  assert.equal(overview.body.data.spend.available, false);
  assert.equal(ids.ops.length > 0, true);
});
