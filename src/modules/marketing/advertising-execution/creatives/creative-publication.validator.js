const { z } = require("zod");
const { executionError } = require("../execution.errors");
const { sanitizeExecutionJson } = require("../execution-json.validator");
const { normalizeDestinationUrl } = require("./destination-url.policy");

const PROVIDERS = ["GOOGLE_ADS", "META", "TIKTOK", "LINKEDIN", "X"];
const optionalText = (max) => z.string().trim().max(max).nullable().default(null);
const copySchema = z.object({
  headline: optionalText(255), headlines: z.array(z.string().trim().max(255)).max(15).default([]),
  body: optionalText(4000), primaryText: optionalText(4000), description: optionalText(1000),
  descriptions: z.array(z.string().trim().max(1000)).max(4).default([]), callToAction: optionalText(100),
  displayUrl: optionalText(255), path1: optionalText(100), path2: optionalText(100), locale: optionalText(35),
}).strict();
const accessibilitySchema = z.object({
  altText: optionalText(1000), caption: optionalText(2200), transcriptRef: optionalText(512),
  language: optionalText(35), label: optionalText(500), humanSupplied: z.literal(true),
}).strict();
const publicationSchema = z.object({
  creativeAssetId: z.string().trim().min(1).max(255), platform: z.enum(PROVIDERS), connectionId: z.string().uuid(),
  accountExternalId: z.string().trim().min(1).max(255), apiVersion: z.string().trim().min(1).max(64),
  providerFormat: z.string().trim().min(1).max(100).transform((value) => value.toUpperCase()),
  copy: copySchema, destinationUrl: z.string().trim().max(2048), identityReference: z.string().trim().min(1).max(512),
  pageReference: optionalText(512), instagramIdentityReference: optionalText(512),
  campaignExternalId: optionalText(512), groupExternalId: optionalText(512),
  sourceMediaIds: z.array(z.string().trim().min(1).max(512)).min(1).max(20), accessibility: accessibilitySchema,
  thumbnailChecksum: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  renderedProviderReference: optionalText(512), materialTrackingKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(20).default([]),
}).strict();

function unicodeLength(value) { return Array.from(String(value || "").normalize("NFC")).length; }

function validateCreativePublication(input, { providerFormats = [], formatLimits = {}, destinationPolicy = {} } = {}) {
  const parsed = publicationSchema.safeParse(sanitizeExecutionJson(input, "publicationMetadata"));
  if (!parsed.success) throw executionError("INVALID_EXECUTION_PLAN", { field: "creativePublication", reasonCode: "INVALID_CREATIVE_PUBLICATION", issues: parsed.error.issues });
  const value = parsed.data;
  if (providerFormats.length && !providerFormats.includes(value.providerFormat)) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: value.platform, field: "providerFormat", reasonCode: "CREATIVE_FORMAT_UNSUPPORTED" });
  const limits = formatLimits[value.providerFormat] || formatLimits;
  for (const [field, maximum] of Object.entries(limits.textLengths || {})) {
    const candidates = Array.isArray(value.copy[`${field}s`]) && value.copy[`${field}s`].length ? value.copy[`${field}s`] : [value.copy[field]];
    if (candidates.some((text) => text && unicodeLength(text) > maximum)) throw executionError("INVALID_EXECUTION_PLAN", { field: `copy.${field}`, reasonCode: "CREATIVE_TEXT_LIMIT_EXCEEDED", maximum });
  }
  if (limits.headlineCount && value.copy.headlines.length > limits.headlineCount) throw executionError("INVALID_EXECUTION_PLAN", { field: "copy.headlines", reasonCode: "CREATIVE_HEADLINE_COUNT_EXCEEDED" });
  if (limits.descriptionCount && value.copy.descriptions.length > limits.descriptionCount) throw executionError("INVALID_EXECUTION_PLAN", { field: "copy.descriptions", reasonCode: "CREATIVE_DESCRIPTION_COUNT_EXCEEDED" });
  if (limits.pathLength && [value.copy.path1, value.copy.path2].some((part) => unicodeLength(part) > limits.pathLength)) throw executionError("INVALID_EXECUTION_PLAN", { field: "copy.path", reasonCode: "CREATIVE_PATH_LIMIT_EXCEEDED" });
  if (limits.altTextRequired && !value.accessibility.altText) throw executionError("INVALID_EXECUTION_PLAN", { field: "accessibility.altText", reasonCode: "ALT_TEXT_REQUIRED" });
  if (limits.captionRequired && !value.accessibility.caption) throw executionError("INVALID_EXECUTION_PLAN", { field: "accessibility.caption", reasonCode: "CAPTION_REQUIRED" });
  return { ...value, destinationUrl: normalizeDestinationUrl(value.destinationUrl, destinationPolicy) };
}

module.exports = { publicationSchema, unicodeLength, validateCreativePublication };
