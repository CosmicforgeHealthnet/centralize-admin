"use strict";

// Delivery reconciliation for marketing mail (M7). Called by the shared
// PROCESS_DELIVERY_EVENT job for:
// - broadcast email events (data.broadcast_id) -> marketing_broadcast_recipients
// - automation / confirmation sends (provider message id) -> step runs
// - contact.updated with unsubscribed=true -> brand-wide withdrawal
// Rules: status never regresses (rank order); provider acceptance is not
// delivery; hard (Permanent) bounces and provider suppressions suppress the
// address for that brand only and never touch consent; soft bounces only
// record status; complaints withdraw the brand's consent and suppress;
// events are matched to a brand through records CosmicForge created, and a
// brand-endpoint event can only affect its own brand. Delivery evidence is
// kept as a mail_delivery_events row so "delivered" never falls when a later
// complaint or bounce replaces the recipient status.
// GAP 2: the provider's view of each contact is also recorded
// (marketing_contact_provider_states, via resubscriptions.observe, after the
// consent transaction commits): hard bounce -> SUPPRESSED/HARD_BOUNCE,
// complaint -> SUPPRESSED/COMPLAINT, provider suppression ->
// SUPPRESSED/PROVIDER_SUPPRESSED, contact.updated unsubscribed ->
// UNSUBSCRIBED/USER_UNSUBSCRIBE. Soft bounces change nothing. A provider
// unsubscribe that occurred before an APPLIED re-subscription is stale and
// no longer withdraws the newer, verified consent (audited, not silent).

const { normalizeAddress } = require("../security/address.util");
const { enforceWithdrawal, suppressAddress } = require("./consent-enforcement");

const EVENT_TO_STATUS = {
  "email.sent": "PROVIDER_ACCEPTED",
  "email.scheduled": "PROVIDER_ACCEPTED",
  "email.delivered": "DELIVERED",
  "email.delivery_delayed": "DELAYED",
  "email.bounced": "BOUNCED",
  "email.complained": "COMPLAINED",
  "email.failed": "FAILED",
  "email.suppressed": "SUPPRESSED",
};
const RANK = { PENDING: 0, SYNCED: 1, OUTCOME_UNKNOWN: 1.5, PROVIDER_ACCEPTED: 2, DELAYED: 3, DELIVERED: 4, FAILED: 5, SUPPRESSED: 5, BOUNCED: 6, COMPLAINED: 7 };
const FINAL_SKIP = new Set(["EXCLUDED", "CANCELLED", "UNSUBSCRIBED"]);

// Statuses a new status may replace. Used as a conditional UPDATE predicate
// so two concurrent events for one recipient can never regress its status:
// PostgreSQL re-checks the WHERE clause after waiting for the row lock.
function replaceable(status) {
  return Object.keys(RANK).filter((key) => RANK[key] <= RANK[status]);
}

// Provider state implied by a delivery status (null = no change).
function providerStateFor(status, data, isHardBounce) {
  if (status === "BOUNCED") return isHardBounce(data) ? { state: "SUPPRESSED", reason: "HARD_BOUNCE" } : null;
  if (status === "COMPLAINED") return { state: "SUPPRESSED", reason: "COMPLAINT" };
  if (status === "SUPPRESSED") return { state: "SUPPRESSED", reason: "PROVIDER_SUPPRESSED" };
  return null;
}

function createMarketingEventsProcessor({ client, audit, resubscriptions = null, clock = () => new Date() }) {
  // Runs after the caller's transaction committed; never throws.
  async function observeAll(observations) {
    if (!resubscriptions) return;
    for (const entry of observations) await resubscriptions.observe(entry).catch(() => null);
  }

  function eventMeta(event) {
    const payload = event.payload || {};
    const data = payload.data || {};
    return {
      type: event.eventType,
      data,
      brandOrganizationId: payload.brand_organization_id || null,
      occurredAt: new Date(payload.created_at || data.created_at || event.receivedAt),
      recipients: [...new Set((Array.isArray(data.to) ? data.to : [data.to]).map(normalizeAddress).filter(Boolean))],
    };
  }

  // Only a Permanent (hard) bounce is evidence that the address is dead.
  function isHardBounce(data) {
    return /^(permanent|hard)$/i.test(String(data?.bounce?.type || ""));
  }

  async function suppress(tx, organizationId, email, status, data) {
    if (status === "BOUNCED") return isHardBounce(data) ? suppressAddress(tx, { organizationId, email, reason: "BOUNCED", source: "provider_hard_bounce" }) : null;
    // A complaint is a withdrawal of consent for this brand.
    if (status === "COMPLAINED") return enforceWithdrawal(tx, { organizationId, email, reason: "COMPLAINED", source: "provider_event", now: clock() });
    // Provider-side suppression list (prior hard bounces / complaints on the
    // provider account). No dedicated enum value exists; BOUNCED is the
    // closest liftable reason, the source says where it came from.
    if (status === "SUPPRESSED") return suppressAddress(tx, { organizationId, email, reason: "BOUNCED", source: "provider_suppressed", contactStatus: "SUPPRESSED" });
    return null;
  }

  // One evidence row per recipient: the report counts delivered from it.
  async function recordDeliveryEvidence(tx, event, meta, dispatch, recipient) {
    const existing = await tx.mailDeliveryEvent.findFirst({ where: { messageId: null, eventType: "DELIVERED", detail: { path: ["recipientId"], equals: recipient.id } }, select: { id: true } });
    if (existing) return;
    await tx.mailDeliveryEvent.create({ data: { webhookEventId: event.id || null, providerMessageId: String(meta.data.email_id || `broadcast:${dispatch.id}`).slice(0, 255), recipient: recipient.email, eventType: "DELIVERED", occurredAt: meta.occurredAt, detail: { marketing: true, dispatchId: dispatch.id, recipientId: recipient.id } } });
  }

  async function handleBroadcastEvent(event) {
    const meta = eventMeta(event);
    const dispatch = await client.marketingBroadcastDispatch.findFirst({ where: { providerBroadcastId: String(meta.data.broadcast_id) } });
    if (!dispatch) return { matched: 0, reason: "UNKNOWN_BROADCAST" };
    if (meta.brandOrganizationId && meta.brandOrganizationId !== dispatch.organizationId) return { matched: 0, reason: "CROSS_BRAND_EVENT_REJECTED" };
    const status = EVENT_TO_STATUS[meta.type];
    let matched = 0;
    const observations = [];
    await client.$transaction(async (tx) => {
      for (const email of meta.recipients) {
        const recipient = await tx.marketingBroadcastRecipient.findFirst({ where: { dispatchId: dispatch.id, email } });
        if (!recipient) continue;
        matched += 1;
        const data = { lastEventType: meta.type.slice(0, 32), lastEventAt: meta.occurredAt, providerEmailId: recipient.providerEmailId || String(meta.data.email_id || "").slice(0, 255) || null };
        if (meta.type === "email.opened" && !recipient.openedAt) data.openedAt = meta.occurredAt;
        if (meta.type === "email.clicked" && !recipient.clickedAt) data.clickedAt = meta.occurredAt;
        await tx.marketingBroadcastRecipient.update({ where: { id: recipient.id }, data });
        if (status && !FINAL_SKIP.has(recipient.status)) await tx.marketingBroadcastRecipient.updateMany({ where: { id: recipient.id, status: { in: replaceable(status) } }, data: { status } });
        if (status === "DELIVERED") await recordDeliveryEvidence(tx, event, meta, dispatch, recipient);
        if (status === "BOUNCED" || status === "COMPLAINED" || status === "SUPPRESSED") await suppress(tx, dispatch.organizationId, email, status, meta.data);
        const providerState = providerStateFor(status, meta.data, isHardBounce);
        if (providerState) observations.push({ organizationId: dispatch.organizationId, contactId: recipient.contactId, ...providerState, observedAt: meta.occurredAt });
      }
      if (matched) await audit.record({ action: `MARKETING_BROADCAST_EVENT_${String(meta.type).split(".")[1].toUpperCase()}`, targetType: "marketing_broadcast", targetId: dispatch.id, organizationId: dispatch.organizationId, metadata: { recipients: matched } }, {}, tx);
    });
    await observeAll(observations);
    return { matched };
  }

  async function handleSingleSendEvent(event, run) {
    const meta = eventMeta(event);
    if (meta.brandOrganizationId && meta.brandOrganizationId !== run.organizationId) return { matched: 0, reason: "CROSS_BRAND_EVENT_REJECTED" };
    const status = EVENT_TO_STATUS[meta.type];
    await client.$transaction(async (tx) => {
      if (status) await tx.marketingAutomationStepRun.updateMany({ where: { id: run.id, OR: [{ deliveryStatus: null }, { deliveryStatus: { in: replaceable(status) } }] }, data: { deliveryStatus: status } });
      // Engagement for automation condition steps (engagement.previous_send_*).
      // Merged atomically so concurrent events never drop each other's flag.
      const flag = meta.type === "email.opened" ? { opened: true } : meta.type === "email.clicked" ? { clicked: true } : null;
      if (flag) await tx.$executeRaw`UPDATE "marketing_automation_step_runs" SET "outcome" = COALESCE("outcome", '{}'::jsonb) || ${JSON.stringify(flag)}::jsonb, "updated_at" = now() WHERE "id" = ${run.id}::uuid`;
      if ((status === "BOUNCED" || status === "COMPLAINED" || status === "SUPPRESSED") && run.recipientEmail) await suppress(tx, run.organizationId, run.recipientEmail, status, meta.data);
      await audit.record({ action: `MARKETING_AUTOMATION_EVENT_${String(meta.type).split(".")[1].toUpperCase()}`, targetType: "marketing_automation_step_run", targetId: run.id, organizationId: run.organizationId }, {}, tx);
    });
    const providerState = providerStateFor(status, meta.data, isHardBounce);
    if (providerState && run.recipientEmail) await observeAll([{ organizationId: run.organizationId, email: run.recipientEmail, ...providerState, observedAt: meta.occurredAt }]);
    return { matched: 1 };
  }

  // contact.updated (unsubscribed=true): the provider recorded a global
  // unsubscribe for its account. Brand-endpoint events carry the brand;
  // company-endpoint events are matched through recipient rows we created.
  async function handleContactUpdated(event) {
    const meta = eventMeta(event);
    if (meta.data.unsubscribed !== true) return { matched: 0, reason: "NOT_AN_UNSUBSCRIBE" };
    const providerContactId = String(meta.data.contact_id || "");
    const email = normalizeAddress(meta.data.email);
    const rows = await client.marketingBroadcastRecipient.findMany({
      where: { OR: [...(providerContactId ? [{ providerContactId }] : []), ...(email ? [{ email }] : [])], ...(meta.brandOrganizationId ? { organizationId: meta.brandOrganizationId } : {}) },
      select: { organizationId: true, contactId: true, providerContactId: true, email: true },
      distinct: ["organizationId"],
      take: 20,
    });
    // Without a brand endpoint, an email match alone is not enough to pick a
    // brand: require the provider contact id we stored.
    const scoped = meta.brandOrganizationId ? rows : rows.filter((row) => providerContactId && row.providerContactId === providerContactId);
    const organizations = meta.brandOrganizationId && !scoped.length && email ? [{ organizationId: meta.brandOrganizationId, email }] : scoped;
    let applied = 0;
    let superseded = 0;
    // The event's own creation time (kept across webhook retries) is when the
    // provider recorded the unsubscribe.
    const unsubscribedAt = Number.isNaN(meta.occurredAt.getTime()) ? clock() : meta.occurredAt;
    for (const row of organizations) {
      const contactId = row.contactId || (await client.marketingContact.findUnique({ where: { organizationId_email: { organizationId: row.organizationId, email: String(row.email || email || "").toLowerCase() } }, select: { id: true } }).catch(() => null))?.id || null;
      const newer = resubscriptions ? await resubscriptions.supersededBy(row.organizationId, contactId, unsubscribedAt) : null;
      if (newer) {
        superseded += 1;
        await audit.record({ action: "MARKETING_PROVIDER_UNSUBSCRIBE_SUPERSEDED", targetType: "marketing_contact", targetId: contactId, organizationId: row.organizationId, metadata: { contactId, resubscriptionId: newer.id, unsubscribedAt: unsubscribedAt.toISOString(), resubscribedAt: newer.completedAt.toISOString() } });
        continue;
      }
      let withdrawnContactId = null;
      await client.$transaction(async (tx) => {
        const result = await enforceWithdrawal(tx, { organizationId: row.organizationId, email: row.email || email, reason: "UNSUBSCRIBED", source: "provider_unsubscribe", now: clock() });
        if (result.applied) {
          applied += 1;
          withdrawnContactId = result.contactId;
          await audit.record({ action: "MARKETING_PROVIDER_UNSUBSCRIBE_APPLIED", targetType: "marketing_contact", targetId: result.contactId, organizationId: row.organizationId, metadata: { withdrawn: result.withdrawn, enrollmentsExited: result.enrollmentsExited } }, {}, tx);
        }
      });
      if (withdrawnContactId) await observeAll([{ organizationId: row.organizationId, contactId: withdrawnContactId, state: "UNSUBSCRIBED", reason: "USER_UNSUBSCRIBE", observedAt: unsubscribedAt }]);
    }
    return { matched: applied, ...(superseded ? { superseded } : {}) };
  }

  // Returns null when the event is not marketing-related (transactional path continues).
  async function route(event) {
    const data = event.payload?.data || {};
    if (event.eventType === "contact.updated") return handleContactUpdated(event);
    if (data.broadcast_id) return handleBroadcastEvent(event);
    const providerMessageId = String(data.email_id || "");
    if (providerMessageId) {
      const run = await client.marketingAutomationStepRun.findFirst({ where: { providerMessageId } });
      if (run) return handleSingleSendEvent(event, run);
    }
    if (event.payload?.brand_organization_id) return { matched: 0, reason: "UNMATCHED_BRAND_EVENT" };
    if (event.eventType === "email.suppressed" || event.eventType === "email.scheduled") return { matched: 0, reason: "UNMATCHED" };
    return null;
  }

  return { route, handleBroadcastEvent, handleContactUpdated, EVENT_TO_STATUS };
}

module.exports = { createMarketingEventsProcessor, RANK: RANK };
