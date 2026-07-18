// Shared connector contract for advertising platform connectors.
//
// JavaScript has no formal interfaces; every connector must export an object
// with this shape:
//
//   {
//     platform: "META" | "TIKTOK" | "X" | "LINKEDIN" | "GOOGLE_ADS",
//     validateConfiguration({ connection }) -> { ok: boolean, reason?: string },
//     fetchDailyCampaignInsights({ since, until, connection, onTokensRefreshed })
//       -> Promise<NormalizedRow[]>,
//   }
//
// `since` / `until` are inclusive "YYYY-MM-DD" UTC date strings.
// `connection` is an optional marketing_ad_platform_connections record; when
// absent the connector falls back to its environment credentials.
// `onTokensRefreshed(tokens)` is an optional callback a connector invokes
// after rotating provider tokens (e.g. TikTok refresh); the caller persists
// them encrypted. Connectors without a refresh lifecycle ignore it.
//
// Every normalized row must match:
//
//   {
//     platform:           "META" | "TIKTOK" | "X" | "LINKEDIN" | "GOOGLE_ADS",
//     campaignExternalId: string,
//     campaignName:       string,
//     date:               "YYYY-MM-DD" (UTC day),
//     spend:              string decimal, e.g. "1234.56" (major currency units),
//     currency:           ISO currency code or "UNSPECIFIED",
//     impressions:        non-negative integer,
//     clicks:             non-negative integer,
//     raw:                untouched provider row (object),
//   }

const { AD_PLATFORMS } = require("../platforms");

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Coerce a provider count value to a safe non-negative integer. Missing or
// malformed values become 0  never NaN.
function safeCount(value) {
  if (value === undefined || value === null || value === "") return 0;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;

  return Math.round(parsed);
}

// Coerce a provider monetary value to a decimal-compatible string with two
// fraction digits. Missing or malformed values become "0.00"  never NaN.
function safeSpend(value) {
  if (value === undefined || value === null || value === "") return "0.00";

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return "0.00";

  return parsed.toFixed(2);
}

// Normalize a provider-supplied date into a strict UTC "YYYY-MM-DD" string,
// or null when it cannot be interpreted.
function toUtcDateString(value) {
  // Provider daily stats ("2026-07-01" or "2026-07-01 00:00:00") name the
  // reporting day literally  take the date prefix, never shift through the
  // server's local timezone.
  if (typeof value === "string") {
    const prefix = value.trim().slice(0, 10);
    if (DATE_ONLY_REGEX.test(prefix)) {
      const parsed = new Date(`${prefix}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime())) return null;
      return parsed.toISOString().slice(0, 10);
    }
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }

  return null;
}

// Validate a normalized row before persistence. Returns { ok, reason }.
function validateNormalizedRow(row) {
  if (!row || typeof row !== "object") {
    return { ok: false, reason: "row is not an object" };
  }
  if (!AD_PLATFORMS.includes(row.platform)) {
    return { ok: false, reason: `unknown platform: ${row.platform}` };
  }
  if (typeof row.campaignExternalId !== "string" || !row.campaignExternalId) {
    return { ok: false, reason: "missing campaignExternalId" };
  }
  if (typeof row.date !== "string" || !DATE_ONLY_REGEX.test(row.date)) {
    return { ok: false, reason: `invalid date: ${row.date}` };
  }
  if (typeof row.spend !== "string" || !/^\d+(\.\d{1,2})?$/.test(row.spend)) {
    return { ok: false, reason: `invalid spend: ${row.spend}` };
  }
  if (!Number.isInteger(row.impressions) || row.impressions < 0) {
    return { ok: false, reason: `invalid impressions: ${row.impressions}` };
  }
  if (!Number.isInteger(row.clicks) || row.clicks < 0) {
    return { ok: false, reason: `invalid clicks: ${row.clicks}` };
  }
  if (!row.raw || typeof row.raw !== "object") {
    return { ok: false, reason: "missing raw provider row" };
  }

  return { ok: true };
}

module.exports = {
  AD_PLATFORMS,
  safeCount,
  safeSpend,
  toUtcDateString,
  validateNormalizedRow,
};
