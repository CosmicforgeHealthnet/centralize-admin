"use strict";

// Marketing broadcast cancellation semantics (spec §18 / §20) on real
// PostgreSQL with the offline fake marketing provider, which models Resend's
// documented POST /broadcasts/{id}/cancel: scheduled -> draft (nothing sent);
// queued -> canceled (mail still queued is dropped, mail already sent is NOT
// recalled and keeps producing events); sent -> refused.
// Covers: cancel after sending started is PARTIAL (never rewrites possibly
// sent recipients), late events still apply, CANCELLED -> PARTIAL evidence
// correction, guarded campaign transitions, pause/resume visibility,
// provider resource cleanup, provider `sent` evidence, and the audience
// sync rules (consent re-check, provider unsubscribes, suppression, brands).

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp, postWebhook } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");
const { createBroadcastProcessor, transitionCampaign } = require("../src/modules/mail/marketing/broadcast.processor");
const { enforceWithdrawal } = require("../src/modules/mail/marketing/consent-enforcement");

test("CosmicForge Mail broadcast cancellation semantics on real PostgreSQL", { timeout: 600000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client);
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const { server, base } = await listen(harness.mountApp(harness.mail));
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
  const consent = (topic = "newsletter") => ({ topic, source: "WEB_FORM", policyVersion: "2026-10", evidence: { reference: `form-${crypto.randomUUID().slice(0, 8)}` } });
  const newContact = async (email, organizationBase = mbase, user = "dave") => {
    const response = await call(user, "POST", `${organizationBase}/contacts`, { email, firstName: email.split("@")[0], consent: consent() });
    assert.equal(response.status, 201, response.text);
    return response.body.data;
  };
  let templateVersionId;
  const approvedCampaign = async (name, emails) => {
    const contacts = [];
    for (const email of emails) contacts.push(await newContact(email));
    const audience = await call("dave", "POST", `${mbase}/audiences`, { name: `${name} audience`, topic: "newsletter" });
    await call("dave", "POST", `${mbase}/audiences/${audience.body.data.id}/contacts`, { contactIds: contacts.map((contact) => contact.id) });
    const campaign = await call("dave", "POST", `${mbase}/campaigns`, { name, topic: "newsletter", templateVersionId, audienceId: audience.body.data.id, senderAddressId: cf.sender.id, frequencyCapHours: 0 });
    assert.equal(campaign.status, 201, campaign.text);
    assert.equal((await call("dave", "POST", `${mbase}/campaigns/${campaign.body.data.id}/submit`, { revision: 1 })).status, 200);
    const approved = await call("erin", "POST", `${mbase}/campaigns/${campaign.body.data.id}/approve`, { revision: 1, stepUpId: await stepUp("erin", "MARKETING_CAMPAIGN_APPROVAL") });
    assert.equal(approved.status, 200, approved.text);
    return { id: campaign.body.data.id, audienceId: audience.body.data.id, contacts };
  };
  const schedule = (campaignId) => call("dave", "POST", `${mbase}/campaigns/${campaignId}/schedule`, { revision: 1, sendAtUtc: new Date(harness.clock().getTime() + 120000).toISOString() });
  const dispatchOf = (campaignId) => client.marketingBroadcastDispatch.findUnique({ where: { campaignId } });
  const campaignStatus = async (campaignId) => (await client.marketingEmailCampaign.findUnique({ where: { id: campaignId } })).status;
  const recipientsOf = async (dispatchId) => Object.fromEntries((await client.marketingBroadcastRecipient.findMany({ where: { dispatchId } })).map((row) => [row.email, row]));
  const auditActions = async (targetId) => (await client.mailAuditEvent.findMany({ where: { targetId }, orderBy: { createdAt: "asc" } })).map((row) => row.action);
  const event = async (type, dispatch, email, extra = {}) => {
    const response = await postWebhook(base, harness.clock, type, { email_id: `bc_${crypto.randomUUID()}`, broadcast_id: dispatch.providerBroadcastId, to: [email], ...extra });
    assert.equal(response.status, 200);
  };
  const sending = async (name, emails) => {
    const campaign = await approvedCampaign(name, emails);
    assert.equal((await schedule(campaign.id)).status, 201);
    harness.advance(180000);
    await work(6);
    const dispatch = await dispatchOf(campaign.id);
    assert.equal(dispatch.status, "SENDING", JSON.stringify(dispatch));
    return { campaign, dispatch };
  };

  try {
    await t.test("setup: template version", async () => {
      const template = await call("dave", "POST", `${mbase}/templates`, { name: "Cancel newsletter" });
      const version = await call("dave", "POST", `${mbase}/templates/${template.body.data.id}/versions`, { subject: "News for {{first_name}}", blocks: [{ type: "heading", text: "Hello {{first_name}}" }, { type: "text", text: "Update from {{brand_name}}." }] });
      assert.equal(version.status, 201, version.text);
      templateVersionId = version.body.data.id;
    });

    await t.test("HIGH: queued broadcast cancelled after sending started is PARTIAL; sent recipients are never rewritten; late events still apply", async () => {
      const { campaign, dispatch } = await sending("Queued cancel", ["q1@reader.example", "q2@reader.example", "q3@reader.example"]);
      // The provider works through part of the queue before the cancel.
      const sent = fake.progressBroadcast(dispatch.providerBroadcastId, 2);
      assert.equal(sent.length, 2);
      const [first, second] = sent;
      await event("email.sent", dispatch, first.email);
      await event("email.sent", dispatch, second.email);
      await event("email.delivered", dispatch, first.email);
      await work(2);
      const late = await call("dave", "POST", `${mbase}/campaigns/${campaign.id}/cancel`, { reason: "error in copy" });
      assert.equal(late.status, 200, late.text);
      assert.match(late.body.data.note, /cannot be recalled/);
      await work(3, 61000);
      const after = await dispatchOf(campaign.id);
      assert.equal(after.status, "PARTIAL", "cancellation does not undo sends");
      assert.equal(await campaignStatus(campaign.id), "PARTIAL");
      assert.equal(fake.state.broadcasts.get(dispatch.providerBroadcastId).status, "CANCELED");
      assert.ok(fake.state.calls.some((entry) => entry.operation === "cancelBroadcast" && entry.broadcastId === dispatch.providerBroadcastId), "contract cancel reached the provider");
      const rows = await recipientsOf(dispatch.id);
      assert.equal(Object.values(rows).filter((row) => row.status === "CANCELLED").length, 0, "no possibly-sent recipient is rewritten to CANCELLED");
      assert.equal(rows[first.email].status, "DELIVERED");
      assert.equal(rows[second.email].status, "PROVIDER_ACCEPTED");
      // Mail still in the queue is never sent after the cancel.
      assert.deepEqual(fake.completeBroadcast(dispatch.providerBroadcastId), []);
      // Late provider events for already-sent mail keep applying.
      await event("email.delivered", dispatch, second.email);
      await work(2);
      assert.equal((await recipientsOf(dispatch.id))[second.email].status, "DELIVERED");
      await event("email.complained", dispatch, first.email);
      await work(2);
      assert.equal((await recipientsOf(dispatch.id))[first.email].status, "COMPLAINED");
      await event("email.delivery_delayed", dispatch, first.email);
      await work(2);
      assert.equal((await recipientsOf(dispatch.id))[first.email].status, "COMPLAINED", "recipient ranks stay monotonic");
      const report = (await call("dave", "GET", `${mbase}/campaigns/${campaign.id}/report`)).body.data;
      assert.equal(report.dispatch.status, "PARTIAL");
      assert.equal(report.totals.delivered, 2);
      assert.equal(report.totals.providerSent, 2, "provider sent evidence is reported");
      // LOW: the segment is removed once no further sending can happen; a
      // canceled broadcast cannot be deleted (draft/scheduled only).
      assert.equal(fake.state.segments.get(dispatch.providerSegmentId).deleted, true);
      assert.equal(fake.state.calls.some((entry) => entry.operation === "deleteBroadcast" && entry.broadcastId === dispatch.providerBroadcastId), false);
      const actions = await auditActions(dispatch.id);
      assert.ok(actions.includes("MARKETING_BROADCAST_CANCEL_SENT_TO_PROVIDER"));
      assert.ok(actions.includes("MARKETING_BROADCAST_PROVIDER_CLEANUP"));
      const finalized = await client.mailAuditEvent.findFirst({ where: { targetId: dispatch.id, action: "MARKETING_BROADCAST_FINALIZED" } });
      assert.equal(finalized.metadata.sentBeforeCancel, "SOME");
    });

    await t.test("LOW-4: email.sent is kept as SENT evidence (no SENT recipient state)", async () => {
      const dispatch = await client.marketingBroadcastDispatch.findFirst({ where: { campaign: { name: "Queued cancel" } } });
      const sentRows = await client.mailDeliveryEvent.findMany({ where: { messageId: null, eventType: "SENT", detail: { path: ["dispatchId"], equals: dispatch.id } } });
      assert.equal(sentRows.length, 2, "one SENT evidence row per recipient");
      const replay = await client.mailDeliveryEvent.count({ where: { messageId: null, eventType: "SENT" } });
      const recipient = (await recipientsOf(dispatch.id))["q1@reader.example"];
      await event("email.sent", dispatch, recipient.email);
      await work(2);
      assert.equal(await client.mailDeliveryEvent.count({ where: { messageId: null, eventType: "SENT" } }), replay, "SENT evidence is recorded once per recipient");
    });

    await t.test("HIGH: queued cancel with no observed sends is PARTIAL (provider cannot prove nothing was sent); recipients keep PROVIDER_ACCEPTED", async () => {
      const { campaign, dispatch } = await sending("Queued cancel quiet", ["w1@reader.example", "w2@reader.example"]);
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${campaign.id}/cancel`, {})).status, 200);
      await work(3, 61000);
      assert.equal((await dispatchOf(campaign.id)).status, "PARTIAL");
      assert.equal(await campaignStatus(campaign.id), "PARTIAL");
      const rows = Object.values(await recipientsOf(dispatch.id));
      assert.deepEqual(rows.map((row) => row.status), ["PROVIDER_ACCEPTED", "PROVIDER_ACCEPTED"]);
      const finalized = await client.mailAuditEvent.findFirst({ where: { targetId: dispatch.id, action: "MARKETING_BROADCAST_FINALIZED" } });
      assert.equal(finalized.metadata.sentBeforeCancel, "UNKNOWN");
      assert.equal(finalized.metadata.awaitingEvidence, 2);
    });

    await t.test("HIGH + LOW-3: scheduled broadcast returns to draft -> CANCELLED, draft + segment deleted; later delivery evidence corrects it to PARTIAL", async () => {
      const { campaign, dispatch } = await sending("Scheduled cancel", ["s1@reader.example", "s2@reader.example"]);
      // Provider holds the broadcast as scheduled (not yet queued).
      fake.state.broadcasts.get(dispatch.providerBroadcastId).status = "SCHEDULED";
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${campaign.id}/cancel`, {})).status, 200);
      await work(3, 61000);
      const after = await dispatchOf(campaign.id);
      assert.equal(after.status, "CANCELLED", "provider proves nothing was sent");
      assert.equal(await campaignStatus(campaign.id), "CANCELLED");
      assert.equal(after.providerStatus, "DELETED");
      assert.equal(fake.state.broadcasts.get(dispatch.providerBroadcastId).status, "DELETED", "the draft broadcast is deleted");
      assert.equal(fake.state.segments.get(dispatch.providerSegmentId).deleted, true, "the segment is deleted");
      const rows = await recipientsOf(dispatch.id);
      assert.deepEqual(Object.values(rows).map((row) => `${row.status}/${row.exclusionReason}`), ["CANCELLED/CANCELLED_AT_PROVIDER", "CANCELLED/CANCELLED_AT_PROVIDER"]);
      const cleanup = await client.mailAuditEvent.findFirst({ where: { targetId: dispatch.id, action: "MARKETING_BROADCAST_PROVIDER_CLEANUP" } });
      assert.equal(cleanup.metadata.broadcastDeleted, true);
      assert.equal(cleanup.metadata.segmentDeleted, true);
      // Contradicting evidence: the provider reports a delivery anyway.
      await event("email.delivered", dispatch, "s1@reader.example");
      await work(2);
      const corrected = await recipientsOf(dispatch.id);
      assert.equal(corrected["s1@reader.example"].status, "DELIVERED", "events for a cancelled-at-provider recipient are applied");
      assert.equal(corrected["s1@reader.example"].exclusionReason, null);
      assert.equal(corrected["s2@reader.example"].status, "CANCELLED");
      assert.equal((await dispatchOf(campaign.id)).status, "PARTIAL", "CANCELLED -> PARTIAL on delivery evidence");
      assert.equal(await campaignStatus(campaign.id), "PARTIAL");
      assert.ok((await auditActions(dispatch.id)).includes("MARKETING_BROADCAST_CANCEL_CORRECTED"));
    });

    await t.test("cancel after the provider already sent everything is refused at the provider and finalises COMPLETED", async () => {
      const { campaign, dispatch } = await sending("Sent cancel", ["z1@reader.example"]);
      fake.completeBroadcast(dispatch.providerBroadcastId);
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${campaign.id}/cancel`, {})).status, 200);
      await work(3, 61000);
      assert.equal((await dispatchOf(campaign.id)).status, "COMPLETED");
      assert.equal(await campaignStatus(campaign.id), "COMPLETE");
      const sentToProvider = await client.mailAuditEvent.findFirst({ where: { targetId: dispatch.id, action: "MARKETING_BROADCAST_CANCEL_SENT_TO_PROVIDER" } });
      assert.equal(sentToProvider.metadata.outcome, "NOT_CANCELLABLE_ALREADY_SENT");
      assert.equal(fake.state.calls.some((entry) => entry.operation === "cancelBroadcast" && entry.broadcastId === dispatch.providerBroadcastId), false, "a sent broadcast is never cancel-posted");
      assert.equal((await recipientsOf(dispatch.id))["z1@reader.example"].status, "PROVIDER_ACCEPTED");
      assert.equal(fake.state.segments.get(dispatch.providerSegmentId).deleted, true);
    });

    await t.test("MEDIUM: worker status writes are compare-and-set against the legal transition tables", async () => {
      const { campaign, dispatch } = await sending("Guarded", ["g1@reader.example"]);
      // A concurrent writer already finalised the dispatch as CANCELLED.
      await client.marketingBroadcastDispatch.update({ where: { id: dispatch.id }, data: { status: "CANCELLED" } });
      await client.marketingEmailCampaign.update({ where: { id: campaign.id }, data: { status: "CANCELLED" } });
      fake.state.broadcasts.get(dispatch.providerBroadcastId).status = "SENT";
      // A reconcile run that loaded the dispatch before that write.
      let staleReads = 0;
      const staleClient = new Proxy(client, {
        get(target, prop) {
          const value = target[prop];
          if (prop !== "marketingBroadcastDispatch") return typeof value === "function" ? value.bind(target) : value;
          return new Proxy(value, {
            get(delegate, method) {
              if (method === "findUnique") return async (args) => {
                const row = await delegate.findUnique(args);
                return row && staleReads++ === 0 ? { ...row, status: "SENDING" } : row;
              };
              const member = delegate[method];
              return typeof member === "function" ? member.bind(delegate) : member;
            },
          });
        },
      });
      const stale = createBroadcastProcessor({ client: staleClient, config: harness.mail.config, audit: harness.mail.audit, jobs: harness.mail.jobs, marketingProviders: harness.mail.marketingProviders, eligibility: harness.mail.services.marketing.eligibleContacts, clock: harness.clock });
      const outcome = await stale.processReconcile({ payload: { dispatchId: dispatch.id } });
      assert.equal(outcome.skipped, "TRANSITION_REJECTED");
      assert.equal((await dispatchOf(campaign.id)).status, "CANCELLED", "a terminal dispatch is never overwritten");
      assert.equal(await campaignStatus(campaign.id), "CANCELLED", "a terminal campaign is never overwritten");
      const rejected = await client.mailAuditEvent.findFirst({ where: { targetId: dispatch.id, action: "MARKETING_BROADCAST_TRANSITION_REJECTED" } });
      assert.equal(rejected.metadata.from, "CANCELLED");
      assert.equal(rejected.metadata.to, "COMPLETED");
      assert.equal(rejected.metadata.reason, "DISPATCH_TERMINAL");
      // Campaign table: terminal states are never left, except the
      // CANCELLED -> PARTIAL evidence correction.
      const ctx = { campaignId: campaign.id, organizationId: cf.organization.id, dispatchId: dispatch.id };
      assert.equal(await transitionCampaign(client, harness.mail.audit, { ...ctx, to: "COMPLETE" }), false);
      assert.equal(await transitionCampaign(client, harness.mail.audit, { ...ctx, to: "SENDING" }), false);
      assert.equal(await transitionCampaign(client, harness.mail.audit, { ...ctx, to: "PARTIAL" }), false, "PARTIAL from CANCELLED needs evidence");
      assert.equal(await campaignStatus(campaign.id), "CANCELLED");
      const campaignRejections = await client.mailAuditEvent.findMany({ where: { targetId: campaign.id, action: "MARKETING_CAMPAIGN_TRANSITION_REJECTED" } });
      assert.equal(campaignRejections.length, 3);
      assert.ok(campaignRejections.every((row) => row.metadata.reason === "CAMPAIGN_TERMINAL" && row.metadata.from === "CANCELLED"));
      assert.equal(await transitionCampaign(client, harness.mail.audit, { ...ctx, to: "PARTIAL", correction: true }), true);
      assert.equal(await campaignStatus(campaign.id), "PARTIAL");
      assert.equal(await transitionCampaign(client, harness.mail.audit, { ...ctx, to: "CANCELLED" }), false, "PARTIAL is terminal");
    });

    await t.test("MEDIUM: pause / resume are reflected consistently (campaign enum has no PAUSED: campaign keeps its status, dispatch exposes the pause)", async () => {
      const campaign = await approvedCampaign("Pause view", ["p1@reader.example"]);
      assert.equal((await schedule(campaign.id)).status, 201);
      const paused = await call("dave", "POST", `${mbase}/campaigns/${campaign.id}/pause`);
      assert.equal(paused.body.data.status, "PAUSED");
      assert.equal(paused.body.data.paused, true);
      const view = (await call("dave", "GET", `${mbase}/campaigns/${campaign.id}/dispatch`)).body.data;
      assert.equal(view.campaignStatus, "SCHEDULED");
      assert.equal(view.campaignPaused, true);
      assert.equal(view.dispatch.paused, true);
      harness.advance(180000);
      await work(3);
      assert.equal(await campaignStatus(campaign.id), "SCHEDULED", "the worker never moves a paused dispatch's campaign");
      const resumed = await call("dave", "POST", `${mbase}/campaigns/${campaign.id}/resume`);
      assert.equal(resumed.body.data.status, "SCHEDULED");
      assert.equal(resumed.body.data.paused, false);
      // Paused while PREPARING (campaign QUEUED): resume returns both to SCHEDULED.
      const dispatch = await dispatchOf(campaign.id);
      await client.marketingBroadcastDispatch.update({ where: { id: dispatch.id }, data: { status: "PREPARING" } });
      await client.marketingEmailCampaign.update({ where: { id: campaign.id }, data: { status: "QUEUED" } });
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${campaign.id}/pause`)).body.data.status, "PAUSED");
      assert.equal(await campaignStatus(campaign.id), "QUEUED");
      assert.equal((await call("dave", "POST", `${mbase}/campaigns/${campaign.id}/resume`)).body.data.status, "SCHEDULED");
      assert.equal(await campaignStatus(campaign.id), "SCHEDULED");
      await work(6);
      assert.equal((await dispatchOf(campaign.id)).status, "SENDING");
      assert.equal(await campaignStatus(campaign.id), "SENDING");
    });

    await t.test("audience sync: consent re-checked before sync, provider unsubscribes never re-subscribed, suppressed / complained never synced, brand isolation", async () => {
      const emails = ["ok@sync.example", "provunsub@sync.example", "complained@sync.example", "globalsupp@sync.example", "withdrawn@sync.example", "shared@sync.example"];
      const campaign = await approvedCampaign("Sync rules", emails);
      const byEmail = Object.fromEntries(campaign.contacts.map((contact) => [contact.email, contact]));
      // Karryam has its own contact for two of the addresses, with consent.
      const kgShared = await newContact("shared@sync.example", `/marketing/${kg.organization.id}`, "kim");
      const kgUnsub = await newContact("provunsub@sync.example", `/marketing/${kg.organization.id}`, "kim");
      // After approval, before dispatch:
      const pre = await fake.createContact({ email: "provunsub@sync.example" });
      fake.providerUnsubscribe("provunsub@sync.example");
      await client.$transaction((tx) => enforceWithdrawal(tx, { organizationId: cf.organization.id, contactId: byEmail["complained@sync.example"].id, reason: "COMPLAINED", source: "provider_event", now: harness.clock() }));
      await client.marketingSuppression.create({ data: { organizationId: null, email: "globalsupp@sync.example", reason: "BOUNCED", source: "test_global" } });
      await client.marketingConsent.updateMany({ where: { contactId: byEmail["withdrawn@sync.example"].id }, data: { status: "WITHDRAWN", withdrawnAt: harness.clock(), withdrawalSource: "test" } });
      await client.marketingConsent.updateMany({ where: { contactId: byEmail["shared@sync.example"].id }, data: { status: "WITHDRAWN", withdrawnAt: harness.clock(), withdrawalSource: "test" } });
      assert.equal((await schedule(campaign.id)).status, 201);
      const dispatch = await dispatchOf(campaign.id);
      // Eligibility computed earlier (stale): every approved contact. The
      // per-contact re-check right before the sync must still exclude them.
      const staleEligibility = async () => ({ eligible: await client.marketingContact.findMany({ where: { id: { in: campaign.contacts.map((contact) => contact.id) } } }), excludedReasons: {} });
      const processor = createBroadcastProcessor({ client, config: harness.mail.config, audit: harness.mail.audit, jobs: harness.mail.jobs, marketingProviders: harness.mail.marketingProviders, eligibility: staleEligibility, resubscriptions: harness.mail.services.resubscriptions, clock: harness.clock });
      harness.advance(180000);
      const callsBefore = fake.state.calls.length;
      let outcome;
      for (let index = 0; index < 10; index += 1) {
        outcome = await processor.processDispatch({ payload: { dispatchId: dispatch.id } });
        if (!outcome?.defer) break;
      }
      assert.equal(outcome.accepted, true, JSON.stringify(outcome));
      const rows = await recipientsOf(dispatch.id);
      assert.equal(rows["ok@sync.example"].status, "PROVIDER_ACCEPTED");
      assert.equal(rows["provunsub@sync.example"].status, "UNSUBSCRIBED");
      assert.equal(rows["provunsub@sync.example"].exclusionReason, "PROVIDER_UNSUBSCRIBED");
      for (const email of ["complained@sync.example", "globalsupp@sync.example", "withdrawn@sync.example", "shared@sync.example"]) {
        assert.equal(rows[email].status, "EXCLUDED", email);
        assert.equal(rows[email].exclusionReason, "WITHDRAWN_BEFORE_SEND", email);
      }
      const calls = fake.state.calls.slice(callsBefore);
      for (const email of ["complained@sync.example", "globalsupp@sync.example", "withdrawn@sync.example", "shared@sync.example"]) {
        assert.equal(calls.some((entry) => entry.email === email), false, `${email} never reaches the provider`);
      }
      assert.equal(calls.some((entry) => entry.operation === "resubscribeContact"), false, "the sync never re-subscribes");
      assert.equal(fake.state.contacts.get("provunsub@sync.example").unsubscribed, true);
      const synced = await dispatchOf(campaign.id);
      assert.deepEqual(fake.segmentMembers(synced.providerSegmentId).map((contact) => contact.email), ["ok@sync.example"]);
      assert.equal(calls.some((entry) => entry.operation === "addContactToSegment" && entry.contactId === pre.id), false);
      // The provider unsubscribe is honoured for this brand only.
      assert.equal((await client.marketingConsent.findFirst({ where: { contactId: byEmail["provunsub@sync.example"].id } })).status, "WITHDRAWN");
      assert.equal((await client.marketingConsent.findFirst({ where: { contactId: kgUnsub.id } })).status, "GRANTED", "brand isolation: other brand's consent untouched");
      assert.equal((await client.marketingConsent.findFirst({ where: { contactId: kgShared.id } })).status, "GRANTED");
      assert.equal(await client.marketingBroadcastRecipient.count({ where: { dispatchId: dispatch.id, organizationId: { not: cf.organization.id } } }), 0);
    });
  } finally {
    await closeServer(server);
    await db.close();
  }
});
