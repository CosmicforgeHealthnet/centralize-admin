const { prisma } = require("../../../shared/config/database");
const { resolvePlatformFromSource } = require("./aggregation/aggregation.service");
const { normalizePlatform: normalizeKnownPlatform } = require("./platforms");
const { createSettingsService } = require("./settings.service");
const { hashAnonymousId } = require("./utils/event-id");

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
const DIRECT_SOURCES = new Set(["direct", "none", "unknown", "", "(direct)"]);
const UNRESOLVED = Object.freeze({
  AMBIGUOUS_ACCOUNT: "AMBIGUOUS_ACCOUNT",
  AMBIGUOUS_CAMPAIGN: "AMBIGUOUS_CAMPAIGN",
  MISSING_ACCOUNT_CONTEXT: "MISSING_ACCOUNT_CONTEXT",
  MISSING_CAMPAIGN_CONTEXT: "MISSING_CAMPAIGN_CONTEXT",
  NO_ELIGIBLE_CLICK: "NO_ELIGIBLE_CLICK",
  IDENTITY_UNRESOLVED: "IDENTITY_UNRESOLVED",
  OUTSIDE_ATTRIBUTION_WINDOW: "OUTSIDE_ATTRIBUTION_WINDOW",
  MISSING_ORIGINAL_PAYMENT: "MISSING_ORIGINAL_PAYMENT",
});

function trimString(value, maxLength) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function normalizeSource(source) {
  const normalized = trimString(source, 100);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizePlatform({ platform, source }) {
  const fromPlatform = normalizeKnownPlatform(trimString(platform, 20));
  if (fromPlatform) return fromPlatform;
  return resolvePlatformFromSource(source) || null;
}

function normalizeUtmParams(input = {}) {
  const source = input.utmParams || input.utm || input;
  const normalized = {};

  for (const key of UTM_KEYS) {
    const compactKey = key.replace("utm_", "");
    normalized[key] = trimString(source?.[key] ?? source?.[compactKey], 255);
  }

  return normalized;
}

function toDate(value) {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function hasPaidSignal(attribution) {
  if (!attribution) return false;
  if (attribution.platform || attribution.campaignExternalId) return true;
  const source = normalizeSource(attribution.source);
  if (!source || DIRECT_SOURCES.has(source)) return false;
  const medium = normalizeSource(attribution.utmParams?.utm_medium);
  return Boolean(medium && medium.includes("paid"));
}

function normalizeAttributionPayload(payload = {}) {
  const source = normalizeSource(payload.source ?? payload.utm_source ?? payload.utmParams?.utm_source);
  const platform = normalizePlatform({ platform: payload.platform, source });
  const utmParams = normalizeUtmParams(payload);

  return {
    anonId: trimString(payload.anonId ?? payload.anonymousId ?? payload.session_id ?? payload.sessionId, 255),
    userId: trimString(payload.userId, 255),
    source,
    platform,
    connectionId: trimString(payload.connectionId, 255),
    accountExternalId: trimString(payload.accountExternalId ?? payload.accountId, 255),
    campaignExternalId: trimString(payload.campaignExternalId ?? payload.campaign_id, 255),
    campaignName: trimString(payload.campaignName ?? payload.campaign_name, 512),
    utmParams,
    capturedAt: toDate(payload.capturedAt || payload.occurredAt || payload.timestamp),
  };
}

function mergeAttributionIntoPayload(payload, attribution) {
  if (!attribution) return payload;
  return {
    ...payload,
    anonId: payload.anonId || attribution.anonId || null,
    userId: payload.userId || attribution.userId || null,
    source: payload.source || attribution.source || null,
    platform: payload.platform || attribution.platform || null,
    connectionId: payload.connectionId || attribution.connectionId || null,
    accountExternalId: payload.accountExternalId || attribution.accountExternalId || attribution.accountId || null,
    campaignExternalId: payload.campaignExternalId || attribution.campaignExternalId || null,
    campaignName: payload.campaignName || attribution.campaignName || null,
    utmParams: payload.utmParams || attribution.utmParams || null,
  };
}

function identityWhere(userId, anonIds) {
  const clauses = [];
  if (userId) clauses.push({ userId });
  if (anonIds.length) clauses.push({ anonId: { in: anonIds } });
  return clauses;
}

function distinctValues(rows, field) {
  return new Set(rows.map((row) => row[field]).filter(Boolean));
}

function sortClicks(rows) {
  return [...rows].sort((a, b) => {
    const time = new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
    if (time !== 0) return time;
    return String(b.id || "").localeCompare(String(a.id || ""));
  });
}

function filterByKnownContext(clicks, conversion) {
  let rows = clicks.filter((click) => Boolean(click.campaignExternalId));

  if (conversion.campaignExternalId) {
    rows = rows.filter((click) => click.campaignExternalId === conversion.campaignExternalId);
  }
  if (conversion.platform) {
    rows = rows.filter((click) => click.platform === conversion.platform);
  }
  if (conversion.connectionId) {
    rows = rows.filter((click) => click.connectionId === conversion.connectionId);
  } else if (conversion.accountExternalId) {
    rows = rows.filter((click) => click.accountExternalId === conversion.accountExternalId);
  }

  return rows;
}

function contextKey(row) {
  if (row.connectionId) return `connection:${row.connectionId}`;
  if (row.accountExternalId) {
    return `account:${row.platform || "UNKNOWN"}:${row.accountExternalId}`;
  }
  return null;
}

async function snapshotContexts(db, conversion, campaignExternalId) {
  if (!db.marketing_performance_snapshots?.findMany || !campaignExternalId) return [];
  const rows = await db.marketing_performance_snapshots.findMany({
    where: {
      campaignExternalId,
      ...(conversion.platform ? { platform: conversion.platform } : {}),
      ...(conversion.accountExternalId ? { accountId: conversion.accountExternalId } : {}),
      ...(conversion.connectionId ? { connectionId: conversion.connectionId } : {}),
    },
    select: {
      platform: true,
      connectionId: true,
      accountId: true,
      campaignExternalId: true,
    },
  });
  const unique = new Map();
  for (const row of rows) {
    const normalized = { ...row, accountExternalId: row.accountId || null };
    const key = contextKey(normalized);
    if (key) unique.set(key, normalized);
  }
  return Array.from(unique.values());
}

async function resolveCandidateContext(db, clicks, conversion) {
  if (!conversion.campaignExternalId && distinctValues(clicks, "campaignExternalId").size > 1) {
    return { reason: UNRESOLVED.AMBIGUOUS_CAMPAIGN, candidates: [] };
  }
  if (!conversion.campaignExternalId && distinctValues(clicks, "campaignExternalId").size === 0) {
    return { reason: UNRESOLVED.MISSING_CAMPAIGN_CONTEXT, candidates: [] };
  }

  const scoped = filterByKnownContext(clicks, conversion);
  if (scoped.length === 0) return { reason: UNRESOLVED.NO_ELIGIBLE_CLICK, candidates: [] };

  const campaignExternalId = conversion.campaignExternalId || scoped[0]?.campaignExternalId;
  const clickContexts = new Map();
  for (const click of scoped) {
    const key = contextKey(click);
    if (key) clickContexts.set(key, click);
  }

  if (conversion.connectionId) {
    return { reason: null, candidates: scoped, resolvedContext: null };
  }

  if (conversion.accountExternalId) {
    const connectionIds = distinctValues(scoped, "connectionId");
    if (connectionIds.size > 1) {
      return { reason: UNRESOLVED.AMBIGUOUS_ACCOUNT, candidates: [] };
    }

    if (connectionIds.size === 1) {
      return {
        reason: null,
        candidates: scoped,
        resolvedContext: { connectionId: Array.from(connectionIds)[0] },
      };
    }

    if (distinctValues(scoped, "platform").size > 1) {
      return { reason: UNRESOLVED.AMBIGUOUS_ACCOUNT, candidates: [] };
    }

    const snapshots = await snapshotContexts(db, conversion, campaignExternalId);
    if (snapshots.length > 1) {
      return { reason: UNRESOLVED.AMBIGUOUS_ACCOUNT, candidates: [] };
    }
    return {
      reason: null,
      candidates: scoped,
      resolvedContext: snapshots[0] || null,
    };
  }

  if (clickContexts.size > 1) {
    return { reason: UNRESOLVED.AMBIGUOUS_ACCOUNT, candidates: [] };
  }
  if (clickContexts.size === 1) {
    return {
      reason: null,
      candidates: scoped,
      resolvedContext: Array.from(clickContexts.values())[0],
    };
  }

  const snapshots = await snapshotContexts(db, conversion, campaignExternalId);
  if (snapshots.length > 1) {
    return { reason: UNRESOLVED.AMBIGUOUS_ACCOUNT, candidates: [] };
  }
  if (snapshots.length === 0) {
    return { reason: UNRESOLVED.MISSING_ACCOUNT_CONTEXT, candidates: [] };
  }

  return { reason: null, candidates: scoped, resolvedContext: snapshots[0] };
}

async function persistDecision(db, decision) {
  if (db.marketing_attribution_decisions?.upsert) {
    await db.marketing_attribution_decisions.upsert({
      where: { conversionEventId: decision.conversionEventId },
      create: decision,
      update: decision,
    });
  } else if (db.marketing_attribution_decisions?.create) {
    await db.marketing_attribution_decisions.create({ data: decision });
  }

}

function createAttributionService({ prisma: db = prisma, settings } = {}) {
  const settingsService = settings || createSettingsService({ prisma: db });

  async function captureClick(payload = {}) {
    const normalized = normalizeAttributionPayload(payload);
    if (!normalized.anonId) {
      const error = new Error("anonId is required for attribution capture");
      error.statusCode = 400;
      throw error;
    }

    const existing = await db.marketing_attributions.findUnique({
      where: { anonId: normalized.anonId },
    });

    const incomingPaid = hasPaidSignal(normalized);
    const existingPaid = hasPaidSignal(existing);
    const now = normalized.capturedAt;

    if (!existing) {
      return db.marketing_attributions.create({
        data: {
          anonId: normalized.anonId,
          userId: normalized.userId,
          source: normalized.source,
          platform: normalized.platform,
          connectionId: normalized.connectionId,
          accountExternalId: normalized.accountExternalId,
          campaignExternalId: normalized.campaignExternalId,
          campaignName: normalized.campaignName,
          utmParams: normalized.utmParams,
          firstCapturedAt: now,
          lastSeenAt: now,
          convertedAt: normalized.userId ? now : null,
        },
      });
    }

    const update = { lastSeenAt: now };
    if (normalized.userId && !existing.userId) update.userId = normalized.userId;
    if (normalized.userId && !existing.convertedAt) update.convertedAt = now;

    if (!existingPaid && incomingPaid) {
      Object.assign(update, {
        source: normalized.source,
        platform: normalized.platform,
        connectionId: normalized.connectionId,
        accountExternalId: normalized.accountExternalId,
        campaignExternalId: normalized.campaignExternalId,
        campaignName: normalized.campaignName,
        utmParams: normalized.utmParams,
        firstCapturedAt: existing.firstCapturedAt || now,
      });
    } else if (!existingPaid && !incomingPaid) {
      update.utmParams = existing.utmParams || normalized.utmParams;
      update.source = existing.source || normalized.source;
    }

    return db.marketing_attributions.update({
      where: { anonId: normalized.anonId },
      data: update,
    });
  }

  async function linkUser({ userId, anonId, occurredAt, sourceSignupEventId } = {}) {
    const normalizedUserId = trimString(userId, 255);
    const normalizedAnonId = trimString(anonId, 255);
    if (!normalizedUserId || !normalizedAnonId) return null;

    const linkedAt = toDate(occurredAt);
    const anonIdHash = hashAnonymousId(normalizedAnonId);

    if (db.marketing_identity_links?.findUnique) {
      const existingLink = await db.marketing_identity_links.findUnique({
        where: { anonIdHash },
      });
      if (existingLink && existingLink.userId !== normalizedUserId) {
        if (db.marketing_identity_links.update) {
          return db.marketing_identity_links.update({
            where: { id: existingLink.id },
            data: {
              status: "CONFLICT",
              conflictReason: "ANON_ID_ALREADY_LINKED",
            },
          });
        }
        return { ...existingLink, status: "CONFLICT", conflictReason: "ANON_ID_ALREADY_LINKED" };
      }
      if (!existingLink && db.marketing_identity_links.create) {
        await db.marketing_identity_links.create({
          data: {
            anonIdHash,
            userId: normalizedUserId,
            sourceSignupEventId: sourceSignupEventId || null,
            linkedAt,
          },
        });
      }
    }

    const attribution = await db.marketing_attributions.findUnique({
      where: { anonId: normalizedAnonId },
    });
    if (!attribution) return null;
    if (attribution.userId && attribution.userId !== normalizedUserId) return attribution;

    return db.marketing_attributions.update({
      where: { anonId: attribution.anonId },
      data: {
        userId: normalizedUserId,
        convertedAt: attribution.convertedAt || linkedAt,
        lastSeenAt: linkedAt,
      },
    });
  }

  async function resolveForPayload(payload = {}) {
    const anonId = trimString(payload.anonId, 255);
    const userId = trimString(payload.userId, 255);

    if (anonId) {
      const byAnon = await db.marketing_attributions.findUnique({ where: { anonId } });
      if (byAnon) return byAnon;
    }

    if (userId) {
      const rows = await db.marketing_attributions.findMany({
        where: { userId },
        orderBy: { firstCapturedAt: "asc" },
        take: 1,
      });
      return rows[0] || null;
    }

    return null;
  }

  async function enrichPayload(payload = {}) {
    if (payload.campaignExternalId && payload.source && (payload.connectionId || payload.accountExternalId)) {
      return payload;
    }
    const attribution = await resolveForPayload(payload);
    return mergeAttributionIntoPayload(payload, attribution);
  }

  async function linkedAnonIds(userId, directAnonId) {
    const anonIds = new Set();
    if (directAnonId) {
      let linkAllowsIdentity = true;
      if (userId && db.marketing_identity_links?.findUnique) {
        const link = await db.marketing_identity_links.findUnique({
          where: { anonIdHash: hashAnonymousId(directAnonId) },
        });
        linkAllowsIdentity = !link || link.userId === userId;
      }
      if (linkAllowsIdentity) anonIds.add(directAnonId);
    }
    if (!userId) return Array.from(anonIds);

    const attributionRows = await db.marketing_attributions.findMany({
      where: { userId },
      select: { anonId: true },
    });
    for (const row of attributionRows) {
      if (row.anonId) anonIds.add(row.anonId);
    }
    return Array.from(anonIds);
  }

  async function resolveLastTouchForConversion(conversionEvent) {
    if (!["SIGNUP", "PAYMENT", "ACTIVE"].includes(conversionEvent.stage)) return null;

    const attributionWindowDays = await settingsService.getAttributionWindowDays();
    const windowEnd = toDate(conversionEvent.occurredAt);
    const windowStart = new Date(windowEnd.getTime() - attributionWindowDays * 24 * 60 * 60 * 1000);
    const anonIds = await linkedAnonIds(conversionEvent.userId, conversionEvent.anonId);
    const clauses = identityWhere(conversionEvent.userId, anonIds);
    const resolvedAt = new Date();

    const baseDecision = {
      conversionEventId: conversionEvent.id,
      selectedClickEventId: null,
      model: "LAST_TOUCH",
      attributionWindowDays,
      windowStart,
      windowEnd,
      platform: conversionEvent.platform || null,
      connectionId: conversionEvent.connectionId || null,
      accountExternalId: conversionEvent.accountExternalId || null,
      campaignExternalId: conversionEvent.campaignExternalId || null,
      status: "UNRESOLVED",
      unresolvedReason: null,
      resolvedAt,
    };

    if (conversionEvent.userId && conversionEvent.anonId && db.marketing_identity_links?.findUnique) {
      const link = await db.marketing_identity_links.findUnique({
        where: { anonIdHash: hashAnonymousId(conversionEvent.anonId) },
      });
      if (link && link.userId !== conversionEvent.userId) {
        const decision = { ...baseDecision, unresolvedReason: UNRESOLVED.IDENTITY_UNRESOLVED };
        await persistDecision(db, decision);
        return decision;
      }
    }

    if (clauses.length === 0) {
      const decision = { ...baseDecision, unresolvedReason: UNRESOLVED.IDENTITY_UNRESOLVED };
      await persistDecision(db, decision);
      return decision;
    }

    const clicks = await db.marketing_funnel_events.findMany({
      where: {
        stage: "CLICK",
        occurredAt: { gte: windowStart, lte: windowEnd },
        OR: clauses,
      },
    });

    if (clicks.length === 0) {
      const olderClicks = await db.marketing_funnel_events.findMany({
        where: {
          stage: "CLICK",
          occurredAt: { lt: windowStart },
          OR: clauses,
        },
        take: 1,
      });
      const decision = {
        ...baseDecision,
        unresolvedReason:
          olderClicks.length > 0
            ? UNRESOLVED.OUTSIDE_ATTRIBUTION_WINDOW
            : UNRESOLVED.NO_ELIGIBLE_CLICK,
      };
      await persistDecision(db, decision);
      return decision;
    }

    const resolution = await resolveCandidateContext(db, clicks, conversionEvent);
    if (resolution.reason) {
      const decision = { ...baseDecision, unresolvedReason: resolution.reason };
      await persistDecision(db, decision);
      return decision;
    }

    const selected = sortClicks(resolution.candidates)[0];
    const resolvedContext = resolution.resolvedContext || {};
    const decision = {
      ...baseDecision,
      selectedClickEventId: selected.id,
      platform: selected.platform || resolvedContext.platform || conversionEvent.platform || null,
      connectionId: selected.connectionId || resolvedContext.connectionId || conversionEvent.connectionId || null,
      accountExternalId: selected.accountExternalId || resolvedContext.accountExternalId || conversionEvent.accountExternalId || null,
      campaignExternalId: selected.campaignExternalId || conversionEvent.campaignExternalId || null,
      status: "ATTRIBUTED",
      unresolvedReason: null,
    };
    await persistDecision(db, decision);
    return decision;
  }

  async function copyOriginalPaymentAttribution(adjustmentEvent) {
    const originalPaymentExternalEventId = trimString(
      adjustmentEvent.originalPaymentExternalEventId,
      255,
    );
    const resolvedAt = new Date();
    const windowEnd = toDate(adjustmentEvent.occurredAt);
    const windowStart = windowEnd;
    const attributionWindowDays = await settingsService.getAttributionWindowDays();
    const baseDecision = {
      conversionEventId: adjustmentEvent.id,
      selectedClickEventId: null,
      model: "LAST_TOUCH",
      attributionWindowDays,
      windowStart,
      windowEnd,
      platform: adjustmentEvent.platform || null,
      connectionId: adjustmentEvent.connectionId || null,
      accountExternalId: adjustmentEvent.accountExternalId || null,
      campaignExternalId: adjustmentEvent.campaignExternalId || null,
      status: "UNRESOLVED",
      unresolvedReason: UNRESOLVED.MISSING_ORIGINAL_PAYMENT,
      resolvedAt,
    };

    if (!originalPaymentExternalEventId) {
      await persistDecision(db, baseDecision);
      return baseDecision;
    }

    const payment = await db.marketing_funnel_events.findUnique({
      where: { externalEventId: originalPaymentExternalEventId },
    });
    if (!payment || payment.stage !== "PAYMENT") {
      await persistDecision(db, baseDecision);
      return baseDecision;
    }

    const paymentDecision = db.marketing_attribution_decisions?.findUnique
      ? await db.marketing_attribution_decisions.findUnique({
          where: { conversionEventId: payment.id },
        })
      : null;

    const decision = {
      ...baseDecision,
      selectedClickEventId: paymentDecision?.selectedClickEventId || payment.attributedClickEventId || null,
      platform: payment.platform || paymentDecision?.platform || null,
      connectionId: payment.connectionId || paymentDecision?.connectionId || null,
      accountExternalId: payment.accountExternalId || paymentDecision?.accountExternalId || null,
      campaignExternalId: payment.campaignExternalId || paymentDecision?.campaignExternalId || null,
      status:
        paymentDecision?.status === "ATTRIBUTED" || payment.attributionStatus === "ATTRIBUTED"
          ? "ATTRIBUTED"
          : "UNRESOLVED",
      unresolvedReason:
        paymentDecision?.status === "ATTRIBUTED" || payment.attributionStatus === "ATTRIBUTED"
          ? null
          : paymentDecision?.unresolvedReason || payment.unresolvedReason || UNRESOLVED.NO_ELIGIBLE_CLICK,
    };
    await persistDecision(db, decision);
    return decision;
  }

  return {
    captureClick,
    linkUser,
    resolveForPayload,
    enrichPayload,
    linkedAnonIds,
    resolveLastTouchForConversion,
    copyOriginalPaymentAttribution,
  };
}

const defaultService = createAttributionService();

module.exports = {
  createAttributionService,
  normalizeAttributionPayload,
  normalizeSource,
  normalizePlatform,
  normalizeUtmParams,
  mergeAttributionIntoPayload,
  hasPaidSignal,
  resolveCandidateContext,
  UNRESOLVED,
  ...defaultService,
};
