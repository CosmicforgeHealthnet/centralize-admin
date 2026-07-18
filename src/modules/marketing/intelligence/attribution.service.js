const { prisma } = require("../../../shared/config/database");
const { resolvePlatformFromSource } = require("./aggregation/aggregation.service");
const { normalizePlatform: normalizeKnownPlatform } = require("./platforms");

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
const DIRECT_SOURCES = new Set(["direct", "none", "unknown", "", "(direct)"]);

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
    anonId: trimString(payload.anonId ?? payload.session_id ?? payload.sessionId, 255),
    userId: trimString(payload.userId, 255),
    source,
    platform,
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
    campaignExternalId: payload.campaignExternalId || attribution.campaignExternalId || null,
    campaignName: payload.campaignName || attribution.campaignName || null,
    utmParams: payload.utmParams || attribution.utmParams || null,
  };
}

function createAttributionService({ prisma: db = prisma } = {}) {
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

    // Phase 1 attribution rule: first paid touch wins. Later direct visits or
    // later paid touches do not replace an existing paid acquisition.
    if (!existingPaid && incomingPaid) {
      Object.assign(update, {
        source: normalized.source,
        platform: normalized.platform,
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

  async function linkUser({ userId, anonId, occurredAt } = {}) {
    const normalizedUserId = trimString(userId, 255);
    const normalizedAnonId = trimString(anonId, 255);
    if (!normalizedUserId) return null;

    let attribution = null;
    if (normalizedAnonId) {
      attribution = await db.marketing_attributions.findUnique({
        where: { anonId: normalizedAnonId },
      });
    }

    if (!attribution) return null;
    if (attribution.userId && attribution.userId !== normalizedUserId) return attribution;

    return db.marketing_attributions.update({
      where: { anonId: attribution.anonId },
      data: {
        userId: normalizedUserId,
        convertedAt: attribution.convertedAt || toDate(occurredAt),
        lastSeenAt: toDate(occurredAt),
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
    if (payload.campaignExternalId && payload.source) return payload;
    const attribution = await resolveForPayload(payload);
    return mergeAttributionIntoPayload(payload, attribution);
  }

  return { captureClick, linkUser, resolveForPayload, enrichPayload };
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
  ...defaultService,
};
