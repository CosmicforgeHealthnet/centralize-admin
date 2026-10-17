const { executionError } = require("../execution.errors");

// Deliberately conservative bounds. Versions must be configured explicitly;
// unlisted formats fail closed instead of inheriting another provider's rules.
const IMAGE = Object.freeze({
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"], maxBytes: 5 * 1024 * 1024,
  minWidth: 600, maxWidth: 8192, minHeight: 314, maxHeight: 8192,
  aspectRatios: ["1:1", "1.91:1", "4:5", "9:16"], malwareScanRequired: true,
  textLengths: { headline: 40, body: 125, description: 30 }, altTextRequired: true,
});
const VIDEO = Object.freeze({
  allowedMimeTypes: ["video/mp4"], maxBytes: 250 * 1024 * 1024,
  minWidth: 600, maxWidth: 4096, minHeight: 600, maxHeight: 4096,
  aspectRatios: ["1:1", "4:5", "16:9", "9:16"], minDurationSeconds: 1,
  maxDurationSeconds: 60, malwareScanRequired: true, textLengths: { headline: 40, body: 125, description: 30 },
  captionRequired: true,
});

const RULES = Object.freeze({
  GOOGLE_ADS: Object.freeze({ RESPONSIVE_SEARCH_AD: Object.freeze({ allowedMimeTypes: ["image/jpeg", "image/png"], maxBytes: 5 * 1024 * 1024, textLengths: { headline: 30, body: 90, description: 90 }, headlineCount: 15, descriptionCount: 4, pathLength: 15, malwareScanRequired: true }) }),
  META: Object.freeze({ IMAGE, VIDEO }),
  TIKTOK: Object.freeze({ VIDEO_REFERENCE: Object.freeze({ ...VIDEO, maxBytes: 100 * 1024 * 1024, minDurationSeconds: 5, maxDurationSeconds: 60 }) }),
  LINKEDIN: Object.freeze({ SINGLE_IMAGE: Object.freeze({ ...IMAGE, maxBytes: 5 * 1024 * 1024 }), VIDEO: Object.freeze({ ...VIDEO, maxBytes: 200 * 1024 * 1024, maxDurationSeconds: 600 }) }),
  X: Object.freeze({ IMAGE: Object.freeze({ ...IMAGE, maxBytes: 5 * 1024 * 1024 }), VIDEO: Object.freeze({ ...VIDEO, maxBytes: 512 * 1024 * 1024, maxDurationSeconds: 140 }) }),
});

function providerCreativeRules({ provider, apiVersion, format }) {
  if (!String(apiVersion || "").trim()) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, reasonCode: "PROVIDER_API_VERSION_REQUIRED" });
  const rules = RULES[provider]?.[String(format || "").toUpperCase()];
  if (!rules) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, apiVersion, format, reasonCode: "CREATIVE_RULES_UNAVAILABLE" });
  return Object.freeze({ ...rules, provider, apiVersion, format: String(format).toUpperCase() });
}

function supportedCreativeFormats(provider) { return Object.keys(RULES[provider] || {}); }

module.exports = { RULES, providerCreativeRules, supportedCreativeFormats };
