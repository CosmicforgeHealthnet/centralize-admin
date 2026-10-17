const { z } = require("zod");
const { executionError } = require("../execution.errors");
const { sanitizeExecutionJson } = require("../execution-json.validator");

const CAMPAIGN_TYPES = Object.freeze(["SEARCH", "AUCTION", "MANUAL", "SPONSORED_CONTENT", "PROMOTED_TWEETS"]);
const PROVIDER_CAMPAIGN_TYPES = Object.freeze({
  GOOGLE_ADS: "SEARCH",
  META: "AUCTION",
  TIKTOK: "MANUAL",
  LINKEDIN: "SPONSORED_CONTENT",
  X: "PROMOTED_TWEETS",
});

const utcTimestamp = z.string().datetime({ offset: false });
const biddingSchema = z.object({
  strategy: z.string().trim().min(1).max(100),
  bidAmount: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  optimizationGoal: z.string().trim().min(1).max(100).optional(),
  billingEvent: z.string().trim().min(1).max(100).optional(),
}).strict();

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(255),
  objective: z.string().trim().min(1).max(100).transform((value) => value.toUpperCase()),
  campaignType: z.enum(CAMPAIGN_TYPES),
  status: z.literal("PAUSED").default("PAUSED"),
  startAt: utcTimestamp,
  endAt: utcTimestamp.nullable().default(null),
  budgetRef: z.string().trim().min(1).max(512),
  bidding: biddingSchema,
  networkOrPlacements: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  declarations: z.record(z.string(), z.union([z.string().max(500), z.boolean(), z.null()])),
  tracking: z.object({ utmTemplate: z.string().trim().max(2000).nullable().default(null) }).strict().default({ utmTemplate: null }),
}).strict();

function validateCampaignDto(input, { provider, resolvedReferences = [], supportedPlacements } = {}) {
  const safe = sanitizeExecutionJson(input, "desiredState");
  const parsed = campaignSchema.safeParse(safe);
  if (!parsed.success) throw executionError("INVALID_EXECUTION_PLAN", { field: "campaign", reasonCode: "INVALID_CAMPAIGN_DTO", issues: parsed.error.issues });
  const campaign = parsed.data;
  if (provider && PROVIDER_CAMPAIGN_TYPES[provider] !== campaign.campaignType) {
    throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, field: "campaignType", campaignType: campaign.campaignType });
  }
  if (new Date(campaign.endAt || "9999-12-31T00:00:00.000Z") <= new Date(campaign.startAt)) {
    throw executionError("INVALID_EXECUTION_PLAN", { field: "endAt", reasonCode: "INVALID_CAMPAIGN_SCHEDULE" });
  }
  if (resolvedReferences.length && !resolvedReferences.includes(campaign.budgetRef)) {
    throw executionError("INVALID_EXECUTION_PLAN", { field: "budgetRef", reasonCode: "UNRESOLVED_BUDGET_REFERENCE" });
  }
  const placements = [...new Set(campaign.networkOrPlacements.map((value) => value.toUpperCase()))];
  if (supportedPlacements && placements.some((value) => !supportedPlacements.includes(value))) {
    throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, field: "networkOrPlacements", reasonCode: "UNSUPPORTED_PLACEMENT" });
  }
  return { ...campaign, networkOrPlacements: placements };
}

module.exports = { CAMPAIGN_TYPES, PROVIDER_CAMPAIGN_TYPES, campaignSchema, validateCampaignDto };
