"use strict";

// Delivery reconciliation for marketing mail (M7). Called by the shared
// PROCESS_DELIVERY_EVENT job for:
// - broadcast email events (data.broadcast_id) -> marketing_broadcast_recipients
// - automation / confirmation sends (provider message id) -> step runs
// - contact.updated with unsubscribed=true -> brand-wide withdrawal
// Rules: status never regresses (rank order); provider acceptance is not
// delivery; bounces and complaints suppress the address for that brand only;
// events are matched to a brand through records CosmicForge created, and a
// brand-endpoint event can only affect its own brand.

const { normalizeAddress } = require("../security/address.util");
const { enforceWithdrawal } = require("./consent-enforcement");

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

function createMarketingEventsProcessor({ client, audit, clock = () => new Date() }) {
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

  async function suppress(tx, organizationId, email, status) {
    if (status === "BOUNCED") return enforceWithdrawal(tx, { organizationId, email, reason: "BOUNCED", source: "provider_event", now: clock() });
    if (status === "COMPLAINED") return enforceWithdrawal(tx, { organizationId, email, reason: "COMPLAINED", source: "provider_event", now: clock() });
    return null;
  }

  async function handleBroadcastEvent(event) {
    const meta = eventMeta(event);
    const dispatch = await client.marketingBroadcastDispatch.findFirst({ where: { providerBroadcastId: String(meta.data.broadcast_id) } });
    if (!dispatch) return { matched: 0, reason: "UNKNOWN_BROADCAST" };
    if (meta.brandOrganizationId && meta.brandOrganizationId !== dispatch.organizationId) return { matched: 0, reason: "CROSS_BRAND_EVENT_REJECTED" };
    const status = EVENT_TO_STATUS[meta.type];
    let matched = 0;
    await client.$transaction(async (tx) => {
      for (const email of meta.recipients) {
        const recipient = await tx.marketingBroadcastRecipient.findFirst({ where: { dispatchId: dispatch.id, email } });
        if (!recipient) continue;
        matched += 1;
        const data = { lastEventType: meta.type.slice(0, 32), lastEventAt: meta.occurredAt, providerEmailId: recipient.providerEmailId || String(meta.data.email_id || "").slice(0, 255) || null };
        if (meta.type === "email.opened" && !recipient.openedAt) data.openedAt = meta.occurredAt;
        if (meta.type === "email.clicked" && !recipient.clickedAt) data.clickedAt = meta.occurredAt;
        if (status && !FINAL_SKIP.has(recipient.status) && (RANK[status] ?? 0) >= (RANK[recipient.status] ?? 0)) data.status = status;
        await tx.marketingBroadcastRecipient.update({ where: { id: recipient.id }, data });
        if (status === "BOUNCED" || status === "COMPLAINED") await suppress(tx, dispatch.organizationId, email, status);
      }
      if (matched) await audit.record({ action: `MARKETING_BROADCAST_EVENT_${String(meta.type).split(".")[1].toUpperCase()}`, targetType: "marketing_broadcast", targetId: dispatch.id, organizationId: dispatch.organizationId, metadata: { recipients: matched } }, {}, tx);
    });
    return { matched };
  }

  async function handleSingleSendEvent(event, run) {
    const meta = eventMeta(event);
    if (meta.brandOrganizationId && meta.brandOrganizationId !== run.organizationId) return { matched: 0, reason: "CROSS_BRAND_EVENT_REJECTED" };
    const status = EVENT_TO_STATUS[meta.type];
    await client.$transaction(async (tx) => {
      if (status && (RANK[status] ?? 0) >= (RANK[run.deliveryStatus] ?? 0)) {
        await tx.marketingAutomationStepRun.update({ where: { id: run.id }, data: { deliveryStatus: status } });
      }
      if ((status === "BOUNCED" || status === "COMPLAINED") && run.recipientEmail) await suppress(tx, run.organizationId, run.recipientEmail, status);
      await audit.record({ action: `MARKETING_AUTOMATION_EVENT_${String(meta.type).split(".")[1].toUpperCase()}`, targetType: "marketing_automation_step_run", targetId: run.id, organizationId: run.organizationId }, {}, tx);
    });
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
    for (const row of organizations) {
      await client.$transaction(async (tx) => {
        const result = await enforceWithdrawal(tx, { organizationId: row.organizationId, email: row.email || email, reason: "UNSUBSCRIBED", source: "provider_unsubscribe", now: clock() });
        if (result.applied) {
          applied += 1;
          await audit.record({ action: "MARKETING_PROVIDER_UNSUBSCRIBE_APPLIED", targetType: "marketing_contact", targetId: result.contactId, organizationId: row.organizationId, metadata: { withdrawn: result.withdrawn, enrollmentsExited: result.enrollmentsExited } }, {}, tx);
        }
      });
    }
    return { matched: applied };
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
