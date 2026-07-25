const crypto = require("crypto");
const { Prisma } = require("../../../../generated/admin-client");
const { sanitizeProviderText } = require("../connectors/provider-http");
const { AD_PLATFORMS } = require("../platforms");
const { sanitizePlainText, sanitizeBoundedJson } = require("../validation-security");

const CREATIVE_TYPES = new Set(["IMAGE", "VIDEO", "CAROUSEL", "TEXT", "RESPONSIVE", "OTHER", "UNKNOWN"]);
const SECRET_KEY = /token|secret|authorization|credential|cookie|signature|client.?secret|oauth|code/i;
const SECRET_QUERY = /token|secret|signature|authorization|auth|key|code|credential|cookie/i;

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cleanText(value) {
  if (value === undefined || value === null || value === "") return null;
  return sanitizePlainText(sanitizeProviderText(String(value)), 8000);
}

function sanitizeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (!["http:", "https:"].includes(url.protocol)) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY.test(key)) url.searchParams.delete(key);
    }
    url.username = "";
    url.password = "";
    return url.toString();
  } catch (_error) {
    return null;
  }
}

function sanitizeObject(value, depth = 0) {
  if (depth > 8 || value === undefined) return undefined;
  return sanitizeBoundedJson(value, { maxBytes: 64 * 1024, maxDepth: 8, maxFields: 100, maxArray: 200, maxString: 4000 });
}

function utcDate(value) {
  const date = value instanceof Date ? value : new Date(`${String(value || "").slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error("creative insight date must be valid");
  return date.toISOString().slice(0, 10);
}

function exactDecimal(value, field) {
  if (value === undefined || value === null || value === "") return null;
  try {
    const decimal = new Prisma.Decimal(String(value));
    if (!decimal.isFinite() || decimal.isNegative()) throw new Error();
    return decimal;
  } catch (_error) {
    throw new Error(`${field} must be a non-negative decimal`);
  }
}

function count(value, field) {
  if (value === undefined || value === null || value === "") return null;
  try {
    const result = BigInt(value);
    if (result < 0n) throw new Error();
    return result;
  } catch (_error) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

function platform(value) {
  const normalized = String(value || "").toUpperCase();
  if (!AD_PLATFORMS.includes(normalized)) throw new Error("unsupported creative platform");
  return normalized;
}

function sourceIdentity(input) {
  return [
    platform(input.platform),
    input.accountExternalId,
    input.campaignExternalId,
    input.adGroupExternalId || "-",
    input.adExternalId || "-",
    input.creativeExternalId || "-",
  ].map((part) => String(part || "").trim()).join(":");
}

function normalizeCreativeAsset(input, context = {}) {
  const normalizedPlatform = platform(input.platform || context.platform);
  const accountExternalId = String(input.accountExternalId || context.accountExternalId || "").trim();
  const campaignExternalId = String(input.campaignExternalId || "").trim();
  const connectionId = String(input.connectionId || context.connectionId || "").trim();
  if (!connectionId || !accountExternalId || !campaignExternalId) {
    throw new Error("creative asset requires connection, account, and campaign identifiers");
  }
  const nativeIdentity = sanitizeObject(input.nativeIdentifiers || {});
  const sanitizedSourceUrl = sanitizeUrl(input.sourceUrl);
  const fingerprintBasis = canonicalJson({
    platform: normalizedPlatform,
    accountExternalId,
    campaignExternalId,
    adGroupExternalId: input.adGroupExternalId || null,
    adExternalId: input.adExternalId || null,
    nativeIdentity,
    creativeHash: input.creativeHash || null,
    sourceUrl: sanitizedSourceUrl,
  });
  if (!input.creativeExternalId
    && !input.adExternalId
    && !input.adGroupExternalId
    && !input.creativeHash
    && !sanitizedSourceUrl
    && Object.keys(nativeIdentity || {}).length === 0) {
    throw new Error("creative asset requires a stable provider or content identity");
  }
  const creativeExternalId = String(input.creativeExternalId || `fingerprint:${stableHash(fingerprintBasis)}`).trim();
  const identity = sourceIdentity({ ...input, platform: normalizedPlatform, accountExternalId, campaignExternalId, creativeExternalId });
  const type = CREATIVE_TYPES.has(String(input.type || "").toUpperCase())
    ? String(input.type).toUpperCase()
    : "UNKNOWN";
  const firstSeenAt = new Date(input.firstSeenAt || context.retrievedAt || Date.now());
  const lastSeenAt = new Date(input.lastSeenAt || context.retrievedAt || Date.now());
  if (Number.isNaN(firstSeenAt.getTime()) || Number.isNaN(lastSeenAt.getTime())) throw new Error("invalid creative timestamps");

  return {
    platform: normalizedPlatform,
    connectionId,
    accountExternalId,
    campaignExternalId,
    adGroupExternalId: input.adGroupExternalId ? String(input.adGroupExternalId) : null,
    adExternalId: input.adExternalId ? String(input.adExternalId) : null,
    creativeExternalId,
    sourceKey: String(input.sourceKey || stableHash(identity)),
    name: sanitizePlainText(sanitizeProviderText(String(input.name ?? "")), 512),
    type,
    status: sanitizePlainText(sanitizeProviderText(String(input.status ?? "")), 100),
    durationSeconds: input.durationSeconds === undefined || input.durationSeconds === null ? null : Math.max(0, Math.round(Number(input.durationSeconds))),
    hasHumanPresence: typeof input.hasHumanPresence === "boolean" ? input.hasHumanPresence : null,
    ctaType: sanitizePlainText(sanitizeProviderText(String(input.ctaType ?? "")), 100),
    headline: sanitizePlainText(sanitizeProviderText(String(input.headline ?? "")), 4000),
    bodyText: sanitizePlainText(sanitizeProviderText(String(input.bodyText ?? "")), 8000),
    sourceUrl: sanitizedSourceUrl,
    thumbnailUrl: sanitizeUrl(input.thumbnailUrl),
    creativeHash: input.creativeHash ? String(input.creativeHash) : null,
    nativeIdentifiers: nativeIdentity,
    metadata: sanitizeObject({ nativeType: input.nativeType || input.type, ...(input.metadata || {}) }),
    firstSeenAt,
    lastSeenAt,
  };
}

function normalizeCreativeInsight(input, context = {}) {
  const normalizedPlatform = platform(input.platform || context.platform);
  const connectionId = String(input.connectionId || context.connectionId || "").trim();
  const accountExternalId = String(input.accountExternalId || context.accountExternalId || "").trim();
  const campaignExternalId = String(input.campaignExternalId || "").trim();
  const creativeExternalId = String(input.creativeExternalId || "").trim();
  if (!connectionId || !accountExternalId || !campaignExternalId || !creativeExternalId) {
    throw new Error("creative insight requires connection, account, campaign, and creative identifiers");
  }
  const date = utcDate(input.date);
  const spend = exactDecimal(input.spend, "spend");
  const revenue = exactDecimal(input.revenue, "revenue");
  const currencyCode = input.currencyCode ? String(input.currencyCode).trim().toUpperCase() : null;
  if ((spend !== null || revenue !== null) && !/^[A-Z]{3}$/.test(currencyCode || "")) {
    throw new Error("currencyCode is required when spend or revenue is present");
  }
  const identity = sourceIdentity({ ...input, platform: normalizedPlatform, accountExternalId, campaignExternalId, creativeExternalId });
  const segmentation = canonicalJson(sanitizeObject(input.segmentation || input.metadata?.segmentation || {}));
  return {
    platform: normalizedPlatform,
    connectionId,
    accountExternalId,
    campaignExternalId,
    adGroupExternalId: input.adGroupExternalId ? String(input.adGroupExternalId) : null,
    adExternalId: input.adExternalId ? String(input.adExternalId) : null,
    creativeExternalId,
    sourceKey: stableHash(identity),
    sourceMetricKey: String(input.sourceMetricKey || stableHash(`${identity}:${segmentation}`)),
    date,
    currencyCode,
    spend,
    revenue,
    impressions: count(input.impressions, "impressions"),
    reach: count(input.reach, "reach"),
    clicks: count(input.clicks, "clicks"),
    providerConversions: exactDecimal(input.providerConversions, "providerConversions"),
    metadata: sanitizeObject({
      ...(input.metadata || {}),
      providerConversionsInformational: true,
      internalAttribution: input.trustworthyCreativeAttribution ? "TRUSTWORTHY" : "CAMPAIGN_ONLY_OR_UNAVAILABLE",
      revenueSource: input.trustworthyCreativeAttribution && input.internalRevenue === true
        ? "INTERNAL_ATTRIBUTED"
        : "PROVIDER_INFORMATIONAL",
    }),
    rawProviderRecord: sanitizeObject(input.rawProviderRecord || input.raw || input),
    attributedSignups: input.trustworthyCreativeAttribution ? count(input.attributedSignups, "attributedSignups") : null,
    attributedPayments: input.trustworthyCreativeAttribution ? count(input.attributedPayments, "attributedPayments") : null,
  };
}

function capability(platformName, overrides = {}) {
  return {
    platform: platform(platformName),
    status: overrides.status || "AVAILABLE",
    supportsCreativeCatalog: Boolean(overrides.supportsCreativeCatalog),
    supportsCreativeInsights: Boolean(overrides.supportsCreativeInsights),
    supportedCreativeGrain: overrides.supportedCreativeGrain || null,
    supportedMetrics: overrides.supportedMetrics || [],
    attributionMetadata: overrides.attributionMetadata || null,
    providerApiVersion: overrides.providerApiVersion || null,
    limitations: overrides.limitations || [],
  };
}

module.exports = {
  cleanText,
  sanitizeUrl,
  sanitizeObject,
  stableHash,
  canonicalJson,
  exactDecimal,
  normalizeCreativeAsset,
  normalizeCreativeInsight,
  capability,
};
