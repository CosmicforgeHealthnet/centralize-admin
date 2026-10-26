"use strict";

// M7 broadcast lifecycle API: schedule an APPROVED campaign, pause/resume,
// cancel, brand controls and reporting. Dispatch itself happens only in the
// MARKETING worker (broadcast.processor.js). Every operation is brand-scoped
// through the marketing grants and enforced here, not in the UI.

const { mailError } = require("../mail.errors");
const policy = require("../authz/mail.policy");
const { zonedLocalToUtc, isValidTimeZone } = require("./scheduling");
const { describeBrandProvider, quotaScopeFor, resolveBrandApiKey } = require("../adapters/marketing");
const { iso, decodeCursor, encodeCursor, pageLimit } = require("../services/serializers");
const { TERMINAL_BROADCAST_STATUSES, deliveredCount, sentEvidenceCount, transitionCampaign } = require("./broadcast.processor");
const { isBrandSender, SENDER_MAILBOX_SELECT } = require("./marketing-sender");

const PRE_SEND = new Set(["SCHEDULED", "QUEUED", "PREPARING", "PAUSED"]);
const DELIVERY_STATUSES = ["PROVIDER_ACCEPTED", "DELIVERED", "DELAYED", "BOUNCED", "COMPLAINED", "FAILED", "SUPPRESSED", "UNSUBSCRIBED", "OUTCOME_UNKNOWN", "CANCELLED", "EXCLUDED", "PENDING", "SYNCED"];

// Provider events (delivered, bounced, complained) keep arriving after the
// provider reports a broadcast as sent; the report flags that period.
const EVENTS_SETTLE_HOURS = 72;

function createBroadcastService({ client, config, audit, jobs, stepUp, env = process.env, replies = null, pricing = null, providerQuota = null, clock = () => new Date() }) {
  const scope = (user, organizationId, need) => {
    if (!config.marketingEnabled) throw mailError("MAIL_MARKETING_DISABLED");
    return policy.requireMarketingScope(client, user, organizationId, need);
  };
  const scopeEither = async (user, organizationId) => {
    const scoped = await scope(user, organizationId, "VIEW");
    if (!scoped.canAuthor && !scoped.canApprove) throw mailError("MAIL_FORBIDDEN", { reason: "MARKETING_AUTHOR_OR_APPROVER_REQUIRED" });
    return scoped;
  };
  const jobKey = (dispatchId) => `broadcast:${dispatchId}`;

  async function loadCampaign(organizationId, campaignId) {
    const campaign = policy.isUuid(campaignId) ? await client.marketingEmailCampaign.findUnique({ where: { id: campaignId }, include: { dispatch: true } }) : null;
    if (!campaign || campaign.organizationId !== organizationId) throw mailError("MAIL_NOT_FOUND", { resource: "campaign" });
    return campaign;
  }

  async function settingsFor(organizationId) {
    const row = await client.marketingBrandSettings.findUnique({ where: { organizationId } });
    return row || { organizationId, confirmationSenderId: null, defaultTimeZone: "UTC", postalAddress: null, dailyBroadcastCap: 1000, dailyAutomationCap: 500, maxBroadcastRecipients: Math.min(1000, config.broadcast.maxRecipients), dispatchPaused: false, pausedReason: null, pausedAt: null, pausedBy: null, persisted: false };
  }

  function serializeSettings(row, organization) {
    return {
      organizationId: row.organizationId,
      confirmationSenderAddressId: row.confirmationSenderId,
      defaultTimeZone: row.defaultTimeZone,
      postalAddress: row.postalAddress,
      dailyBroadcastCap: row.dailyBroadcastCap,
      dailyAutomationCap: row.dailyAutomationCap,
      maxBroadcastRecipients: row.maxBroadcastRecipients,
      hardMaxBroadcastRecipients: config.broadcast.maxRecipients,
      dispatchPaused: row.dispatchPaused,
      pausedReason: row.pausedReason,
      pausedAt: iso(row.pausedAt),
      provider: describeBrandProvider(organization.slug, { env, config }),
      flags: { broadcastDispatchEnabled: config.broadcastDispatchEnabled, automationEnabled: config.automationEnabled, confirmationEmailsEnabled: config.confirmationEmailsEnabled, emergencyStop: config.emergencyStop.marketing },
    };
  }

  async function getBrandSettings(user, organizationId) {
    const scoped = await scope(user, organizationId, "VIEW");
    return serializeSettings(await settingsFor(organizationId), scoped);
  }

  async function updateBrandSettings(user, organizationId, input, context) {
    const scoped = await scope(user, organizationId, "APPROVE");
    const data = {};
    if (input.defaultTimeZone !== undefined) {
      if (!isValidTimeZone(input.defaultTimeZone)) throw mailError("MAIL_VALIDATION_FAILED", { field: "defaultTimeZone" });
      data.defaultTimeZone = input.defaultTimeZone;
    }
    if (input.postalAddress !== undefined) {
      const value = input.postalAddress ? String(input.postalAddress).replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 500) : null;
      data.postalAddress = value || null;
    }
    const capField = (field, max) => {
      if (input[field] === undefined) return;
      const value = Number(input[field]);
      if (!Number.isInteger(value) || value < 0 || value > max) throw mailError("MAIL_VALIDATION_FAILED", { field, max });
      data[field] = value;
    };
    capField("dailyBroadcastCap", 1000000);
    capField("dailyAutomationCap", 1000000);
    capField("maxBroadcastRecipients", config.broadcast.maxRecipients);
    if (input.confirmationSenderAddressId !== undefined) {
      if (input.confirmationSenderAddressId) {
        const address = policy.isUuid(input.confirmationSenderAddressId) ? await client.mailAddress.findUnique({ where: { id: input.confirmationSenderAddressId }, include: { mailbox: SENDER_MAILBOX_SELECT } }) : null;
        if (!isBrandSender(address, organizationId)) throw mailError("MAIL_VALIDATION_FAILED", { field: "confirmationSenderAddressId" });
      }
      data.confirmationSenderId = input.confirmationSenderAddressId || null;
    }
    const row = await client.marketingBrandSettings.upsert({ where: { organizationId }, create: { organizationId, ...data, updatedBy: user.id }, update: { ...data, updatedBy: user.id } });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_BRAND_SETTINGS_UPDATED", targetType: "organization", targetId: organizationId, organizationId, metadata: { fields: Object.keys(data) } }, context);
    return serializeSettings(row, scoped);
  }

  // Brand-wide dispatch pause: any author or approver may stop; only an
  // approver with a fresh MFA step-up may resume.
  async function pauseBrand(user, organizationId, { reason } = {}, context) {
    const scoped = await scopeEither(user, organizationId);
    const text = String(reason || "").trim();
    if (text.length < 5) throw mailError("MAIL_VALIDATION_FAILED", { field: "reason" });
    const row = await client.marketingBrandSettings.upsert({ where: { organizationId }, create: { organizationId, dispatchPaused: true, pausedReason: text.slice(0, 500), pausedAt: clock(), pausedBy: user.id, updatedBy: user.id }, update: { dispatchPaused: true, pausedReason: text.slice(0, 500), pausedAt: clock(), pausedBy: user.id, updatedBy: user.id } });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_BRAND_DISPATCH_PAUSED", targetType: "organization", targetId: organizationId, organizationId, metadata: { reason: text.slice(0, 200) } }, context);
    return serializeSettings(row, scoped);
  }

  async function resumeBrand(user, organizationId, { stepUpId } = {}, context) {
    const scoped = await scope(user, organizationId, "APPROVE");
    const row = await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, stepUpId, "MARKETING_BROADCAST_OVERRIDE", context);
      const updated = await tx.marketingBrandSettings.upsert({ where: { organizationId }, create: { organizationId, dispatchPaused: false, updatedBy: user.id }, update: { dispatchPaused: false, pausedReason: null, pausedAt: null, pausedBy: null, updatedBy: user.id } });
      await audit.record({ actorAdminUserId: user.id, action: "MARKETING_BRAND_DISPATCH_RESUMED", targetType: "organization", targetId: organizationId, organizationId, metadata: { stepUp: true } }, context, tx);
      return updated;
    });
    return serializeSettings(row, scoped);
  }

  function resolveSendTime({ sendAt, timeZone, sendAtUtc }, settings) {
    const minimum = clock().getTime() + config.broadcast.minLeadSeconds * 1000;
    let utc;
    let ambiguous = false;
    const zone = timeZone || settings.defaultTimeZone || "UTC";
    if (sendAt) {
      try {
        ({ utc, ambiguous } = zonedLocalToUtc(sendAt, zone));
      } catch (error) {
        throw mailError("MAIL_VALIDATION_FAILED", { field: "sendAt", reason: error.code || "SCHEDULE_TIME_INVALID" });
      }
    } else if (sendAtUtc) {
      utc = new Date(sendAtUtc);
      if (Number.isNaN(utc.getTime()) || !/Z$|[+-]\d{2}:?\d{2}$/.test(String(sendAtUtc))) throw mailError("MAIL_VALIDATION_FAILED", { field: "sendAtUtc", reason: "ISO_8601_WITH_OFFSET_REQUIRED" });
    } else {
      utc = new Date(minimum);
    }
    if (utc.getTime() < minimum - 1000) throw mailError("MAIL_VALIDATION_FAILED", { field: "sendAt", reason: "TOO_SOON", minimumLeadSeconds: config.broadcast.minLeadSeconds });
    if (utc.getTime() > clock().getTime() + 60 * 86400000) throw mailError("MAIL_VALIDATION_FAILED", { field: "sendAt", reason: "TOO_FAR_AHEAD" });
    return { utc, zone, ambiguous, local: sendAt || null };
  }

  async function schedule(user, organizationId, campaignId, input = {}, context) {
    await scope(user, organizationId, "EDIT");
    if (!config.broadcastDispatchEnabled) throw mailError("MAIL_BROADCAST_DISABLED");
    if (config.emergencyStop.marketing) throw mailError("MAIL_EMERGENCY_STOP");
    const campaign = await loadCampaign(organizationId, campaignId);
    if (campaign.status !== "APPROVED") throw mailError("MAIL_INVALID_TRANSITION", { from: campaign.status, reason: "APPROVAL_REQUIRED" });
    if (Number(input.revision) !== campaign.revision) throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: campaign.revision });
    if (campaign.dispatch) throw mailError("MAIL_INVALID_TRANSITION", { reason: "ALREADY_DISPATCHED", dispatchStatus: campaign.dispatch.status });
    const snapshot = await client.marketingCampaignSnapshot.findUnique({ where: { campaignId_revision_kind: { campaignId, revision: campaign.revision, kind: "APPROVAL" } } });
    if (!snapshot) throw mailError("MAIL_INVALID_TRANSITION", { reason: "APPROVAL_SNAPSHOT_MISSING" });
    if (clock().getTime() - snapshot.createdAt.getTime() > config.broadcast.approvalTtlDays * 86400000) throw mailError("MAIL_APPROVAL_EXPIRED", { approvalTtlDays: config.broadcast.approvalTtlDays });
    const settings = await settingsFor(organizationId);
    if (!settings.postalAddress) throw mailError("MAIL_PREFLIGHT_FAILED", { checks: [{ id: "postal_address", ok: false, detail: "Set the brand postal address before dispatching marketing mail" }] });
    const when = resolveSendTime(input, settings);
    const dispatch = await client.$transaction(async (tx) => {
      const moved = await tx.marketingEmailCampaign.updateMany({ where: { id: campaignId, status: "APPROVED", revision: campaign.revision }, data: { status: "SCHEDULED" } });
      if (moved.count !== 1) throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: null });
      const row = await tx.marketingBroadcastDispatch.create({
        data: { campaignId, organizationId, approvalSnapshotId: snapshot.id, status: "SCHEDULED", scheduledFor: when.utc, timeZone: when.zone, localSendTime: when.local, contentSha256: snapshot.contentSha256, scheduledByAdminUserId: user.id },
      });
      await jobs.enqueue(tx, { queue: "MARKETING", kind: "BROADCAST_DISPATCH", idempotencyKey: jobKey(row.id), payload: { dispatchId: row.id, organizationId }, maxAttempts: 30, nextAttemptAt: when.utc });
      await audit.record({ actorAdminUserId: user.id, action: "MARKETING_BROADCAST_SCHEDULED", targetType: "marketing_broadcast", targetId: row.id, organizationId, metadata: { campaignId, scheduledFor: when.utc.toISOString(), timeZone: when.zone, ambiguousLocalTime: when.ambiguous } }, context, tx);
      return row;
    }).catch((error) => {
      if (error?.code === "P2002") throw mailError("MAIL_INVALID_TRANSITION", { reason: "ALREADY_DISPATCHED" });
      throw error;
    });
    return { ...serializeDispatch(dispatch), ambiguousLocalTime: when.ambiguous };
  }

  function serializeDispatch(row) {
    return {
      id: row.id, campaignId: row.campaignId, status: row.status, scheduledFor: iso(row.scheduledFor), timeZone: row.timeZone, localSendTime: row.localSendTime,
      provider: row.provider, providerStatus: row.providerStatus, providerHandoffAt: iso(row.providerSendAttemptAt), recipientCount: row.recipientCount, excludedCount: row.excludedCount,
      cancelRequestedAt: iso(row.cancelRequestedAt), pausedAt: iso(row.pausedAt), lastErrorCode: row.lastErrorCode, completedAt: iso(row.completedAt), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
      paused: row.status === "PAUSED",
    };
  }

  async function requireDispatch(organizationId, campaignId) {
    const campaign = await loadCampaign(organizationId, campaignId);
    if (!campaign.dispatch) throw mailError("MAIL_NOT_FOUND", { resource: "dispatch" });
    return campaign.dispatch;
  }

  async function cancel(user, organizationId, campaignId, { reason } = {}, context) {
    await scopeEither(user, organizationId);
    const dispatch = await requireDispatch(organizationId, campaignId);
    // Repeated cancel is idempotent: report the current state.
    if (dispatch.cancelRequestedAt || dispatch.status === "CANCELLED") return { ...serializeDispatch(dispatch), alreadyRequested: true, note: null };
    if (TERMINAL_BROADCAST_STATUSES.has(dispatch.status)) throw mailError("MAIL_INVALID_TRANSITION", { from: dispatch.status });
    const nothingAtProvider = PRE_SEND.has(dispatch.status) && !dispatch.providerBroadcastId && !dispatch.providerSegmentId;
    const result = await client.$transaction(async (tx) => {
      const updated = await tx.marketingBroadcastDispatch.updateMany({ where: { id: dispatch.id, cancelRequestedAt: null }, data: { cancelRequestedAt: clock(), cancelRequestedBy: user.id } });
      if (updated.count !== 1) return { immediate: false, raced: true };
      let immediate = false;
      if (nothingAtProvider && dispatch.status !== "PREPARING") {
        // Guarded on the status we saw: if the worker moved it to PREPARING
        // meanwhile, the worker performs the cancellation instead.
        const moved = await tx.marketingBroadcastDispatch.updateMany({ where: { id: dispatch.id, status: dispatch.status, providerSendAttemptAt: null }, data: { status: "CANCELLED", completedAt: clock() } });
        immediate = moved.count === 1;
      }
      if (immediate) {
        await transitionCampaign(tx, audit, { campaignId, organizationId, dispatchId: dispatch.id, to: "CANCELLED" });
        await tx.marketingBroadcastRecipient.updateMany({ where: { dispatchId: dispatch.id, status: { in: ["PENDING", "SYNCED"] } }, data: { status: "CANCELLED", exclusionReason: "CANCELLED_BEFORE_SEND" } });
        await jobs.cancelPending(jobKey(dispatch.id), "BROADCAST_CANCELLED");
      }
      await audit.record({ actorAdminUserId: user.id, action: "MARKETING_BROADCAST_CANCEL_REQUESTED", targetType: "marketing_broadcast", targetId: dispatch.id, organizationId, metadata: { previousStatus: dispatch.status, reason: reason ? String(reason).slice(0, 200) : null } }, context, tx);
      return { immediate };
    });
    if (!result.immediate) {
      await jobs.expedite(jobKey(dispatch.id));
      await jobs.expedite(`broadcast-reconcile:${dispatch.id}`);
    }
    const fresh = await client.marketingBroadcastDispatch.findUnique({ where: { id: dispatch.id } });
    return { ...serializeDispatch(fresh), note: dispatch.status === "SENDING" ? "Emails already handed to the provider cannot be recalled; only unsent mail is stopped." : null };
  }

  async function pause(user, organizationId, campaignId, context) {
    await scopeEither(user, organizationId);
    const dispatch = await requireDispatch(organizationId, campaignId);
    // Repeated pause is idempotent: report the current state.
    if (dispatch.status === "PAUSED") return serializeDispatch(dispatch);
    if (!["SCHEDULED", "QUEUED", "PREPARING"].includes(dispatch.status) || dispatch.providerSendAttemptAt) throw mailError("MAIL_INVALID_TRANSITION", { from: dispatch.status, reason: "ONLY_BEFORE_PROVIDER_HANDOFF" });
    const updated = await client.marketingBroadcastDispatch.updateMany({ where: { id: dispatch.id, status: { in: ["SCHEDULED", "QUEUED", "PREPARING"] }, providerSendAttemptAt: null, cancelRequestedAt: null }, data: { status: "PAUSED", pausedAt: clock(), pausedBy: user.id } });
    if (updated.count !== 1) {
      const current = await client.marketingBroadcastDispatch.findUnique({ where: { id: dispatch.id } });
      if (current.status === "PAUSED") return serializeDispatch(current);
      throw mailError("MAIL_INVALID_TRANSITION", { from: current.status, reason: "CHANGED" });
    }
    // The campaign enum has no PAUSED value (no migration): the campaign keeps
    // SCHEDULED / QUEUED and the pause is exposed on the dispatch
    // (status PAUSED, pausedAt) and as `paused` on the dispatch views.
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_BROADCAST_PAUSED", targetType: "marketing_broadcast", targetId: dispatch.id, organizationId, metadata: { previousStatus: dispatch.status } }, context);
    return serializeDispatch(await client.marketingBroadcastDispatch.findUnique({ where: { id: dispatch.id } }));
  }

  async function resume(user, organizationId, campaignId, context) {
    await scopeEither(user, organizationId);
    const dispatch = await requireDispatch(organizationId, campaignId);
    if (dispatch.status !== "PAUSED") throw mailError("MAIL_INVALID_TRANSITION", { from: dispatch.status });
    // Guarded: only a still-paused, not-cancelled dispatch is resumed.
    const resumed = await client.$transaction(async (tx) => {
      const moved = await tx.marketingBroadcastDispatch.updateMany({ where: { id: dispatch.id, status: "PAUSED", cancelRequestedAt: null }, data: { status: "SCHEDULED", pausedAt: null, pausedBy: null } });
      // A dispatch paused while PREPARING had moved its campaign to QUEUED;
      // it is SCHEDULED again (guarded: a terminal campaign never moves).
      if (moved.count === 1) await transitionCampaign(tx, audit, { campaignId, organizationId, dispatchId: dispatch.id, to: "SCHEDULED" });
      return moved;
    });
    if (resumed.count !== 1) {
      const current = await client.marketingBroadcastDispatch.findUnique({ where: { id: dispatch.id } });
      if (current.status === "SCHEDULED") return serializeDispatch(current);
      throw mailError("MAIL_INVALID_TRANSITION", { from: current.status, reason: "CHANGED" });
    }
    await client.mailOutboxJob.updateMany({ where: { idempotencyKey: jobKey(dispatch.id), status: { in: ["PENDING", "RETRY_SCHEDULED"] } }, data: { nextAttemptAt: new Date(Math.max(clock().getTime(), dispatch.scheduledFor.getTime())) } });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_BROADCAST_RESUMED", targetType: "marketing_broadcast", targetId: dispatch.id, organizationId }, context);
    return serializeDispatch(await client.marketingBroadcastDispatch.findUnique({ where: { id: dispatch.id } }));
  }

  async function countsFor(dispatchId) {
    const rows = await client.marketingBroadcastRecipient.groupBy({ by: ["status"], where: { dispatchId }, _count: { _all: true } });
    const counts = Object.fromEntries(DELIVERY_STATUSES.map((status) => [status, 0]));
    for (const row of rows) counts[row.status] = row._count._all;
    return counts;
  }

  async function getDispatch(user, organizationId, campaignId) {
    await scope(user, organizationId, "VIEW");
    const campaign = await loadCampaign(organizationId, campaignId);
    if (!campaign.dispatch) return { dispatch: null, campaignStatus: campaign.status, dispatchEnabled: config.broadcastDispatchEnabled };
    return { dispatch: serializeDispatch(campaign.dispatch), campaignStatus: campaign.status, campaignPaused: campaign.dispatch.status === "PAUSED", counts: await countsFor(campaign.dispatch.id), dispatchEnabled: config.broadcastDispatchEnabled };
  }

  // Honest reporting: provider acceptance is not delivery; opens and clicks
  // are indicative only (image blocking / privacy proxies distort them).
  async function report(user, organizationId, campaignId) {
    await scope(user, organizationId, "VIEW");
    const dispatch = await requireDispatch(organizationId, campaignId);
    const counts = await countsFor(dispatch.id);
    const [opened, clicked, exclusions, events] = await Promise.all([
      client.marketingBroadcastRecipient.count({ where: { dispatchId: dispatch.id, openedAt: { not: null } } }),
      client.marketingBroadcastRecipient.count({ where: { dispatchId: dispatch.id, clickedAt: { not: null } } }),
      client.marketingBroadcastRecipient.groupBy({ by: ["exclusionReason"], where: { dispatchId: dispatch.id, exclusionReason: { not: null } }, _count: { _all: true } }),
      audit.list({ targetType: "marketing_broadcast", targetId: dispatch.id, limit: 100 }),
    ]);
    const handedToProvider = counts.PROVIDER_ACCEPTED + counts.DELIVERED + counts.DELAYED + counts.BOUNCED + counts.COMPLAINED + counts.SUPPRESSED;
    const rate = (value) => (handedToProvider ? Math.round((value / handedToProvider) * 10000) / 100 : null);
    const replied = replies ? await replies.summary(dispatch) : null;
    // Delivered from evidence (stays monotonic when complaints arrive).
    const delivered = await deliveredCount(client, dispatch.id);
    // Recipients with evidence the provider produced the message (email.sent
    // evidence rows, delivered, delayed, bounced, complained).
    const providerSent = await sentEvidenceCount(client, dispatch.id);
    const windowFrom = dispatch.providerSendAttemptAt || dispatch.providerSentAt || null;
    // GAP 3: delayed events. The window ends now; events are still expected
    // until EVENTS_SETTLE_HOURS after the provider finished sending.
    const settleFrom = dispatch.providerSentAt || dispatch.completedAt || windowFrom;
    const settleUntil = settleFrom ? new Date(new Date(settleFrom).getTime() + EVENTS_SETTLE_HOURS * 3600000) : null;
    const eventsStillArriving = Boolean(windowFrom) && (!settleUntil || settleUntil > clock());
    const spend = pricing ? await pricing.dispatchSpend(dispatch) : null;
    const quota = await reportQuota(user, organizationId);
    return {
      dispatch: serializeDispatch(dispatch),
      counts,
      totals: { handedToProvider, providerSent, delivered, awaitingDeliveryEvidence: counts.PROVIDER_ACCEPTED, outcomeUnknown: counts.OUTCOME_UNKNOWN, excluded: dispatch.excludedCount },
      // What every percentage is measured against, and over which period.
      denominators: {
        rates: "recipients handed to the provider (provider accepted, delivered, delayed, bounced, complained, suppressed)",
        delivered: "recipients with delivery evidence (delivered event or a later complaint)",
        window: { from: iso(windowFrom), to: iso(dispatch.completedAt) || iso(clock()), note: "From provider handoff until the report was generated; events keep arriving after completion." },
        // GAP 3: report window end and the delayed-event flag.
        reportWindowEnd: iso(clock()),
        eventsSettleUntil: iso(settleUntil),
        eventsStillArriving,
        eventsSettleHours: EVENTS_SETTLE_HOURS,
        sent: { count: handedToProvider, denominator: "recipients handed to the provider" },
        accepted: { count: handedToProvider, denominator: "recipients the provider accepted (same set as handed to the provider)" },
        delivered: { count: delivered, denominator: "recipients handed to the provider", basis: "delivery evidence" },
      },
      // GAP 3: estimated spend (never billed spend) and provider quota.
      spend,
      providerQuota: quota,
      rates: { deliveredPercent: rate(delivered), bouncePercent: rate(counts.BOUNCED), complaintPercent: rate(counts.COMPLAINED), openPercentIndicative: rate(opened), clickPercentIndicative: rate(clicked), replyPercent: replied ? rate(replied.replied) : null },
      // Spec 13.3 "replied": evidence-based attribution (null until migration 35).
      replied,
      engagement: { opened, clicked, note: "Opens and clicks are indicative only." },
      exclusions: exclusions.map((row) => ({ reason: row.exclusionReason, count: row._count._all })),
      timeline: events.map((event) => ({ action: event.action, actor: event.actorAdminUserId, outcome: event.outcome, metadata: event.metadata, at: iso(event.createdAt) })).reverse(),
    };
  }

  // Provider quota is account-level. A brand sees it only when it has its own
  // provider account (brand scope); otherwise only mail admins see the
  // account scope. Never throws.
  async function reportQuota(user, organizationId) {
    if (!providerQuota) return null;
    try {
      if (!(await providerQuota.ready())) return { status: "UNAVAILABLE", reason: "Quota reporting is not available until the final gap-closure migration is applied." };
      const organization = await client.mailOrganization.findUnique({ where: { id: organizationId }, select: { slug: true } });
      const { source } = resolveBrandApiKey(organization.slug, { env, config });
      const brandScope = source === "brand" ? quotaScopeFor(organization.slug, source) : null;
      if (brandScope) return await providerQuota.snapshot(brandScope, "resend");
      // Re-audit: a shared-account brand sends with the shared marketing key,
      // whose observations are recorded under "marketing-shared" (not the
      // transactional "account" scope). It spans brands: mail admins only.
      const sharedScope = source === "shared" ? quotaScopeFor(organization.slug, source) : null;
      if (await policy.canAdministerMail(client, user, "VIEW")) return { ...(sharedScope ? await providerQuota.snapshot(sharedScope, "resend") : await providerQuota.snapshot("account", config.provider === "fake" ? "fake" : "resend")), visibleBecause: "MAIL_ADMIN" };
      return { status: "HIDDEN", reason: sharedScope ? "This brand shares the marketing provider account with other brands; its quota is visible to mail administrators only." : "This brand shares the company provider account; its quota is visible to mail administrators only." };
    } catch {
      return { status: "UNAVAILABLE", reason: "Quota could not be read." };
    }
  }

  async function listRecipients(user, organizationId, campaignId, { status, cursor, limit } = {}) {
    await scope(user, organizationId, "VIEW");
    const dispatch = await requireDispatch(organizationId, campaignId);
    const take = pageLimit(limit, 50, 200);
    const position = decodeCursor(cursor);
    const rows = await client.marketingBroadcastRecipient.findMany({
      where: { dispatchId: dispatch.id, ...(status && DELIVERY_STATUSES.includes(status) ? { status } : {}), ...(position ? { OR: [{ createdAt: { gt: position.at } }, { createdAt: position.at, id: { gt: position.id } }] } : {}) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: take + 1,
    });
    const page = rows.slice(0, take);
    return {
      items: page.map((row) => ({ id: row.id, contactId: row.contactId, email: row.email, status: row.status, exclusionReason: row.exclusionReason, lastEventType: row.lastEventType, lastEventAt: iso(row.lastEventAt), openedAt: iso(row.openedAt), clickedAt: iso(row.clickedAt) })),
      nextCursor: rows.length > take ? encodeCursor({ createdAt: page[page.length - 1].createdAt, id: page[page.length - 1].id }) : null,
    };
  }

  // Brand-level dashboard: campaigns, recipients (30 days), suppressions,
  // automations and the brand's marketing job health.
  async function overview(user, organizationId) {
    await scope(user, organizationId, "VIEW");
    const since = new Date(clock().getTime() - 30 * 86400000);
    const [campaigns, recipients, suppressions, automations, enrollments, jobRows, consents] = await Promise.all([
      client.marketingEmailCampaign.groupBy({ by: ["status"], where: { organizationId }, _count: { _all: true } }),
      client.marketingBroadcastRecipient.groupBy({ by: ["status"], where: { organizationId, createdAt: { gt: since } }, _count: { _all: true } }),
      client.marketingSuppression.groupBy({ by: ["reason"], where: { organizationId, liftedAt: null }, _count: { _all: true } }),
      client.marketingAutomation.groupBy({ by: ["status"], where: { organizationId }, _count: { _all: true } }),
      client.marketingAutomationEnrollment.groupBy({ by: ["status"], where: { organizationId }, _count: { _all: true } }),
      client.$queryRaw`SELECT "kind", "status"::text AS "status", COUNT(*)::int AS "count", MIN("next_attempt_at") AS "oldest" FROM "mail_outbox_jobs" WHERE "queue"::text = 'MARKETING' AND "payload"->>'organizationId' = ${organizationId} AND "status"::text IN ('PENDING','LEASED','RETRY_SCHEDULED','RECONCILING','DEAD_LETTER','FAILED') GROUP BY "kind", "status"`,
      client.marketingConsent.groupBy({ by: ["status"], where: { organizationId }, _count: { _all: true } }),
    ]);
    const consentCounts = flattenCounts(consents, "status");
    const flatten = flattenCounts;
    return {
      campaigns: flatten(campaigns, "status"),
      recipientsLast30Days: flatten(recipients, "status"),
      activeSuppressions: flatten(suppressions, "reason"),
      automations: flatten(automations, "status"),
      enrollments: flatten(enrollments, "status"),
      jobs: jobRows.map((row) => ({ kind: row.kind, status: row.status, count: Number(row.count), oldestNextAttemptAt: iso(row.oldest) })),
      // Current consent state per (contact, topic) for this brand.
      subscriptions: { subscribed: consentCounts.GRANTED || 0, pendingConfirmation: consentCounts.PENDING_CONFIRMATION || 0, optedOut: consentCounts.WITHDRAWN || 0, denominator: "consent records (one per contact and topic) of this brand", window: "current state, all time" },
      windows: { recipientsLast30Days: { from: since.toISOString(), to: clock().toISOString(), denominator: "broadcast recipient rows created in the window, by status" } },
      flags: { broadcastDispatchEnabled: config.broadcastDispatchEnabled, automationEnabled: config.automationEnabled, emergencyStop: config.emergencyStop.marketing },
      // GAP 3: estimated (not billed) spend of this brand's dispatches only.
      spend: pricing ? await pricing.brandSpendSummary(organizationId, since) : null,
    };
  }

  function flattenCounts(rows, key) {
    return Object.fromEntries(rows.map((row) => [row[key], row._count._all]));
  }

  async function suppressionReport(user, organizationId, { days = 30 } = {}) {
    await scope(user, organizationId, "VIEW");
    const window = Math.min(Math.max(Number(days) || 30, 1), 365);
    const since = new Date(clock().getTime() - window * 86400000);
    const [active, recent, sources] = await Promise.all([
      client.marketingSuppression.groupBy({ by: ["reason"], where: { organizationId, liftedAt: null }, _count: { _all: true } }),
      client.marketingSuppression.groupBy({ by: ["reason"], where: { organizationId, createdAt: { gt: since } }, _count: { _all: true } }),
      client.marketingSuppression.groupBy({ by: ["source"], where: { organizationId, createdAt: { gt: since } }, _count: { _all: true } }),
    ]);
    const map = (rows, key) => rows.map((row) => ({ [key]: row[key], count: row._count._all }));
    return { windowDays: window, active: map(active, "reason"), added: map(recent, "reason"), bySource: map(sources, "source") };
  }

  return { getBrandSettings, updateBrandSettings, pauseBrand, resumeBrand, schedule, cancel, pause, resume, getDispatch, report, listRecipients, overview, suppressionReport };
}

module.exports = { createBroadcastService };
