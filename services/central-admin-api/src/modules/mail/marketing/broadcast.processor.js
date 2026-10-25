"use strict";

// Durable broadcast dispatch (job kinds BROADCAST_DISPATCH, BROADCAST_RECONCILE
// on queue MARKETING). Runs only in a worker process serving MARKETING.
//
// Every phase persists its progress on the dispatch / recipient rows, so a
// crash or restart resumes where it stopped:
//   1 verify      approval snapshot integrity, approval age, sender identity,
//                 sending gate (allowlist, verified domain, kill-switches)
//   2 recipients  approved set  ∩  eligible NOW (consent, suppression,
//                 contact status, frequency cap), recipient + brand caps
//   3 segment     one provider segment per dispatch (found by name on retry)
//   4 sync        each recipient re-checked, then synced to the segment;
//                 provider-side unsubscribes are applied locally
//   5 recheck     withdrawals since sync are removed from the segment
//   6 create      provider broadcast DRAFT (found by name on retry)
//   7 send        provider_send_attempted_at is persisted BEFORE the call. A
//                 lost response is resolved by reading the broadcast status:
//                 draft -> safe to send again; queued/sent -> accepted;
//                 unreadable for too long -> OUTCOME_UNKNOWN. Never re-posted
//                 blindly (provider broadcasts have no idempotency key).
// Reconcile polls the provider until sent/canceled, then finalises.
// Pause / disabled flag / emergency stop defer the job without consuming
// attempts and without deleting anything. Cancellation before the send is
// complete; after the send only unsent mail can be stopped.

const crypto = require("crypto");
const { externalSendBlockReason } = require("../authz/sending-gate");

const TERMINAL = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"]);
const SEND_UNKNOWN_AFTER_MS = 60 * 60 * 1000;

function snapshotHash(snapshot) {
  return crypto.createHash("sha256").update(JSON.stringify({ subject: snapshot.subject, html: snapshot.html, text: snapshot.text, sender: snapshot.senderAddress, replyTo: snapshot.replyTo, templateVersionId: snapshot.templateVersionId })).digest("hex");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

// Approved-template placeholders -> provider merge tags. Personal data is
// merged by the provider from the synced contact; unsubscribe is the
// provider's per-recipient link (reconciled back via contact.updated).
function toProviderContent(value, brandName, { html }) {
  return String(value || "")
    .replace(/\{\{\s*first_name\s*\}\}/g, "{{{contact.first_name}}}")
    .replace(/\{\{\s*last_name\s*\}\}/g, "{{{contact.last_name}}}")
    .replace(/\{\{\s*email\s*\}\}/g, "{{{contact.email}}}")
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/g, "{{{RESEND_UNSUBSCRIBE_URL}}}")
    .replace(/\{\{\s*brand_name\s*\}\}/g, html ? escapeHtml(brandName) : brandName);
}

function dispatchError(code, message, { retryable = false, retryAfterSeconds = null } = {}) {
  return Object.assign(new Error(message || code), { code, retryable, retryAfterSeconds });
}

function createBroadcastProcessor({ client, config, audit, jobs, marketingProviders, eligibility, notifications, runtime = null, usage = null, clock = () => new Date(), logger = null }) {
  const now = () => clock();

  async function brandSettings(organizationId) {
    return (await client.marketingBrandSettings.findUnique({ where: { organizationId } })) || { dispatchPaused: false, maxBroadcastRecipients: config.broadcast.maxRecipients, dailyBroadcastCap: 1000 };
  }

  async function setStatus(dispatch, status, extra = {}, tx = client) {
    await tx.marketingBroadcastDispatch.update({ where: { id: dispatch.id }, data: { status, ...extra } });
    const campaignStatus = { PREPARING: "QUEUED", SENDING: "SENDING", COMPLETED: "COMPLETE", PARTIAL: "PARTIAL", FAILED: "FAILED", CANCELLED: "CANCELLED", OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN" }[status];
    if (campaignStatus) await tx.marketingEmailCampaign.update({ where: { id: dispatch.campaignId }, data: { status: campaignStatus } });
    Object.assign(dispatch, { status, ...extra });
  }

  async function notifyOwners(dispatch, title, subtitle) {
    const campaign = await client.marketingEmailCampaign.findUnique({ where: { id: dispatch.campaignId }, select: { createdByAdminUserId: true, approvedByAdminUserId: true } });
    const ids = [...new Set([campaign?.createdByAdminUserId, campaign?.approvedByAdminUserId, dispatch.scheduledByAdminUserId].filter(Boolean))];
    await notifications?.notifyUsers?.(ids, { icon: title.includes("failed") || title.includes("unknown") ? "xcircle" : "check", title, subtitle }).catch(() => {});
  }

  async function fail(dispatch, code, message) {
    await client.$transaction(async (tx) => {
      await setStatus(dispatch, "FAILED", { lastErrorCode: code.slice(0, 64), lastErrorMessage: String(message || code).slice(0, 500), completedAt: now() }, tx);
      await tx.marketingBroadcastRecipient.updateMany({ where: { dispatchId: dispatch.id, status: { in: ["PENDING", "SYNCED"] } }, data: { status: "CANCELLED", exclusionReason: code.slice(0, 64) } });
      await audit.record({ action: "MARKETING_BROADCAST_FAILED", targetType: "marketing_broadcast", targetId: dispatch.id, organizationId: dispatch.organizationId, outcome: "FAILURE", metadata: { reason: code } }, {}, tx);
    });
    await notifyOwners(dispatch, "Broadcast failed before sending", `${code}: nothing was sent`);
    return { failed: code };
  }

  async function cleanupProviderDraft(dispatch, provider) {
    if (dispatch.providerBroadcastId) await provider.deleteBroadcast(dispatch.providerBroadcastId).catch(() => {});
    if (dispatch.providerSegmentId) await provider.deleteSegment(dispatch.providerSegmentId).catch(() => {});
  }

  async function cancelBeforeSend(dispatch, provider) {
    await cleanupProviderDraft(dispatch, provider);
    await client.$transaction(async (tx) => {
      await setStatus(dispatch, "CANCELLED", { completedAt: now(), providerStatus: dispatch.providerBroadcastId ? "DELETED" : dispatch.providerStatus }, tx);
      await tx.marketingBroadcastRecipient.updateMany({ where: { dispatchId: dispatch.id, status: { in: ["PENDING", "SYNCED"] } }, data: { status: "CANCELLED", exclusionReason: "CANCELLED_BEFORE_SEND" } });
      await audit.record({ action: "MARKETING_BROADCAST_CANCELLED", targetType: "marketing_broadcast", targetId: dispatch.id, organizationId: dispatch.organizationId, metadata: { phase: "before_send", sent: 0 } }, {}, tx);
    });
    return { cancelled: true };
  }

  // ---- phase 1: integrity and authorisation re-checks -------------------
  async function verify(dispatch, organization, provider) {
    const campaign = await client.marketingEmailCampaign.findUnique({ where: { id: dispatch.campaignId } });
    const snapshot = await client.marketingCampaignSnapshot.findUnique({ where: { id: dispatch.approvalSnapshotId } });
    if (!campaign || !snapshot || snapshot.kind !== "APPROVAL" || snapshot.campaignId !== campaign.id) return { error: ["APPROVAL_SNAPSHOT_MISSING", "Approval snapshot is missing"] };
    if (campaign.revision !== snapshot.revision) return { error: ["CAMPAIGN_CHANGED_SINCE_APPROVAL", "Campaign was edited after approval"] };
    const hash = snapshotHash(snapshot);
    if (hash !== snapshot.contentSha256 || hash !== dispatch.contentSha256) return { error: ["APPROVED_CONTENT_INTEGRITY_FAILED", "Approved content does not match its hash"] };
    const approvals = await client.marketingCampaignApproval.findMany({ where: { campaignId: campaign.id, revision: snapshot.revision }, orderBy: { createdAt: "asc" } });
    const approval = approvals.find((entry) => entry.decision === "APPROVED" && entry.snapshotId === snapshot.id);
    if (!approval || approvals.some((entry) => entry.decision === "INVALIDATED" && entry.createdAt > approval.createdAt)) return { error: ["APPROVAL_INVALIDATED", "Approval is no longer valid"] };
    if (now().getTime() - approval.createdAt.getTime() > config.broadcast.approvalTtlDays * 86400000) return { error: ["APPROVAL_EXPIRED", `Approval is older than ${config.broadcast.approvalTtlDays} days`] };
    const sender = await client.mailAddress.findUnique({ where: { address: snapshot.senderAddress }, include: { domain: true } });
    if (!sender || sender.organizationId !== organization.id || sender.status !== "ACTIVE" || !["SHARED", "SYSTEM", "ALIAS"].includes(sender.kind)) return { error: ["SENDER_NOT_AUTHORIZED", "Sender identity is no longer an active brand identity"] };
    const blocked = externalSendBlockReason({ config, providerReady: () => provider.configured !== false && provider.name !== "unconfigured", domain: sender.domain });
    if (blocked) return { error: [blocked, `Sending gate: ${blocked}`] };
    return { campaign, snapshot, sender };
  }

  // ---- phase 2: recipients ------------------------------------------------
  async function buildRecipients(dispatch, campaign, snapshot, settings) {
    const audience = campaign.audienceId ? await client.marketingAudience.findUnique({ where: { id: campaign.audienceId } }) : null;
    if (!audience || audience.organizationId !== dispatch.organizationId || audience.status !== "ACTIVE") return { error: ["AUDIENCE_UNAVAILABLE", "Audience is no longer active"] };
    const segment = campaign.segmentId ? await client.marketingSegment.findUnique({ where: { id: campaign.segmentId } }) : null;
    const { eligible, excludedReasons } = await eligibility({ organizationId: dispatch.organizationId, audience, segment, topic: campaign.topic });
    const approved = new Set((await client.marketingCampaignApprovedContact.findMany({ where: { snapshotId: snapshot.id }, select: { contactId: true } })).map((row) => row.contactId));
    const capWindow = new Date(now().getTime() - campaign.frequencyCapHours * 3600000);
    const recentlyMailed = new Set();
    if (campaign.frequencyCapHours > 0 && eligible.length) {
      const emails = eligible.map((contact) => contact.email);
      const [broadcasts, automations] = await Promise.all([
        client.marketingBroadcastRecipient.findMany({ where: { organizationId: dispatch.organizationId, email: { in: emails }, dispatchId: { not: dispatch.id }, status: { in: ["PROVIDER_ACCEPTED", "DELIVERED", "DELAYED", "BOUNCED", "COMPLAINED"] }, acceptedAt: { gt: capWindow } }, select: { email: true } }),
        client.marketingAutomationStepRun.findMany({ where: { organizationId: dispatch.organizationId, recipientEmail: { in: emails }, status: "SUCCEEDED", createdAt: { gt: capWindow } }, select: { recipientEmail: true } }),
      ]);
      broadcasts.forEach((row) => recentlyMailed.add(row.email));
      automations.forEach((row) => recentlyMailed.add(row.recipientEmail));
    }
    const rows = [];
    let notApproved = 0;
    for (const contact of eligible) {
      if (!approved.has(contact.id)) { notApproved += 1; continue; }
      rows.push({ dispatchId: dispatch.id, organizationId: dispatch.organizationId, contactId: contact.id, email: contact.email, status: recentlyMailed.has(contact.email) ? "EXCLUDED" : "PENDING", exclusionReason: recentlyMailed.has(contact.email) ? "FREQUENCY_CAP" : null });
    }
    const eligibleIds = new Set(eligible.map((contact) => contact.id));
    for (const contactId of approved) {
      if (eligibleIds.has(contactId)) continue;
      const contact = await client.marketingContact.findUnique({ where: { id: contactId }, select: { id: true, email: true, organizationId: true } });
      if (contact && contact.organizationId === dispatch.organizationId) rows.push({ dispatchId: dispatch.id, organizationId: dispatch.organizationId, contactId, email: contact.email, status: "EXCLUDED", exclusionReason: "NO_LONGER_ELIGIBLE" });
    }
    const sendable = rows.filter((row) => row.status === "PENDING").length;
    const cap = Math.min(config.broadcast.maxRecipients, settings.maxBroadcastRecipients ?? config.broadcast.maxRecipients);
    if (sendable > cap) return { error: ["BROADCAST_RECIPIENT_CAP_EXCEEDED", `${sendable} recipients exceed the cap of ${cap}`] };
    const since = new Date(now().getTime() - 86400000);
    const sentToday = await client.marketingBroadcastRecipient.count({ where: { organizationId: dispatch.organizationId, acceptedAt: { gt: since } } });
    if (sentToday + sendable > (settings.dailyBroadcastCap ?? 1000)) return { error: ["BRAND_DAILY_BROADCAST_CAP_EXCEEDED", `Brand daily cap ${settings.dailyBroadcastCap} would be exceeded (${sentToday} already sent in 24h)`] };
    if (!sendable) return { error: ["NO_ELIGIBLE_RECIPIENTS", "No approved recipient is still eligible"] };
    const setHash = crypto.createHash("sha256").update(rows.filter((row) => row.status === "PENDING").map((row) => row.contactId).sort().join(",")).digest("hex");
    await client.$transaction(async (tx) => {
      for (let index = 0; index < rows.length; index += 1000) await tx.marketingBroadcastRecipient.createMany({ data: rows.slice(index, index + 1000), skipDuplicates: true });
      await tx.marketingBroadcastDispatch.update({ where: { id: dispatch.id }, data: { recipientCount: sendable, excludedCount: rows.length - sendable + notApproved, eligibilitySha256: setHash } });
      await audit.record({ action: "MARKETING_BROADCAST_RECIPIENTS_FROZEN", targetType: "marketing_broadcast", targetId: dispatch.id, organizationId: dispatch.organizationId, metadata: { sendable, excluded: rows.length - sendable, notInApprovedSet: notApproved, excludedReasons } }, {}, tx);
    });
    dispatch.recipientCount = sendable;
    return { sendable };
  }

  // Current eligibility of specific contacts (consent, suppression, status).
  async function stillEligible(organizationId, topic, contactIds) {
    if (!contactIds.length) return new Set();
    const contacts = await client.marketingContact.findMany({ where: { id: { in: contactIds }, organizationId, status: "ACTIVE" }, include: { consents: { where: { topic } } } });
    const suppressed = new Set((await client.marketingSuppression.findMany({ where: { email: { in: contacts.map((contact) => contact.email) }, liftedAt: null, OR: [{ organizationId }, { organizationId: null }] }, select: { email: true } })).map((row) => row.email));
    return new Set(contacts.filter((contact) => {
      const consent = contact.consents[0];
      return consent && consent.status === "GRANTED" && (!consent.doubleOptIn || consent.confirmedAt) && !suppressed.has(contact.email);
    }).map((contact) => contact.id));
  }

  // ---- phase 3/4: segment + sync --------------------------------------------
  async function ensureSegment(dispatch, provider) {
    if (dispatch.providerSegmentId) return dispatch.providerSegmentId;
    const name = `cf-dispatch-${dispatch.id}`;
    const existing = await provider.findSegmentByName(name);
    const segment = existing || (await provider.createSegment(name));
    await client.marketingBroadcastDispatch.update({ where: { id: dispatch.id }, data: { providerSegmentId: segment.id } });
    dispatch.providerSegmentId = segment.id;
    return segment.id;
  }

  async function syncBatch(dispatch, campaign, provider) {
    const batch = await client.marketingBroadcastRecipient.findMany({ where: { dispatchId: dispatch.id, status: "PENDING" }, orderBy: { id: "asc" }, take: config.broadcast.syncBatchSize, include: { contact: { select: { firstName: true, lastName: true } } } });
    if (!batch.length) return { remaining: 0 };
    const allowed = await stillEligible(dispatch.organizationId, campaign.topic, batch.map((row) => row.contactId));
    for (const recipient of batch) {
      if (!allowed.has(recipient.contactId)) {
        await client.marketingBroadcastRecipient.update({ where: { id: recipient.id }, data: { status: "EXCLUDED", exclusionReason: "WITHDRAWN_BEFORE_SEND" } });
        continue;
      }
      try {
        const remote = await provider.getContact(recipient.email);
        if (remote?.unsubscribed) {
          // Provider-side unsubscribe for this brand's account: honour it here.
          const { enforceWithdrawal } = require("./consent-enforcement");
          await client.$transaction((tx) => enforceWithdrawal(tx, { organizationId: dispatch.organizationId, contactId: recipient.contactId, reason: "UNSUBSCRIBED", source: "provider_unsubscribe", now: now() }));
          await client.marketingBroadcastRecipient.update({ where: { id: recipient.id }, data: { status: "UNSUBSCRIBED", exclusionReason: "PROVIDER_UNSUBSCRIBED", providerContactId: remote.id } });
          continue;
        }
        let providerContactId = remote?.id;
        if (remote) await provider.addContactToSegment(remote.id, dispatch.providerSegmentId);
        else providerContactId = (await provider.createContact({ email: recipient.email, firstName: recipient.contact?.firstName, lastName: recipient.contact?.lastName, segmentIds: [dispatch.providerSegmentId] })).id;
        await client.marketingBroadcastRecipient.update({ where: { id: recipient.id }, data: { status: "SYNCED", providerContactId, syncedAt: now() } });
      } catch (error) {
        if (error?.kind === "PERMANENT") {
          await client.marketingBroadcastRecipient.update({ where: { id: recipient.id }, data: { status: "FAILED", exclusionReason: String(error.code || "SYNC_FAILED").slice(0, 64) } });
          continue;
        }
        // Retryable / ambiguous: progress so far is saved; the contact lookup
        // by email makes the retry idempotent.
        throw dispatchError(error?.code || "PROVIDER_SYNC_ERROR", error?.message, { retryable: true, retryAfterSeconds: error?.retryAfterSeconds ?? null });
      }
    }
    const remaining = await client.marketingBroadcastRecipient.count({ where: { dispatchId: dispatch.id, status: "PENDING" } });
    return { remaining };
  }

  // ---- phase 5: withdrawals since sync leave the provider segment ------------
  async function recheckSynced(dispatch, campaign, provider) {
    const withdrawnInDb = await client.marketingBroadcastRecipient.findMany({ where: { dispatchId: dispatch.id, status: { in: ["UNSUBSCRIBED", "EXCLUDED", "SUPPRESSED"] }, syncedAt: { not: null }, providerContactId: { not: null } } });
    const synced = await client.marketingBroadcastRecipient.findMany({ where: { dispatchId: dispatch.id, status: "SYNCED" } });
    const allowed = await stillEligible(dispatch.organizationId, campaign.topic, synced.map((row) => row.contactId));
    const remove = [...withdrawnInDb, ...synced.filter((row) => !allowed.has(row.contactId))];
    for (const recipient of remove) {
      await provider.removeContactFromSegment(recipient.providerContactId, dispatch.providerSegmentId);
      await client.marketingBroadcastRecipient.update({ where: { id: recipient.id }, data: { status: recipient.status === "SYNCED" ? "EXCLUDED" : recipient.status, exclusionReason: recipient.exclusionReason || "WITHDRAWN_BEFORE_SEND", syncedAt: null } });
    }
    return client.marketingBroadcastRecipient.count({ where: { dispatchId: dispatch.id, status: "SYNCED" } });
  }

  // ---- phase 6/7: broadcast create + send -------------------------------------
  async function ensureBroadcast(dispatch, organization, snapshot, sender, provider) {
    if (dispatch.providerBroadcastId) return dispatch.providerBroadcastId;
    const name = `cf-dispatch-${dispatch.id}`;
    if (dispatch.providerCreateAttemptAt) {
      const found = await provider.findBroadcastByName(name);
      if (found) {
        await client.marketingBroadcastDispatch.update({ where: { id: dispatch.id }, data: { providerBroadcastId: found.id, providerStatus: found.status } });
        dispatch.providerBroadcastId = found.id;
        return found.id;
      }
    }
    await client.marketingBroadcastDispatch.update({ where: { id: dispatch.id }, data: { providerCreateAttemptAt: now() } });
    dispatch.providerCreateAttemptAt = now();
    const created = await provider.createBroadcast({
      name,
      segmentId: dispatch.providerSegmentId,
      from: { address: snapshot.senderAddress, name: sender.displayName || organization.name },
      replyTo: snapshot.replyTo || null,
      subject: toProviderContent(snapshot.subject, organization.name, { html: false }),
      html: toProviderContent(snapshot.html, organization.name, { html: true }),
      text: toProviderContent(snapshot.text, organization.name, { html: false }),
    });
    await client.marketingBroadcastDispatch.update({ where: { id: dispatch.id }, data: { providerBroadcastId: created.id, providerStatus: "DRAFT" } });
    dispatch.providerBroadcastId = created.id;
    return created.id;
  }

  async function markAccepted(dispatch, providerStatus) {
    await client.$transaction(async (tx) => {
      await setStatus(dispatch, "SENDING", { providerStatus }, tx);
      const accepted = await tx.marketingBroadcastRecipient.updateMany({ where: { dispatchId: dispatch.id, status: "SYNCED" }, data: { status: "PROVIDER_ACCEPTED", acceptedAt: now() } });
      if (usage) await usage.record(tx, { organizationId: dispatch.organizationId, purpose: "MARKETING_BROADCAST", accepted: accepted.count, providerRequests: 1 });
      await audit.record({ action: "MARKETING_BROADCAST_HANDED_TO_PROVIDER", targetType: "marketing_broadcast", targetId: dispatch.id, organizationId: dispatch.organizationId, metadata: { providerStatus, recipients: dispatch.recipientCount } }, {}, tx);
      await jobs.enqueue(tx, { queue: "MARKETING", kind: "BROADCAST_RECONCILE", idempotencyKey: `broadcast-reconcile:${dispatch.id}`, payload: { dispatchId: dispatch.id, organizationId: dispatch.organizationId }, maxAttempts: 20, nextAttemptAt: new Date(now().getTime() + config.broadcast.reconcileIntervalSeconds * 1000) });
    });
    return { accepted: true };
  }

  async function sendOrResolve(dispatch, provider) {
    if (dispatch.cancelRequestedAt) return cancelBeforeSend(dispatch, provider);
    if (dispatch.providerSendAttemptAt) {
      // A previous send attempt may or may not have been accepted.
      let remote = null;
      try {
        remote = await provider.getBroadcast(dispatch.providerBroadcastId);
      } catch (error) {
        if (now().getTime() - new Date(dispatch.providerSendAttemptAt).getTime() > SEND_UNKNOWN_AFTER_MS) return outcomeUnknown(dispatch, "SEND_STATUS_UNREADABLE");
        throw dispatchError(error?.code || "PROVIDER_STATUS_ERROR", "Broadcast status unreadable", { retryable: true });
      }
      if (remote && ["QUEUED", "SCHEDULED", "SENT"].includes(remote.status)) return markAccepted(dispatch, remote.status);
      if (remote?.status === "CANCELED") return finalize(dispatch, "CANCELED");
      if (!remote || remote.status === "UNKNOWN") {
        if (now().getTime() - new Date(dispatch.providerSendAttemptAt).getTime() > SEND_UNKNOWN_AFTER_MS) return outcomeUnknown(dispatch, "SEND_STATUS_UNKNOWN");
        throw dispatchError("PROVIDER_STATUS_UNKNOWN", "Broadcast status unknown", { retryable: true });
      }
      // DRAFT: the earlier send was not accepted, so sending again is safe.
    }
    await client.marketingBroadcastDispatch.update({ where: { id: dispatch.id }, data: { providerSendAttemptAt: now() } });
    dispatch.providerSendAttemptAt = now();
    try {
      await provider.sendBroadcast(dispatch.providerBroadcastId);
    } catch (error) {
      if (error?.kind === "PERMANENT" || error?.kind === "NOT_CONFIGURED") {
        // The provider refused; nothing was sent. Re-read status to be sure.
        const remote = await provider.getBroadcast(dispatch.providerBroadcastId).catch(() => null);
        if (remote && ["QUEUED", "SCHEDULED", "SENT"].includes(remote.status)) return markAccepted(dispatch, remote.status);
        await client.marketingBroadcastDispatch.update({ where: { id: dispatch.id }, data: { providerSendAttemptAt: null } });
        await cleanupProviderDraft(dispatch, provider);
        return fail(dispatch, String(error.code || "PROVIDER_REJECTED"), error.message);
      }
      throw dispatchError(error?.code || "PROVIDER_SEND_AMBIGUOUS", "Send outcome unknown; will reconcile by status", { retryable: true, retryAfterSeconds: 30 });
    }
    return markAccepted(dispatch, "QUEUED");
  }

  async function outcomeUnknown(dispatch, reason) {
    await client.$transaction(async (tx) => {
      await setStatus(dispatch, "OUTCOME_UNKNOWN", { lastErrorCode: reason, completedAt: now() }, tx);
      await tx.marketingBroadcastRecipient.updateMany({ where: { dispatchId: dispatch.id, status: { in: ["SYNCED", "PROVIDER_ACCEPTED"] } }, data: { status: "OUTCOME_UNKNOWN" } });
      await audit.record({ action: "MARKETING_BROADCAST_OUTCOME_UNKNOWN", targetType: "marketing_broadcast", targetId: dispatch.id, organizationId: dispatch.organizationId, outcome: "UNKNOWN", metadata: { reason } }, {}, tx);
    });
    await notifyOwners(dispatch, "Broadcast outcome unknown", "The provider did not confirm the send. Review before any resend.");
    return { outcomeUnknown: reason };
  }

  async function finalize(dispatch, providerStatus) {
    const counts = Object.fromEntries((await client.marketingBroadcastRecipient.groupBy({ by: ["status"], where: { dispatchId: dispatch.id }, _count: { _all: true } })).map((row) => [row.status, row._count._all]));
    const handed = ["PROVIDER_ACCEPTED", "DELIVERED", "DELAYED", "BOUNCED", "COMPLAINED", "SUPPRESSED"].reduce((sum, key) => sum + (counts[key] || 0), 0);
    const delivered = (counts.DELIVERED || 0) + (counts.DELAYED || 0) + (counts.BOUNCED || 0) + (counts.COMPLAINED || 0);
    const syncFailures = counts.FAILED || 0;
    let status;
    if (providerStatus === "CANCELED") status = delivered > 0 ? "PARTIAL" : "CANCELLED";
    else status = handed === 0 ? "FAILED" : syncFailures > 0 ? "PARTIAL" : "COMPLETED";
    await client.$transaction(async (tx) => {
      await setStatus(dispatch, status, { providerStatus, providerSentAt: providerStatus === "SENT" ? now() : dispatch.providerSentAt, completedAt: now() }, tx);
      if (providerStatus === "CANCELED") await tx.marketingBroadcastRecipient.updateMany({ where: { dispatchId: dispatch.id, status: "PROVIDER_ACCEPTED" }, data: { status: "CANCELLED", exclusionReason: "CANCELLED_AT_PROVIDER" } });
      await audit.record({ action: "MARKETING_BROADCAST_FINALIZED", targetType: "marketing_broadcast", targetId: dispatch.id, organizationId: dispatch.organizationId, metadata: { status, providerStatus, counts } }, {}, tx);
    });
    await notifyOwners(dispatch, status === "COMPLETED" ? "Broadcast handed to the provider" : `Broadcast ${status.toLowerCase()}`, "Delivery results continue to update from provider events.");
    return { finalized: status };
  }

  async function loadContext(job) {
    const dispatch = await client.marketingBroadcastDispatch.findUnique({ where: { id: job.payload?.dispatchId } });
    if (!dispatch) return null;
    const organization = await client.mailOrganization.findUnique({ where: { id: dispatch.organizationId } });
    return { dispatch, organization, provider: marketingProviders(organization), settings: await brandSettings(dispatch.organizationId) };
  }

  function haltReason(settings) {
    if (!config.broadcastDispatchEnabled) return "BROADCAST_DISPATCH_DISABLED";
    if (config.emergencyStop.marketing) return "MARKETING_EMERGENCY_STOP";
    if (settings.dispatchPaused) return "BRAND_DISPATCH_PAUSED";
    return null;
  }

  async function processDispatch(job) {
    const context = await loadContext(job);
    if (!context) return { skipped: true };
    const { dispatch, organization, provider, settings } = context;
    if (TERMINAL.has(dispatch.status) || dispatch.status === "SENDING") return { skipped: dispatch.status };
    if (dispatch.cancelRequestedAt && !dispatch.providerSendAttemptAt) return cancelBeforeSend(dispatch, provider);
    if (dispatch.status === "PAUSED") return { defer: { seconds: 300, code: "DISPATCH_PAUSED" } };
    const halted = haltReason(settings) || (runtime ? await runtime.haltReason("MARKETING_BROADCAST", { organizationId: dispatch.organizationId }) : null);
    if (halted) {
      await client.marketingBroadcastDispatch.update({ where: { id: dispatch.id }, data: { lastErrorCode: halted } });
      return { defer: { seconds: 300, code: halted } };
    }
    if (!dispatch.providerSendAttemptAt) {
      const checked = await verify(dispatch, organization, provider);
      if (checked.error) return fail(dispatch, ...checked.error);
      if (dispatch.status === "SCHEDULED" || dispatch.status === "QUEUED") await setStatus(dispatch, "PREPARING", { lastErrorCode: null });
      const existing = await client.marketingBroadcastRecipient.count({ where: { dispatchId: dispatch.id } });
      if (!existing) {
        const built = await buildRecipients(dispatch, checked.campaign, checked.snapshot, settings);
        if (built.error) return fail(dispatch, ...built.error);
      }
      await ensureSegment(dispatch, provider);
      const { remaining } = await syncBatch(dispatch, checked.campaign, provider);
      if (remaining > 0) return { defer: { seconds: 1, code: "SYNC_IN_PROGRESS", message: `${remaining} recipients left` } };
      const sendable = await recheckSynced(dispatch, checked.campaign, provider);
      if (!sendable) {
        await cleanupProviderDraft(dispatch, provider);
        return fail(dispatch, "NO_ELIGIBLE_RECIPIENTS", "Every recipient withdrew or failed before the send");
      }
      // M9: brand hard limits are checked against the final recipient count.
      if (usage) {
        const quota = await usage.check(dispatch.organizationId, "MARKETING_BROADCAST", sendable);
        if (!quota.allowed) {
          await cleanupProviderDraft(dispatch, provider);
          return fail(dispatch, "MAIL_QUOTA_HARD_LIMIT", `Brand ${quota.period} limit of ${quota.limit} would be exceeded`);
        }
      }
      // Final cancellation / halt check immediately before the provider send.
      const fresh = await client.marketingBroadcastDispatch.findUnique({ where: { id: dispatch.id } });
      if (fresh.cancelRequestedAt) return cancelBeforeSend({ ...dispatch, ...fresh }, provider);
      if (fresh.status === "PAUSED") return { defer: { seconds: 300, code: "DISPATCH_PAUSED" } };
      await ensureBroadcast(dispatch, organization, checked.snapshot, checked.sender, provider);
    }
    return sendOrResolve(dispatch, provider);
  }

  async function processReconcile(job) {
    const context = await loadContext(job);
    if (!context) return { skipped: true };
    const { dispatch, provider } = context;
    if (TERMINAL.has(dispatch.status)) return { skipped: dispatch.status };
    if (dispatch.status !== "SENDING") return { defer: { seconds: config.broadcast.reconcileIntervalSeconds, code: "NOT_SENDING_YET" } };
    if (dispatch.cancelRequestedAt && dispatch.providerStatus !== "CANCEL_REQUESTED") {
      try {
        await provider.cancelBroadcast(dispatch.providerBroadcastId);
      } catch (error) {
        if (error?.kind !== "PERMANENT") throw dispatchError(error?.code || "PROVIDER_CANCEL_ERROR", error?.message, { retryable: true });
        // Not cancelable any more (already sent): fall through to status read.
      }
      await client.marketingBroadcastDispatch.update({ where: { id: dispatch.id }, data: { providerStatus: "CANCEL_REQUESTED" } });
      await audit.record({ action: "MARKETING_BROADCAST_CANCEL_SENT_TO_PROVIDER", targetType: "marketing_broadcast", targetId: dispatch.id, organizationId: dispatch.organizationId, metadata: { note: "Mail already sent cannot be recalled" } });
    }
    let remote;
    try {
      remote = await provider.getBroadcast(dispatch.providerBroadcastId);
    } catch (error) {
      throw dispatchError(error?.code || "PROVIDER_STATUS_ERROR", "Broadcast status unreadable", { retryable: true, retryAfterSeconds: config.broadcast.reconcileIntervalSeconds });
    }
    const status = remote?.status || "UNKNOWN";
    if (status === "SENT" || status === "CANCELED") {
      const result = await finalize(dispatch, status);
      if (dispatch.providerSegmentId && status === "SENT") await provider.deleteSegment(dispatch.providerSegmentId).catch(() => {});
      return result;
    }
    if (status === "DRAFT") {
      // A cancelled schedule returns to draft: nothing further will be sent.
      return finalize(dispatch, "CANCELED");
    }
    if (now().getTime() - new Date(dispatch.providerSendAttemptAt).getTime() > config.broadcast.reconcileMaxHours * 3600000) return outcomeUnknown(dispatch, "PROVIDER_NEVER_COMPLETED");
    if (status !== dispatch.providerStatus && status !== "UNKNOWN" && dispatch.providerStatus !== "CANCEL_REQUESTED") await client.marketingBroadcastDispatch.update({ where: { id: dispatch.id }, data: { providerStatus: status } });
    return { defer: { seconds: config.broadcast.reconcileIntervalSeconds, code: "PROVIDER_STILL_SENDING" } };
  }

  async function onDeadLetter(job, error) {
    const dispatch = await client.marketingBroadcastDispatch.findUnique({ where: { id: job.payload?.dispatchId } }).catch(() => null);
    if (!dispatch || TERMINAL.has(dispatch.status)) return;
    if (dispatch.providerSendAttemptAt) await outcomeUnknown(dispatch, `DEAD_LETTER_${String(error?.code || "ERROR").slice(0, 40)}`);
    else await fail(dispatch, "DISPATCH_RETRIES_EXHAUSTED", error?.message || "Retries exhausted before sending");
    logger?.warn?.(`[Marketing] dispatch ${dispatch.id} dead-lettered (${error?.code || "error"})`);
  }

  return { processDispatch, processReconcile, onDeadLetter, toProviderContent, snapshotHash };
}

module.exports = { createBroadcastProcessor, toProviderContent, snapshotHash, TERMINAL_BROADCAST_STATUSES: TERMINAL };
