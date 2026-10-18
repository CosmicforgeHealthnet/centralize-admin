const { IMMUTABLE_FIELDS } = require("../campaigns/immutable-field-policy");

const COMMON_OPERATIONS = Object.freeze(["CREATE", "UPDATE", "PAUSE", "RESUME", "ARCHIVE", "REMOVE_LINK"]);

const PROVIDER_DEFINITIONS = Object.freeze({
  GOOGLE_ADS: Object.freeze({
    provider: "GOOGLE_ADS", versionPattern: /^v\d+(?:\.\d+)?$/, campaignTypes: ["SEARCH"],
    operationTypes: COMMON_OPERATIONS, resourceTypes: ["BUDGET", "CAMPAIGN", "GROUP", "TARGETING", "CREATIVE", "AD", "ASSET_LINK"],
    objectives: ["SALES", "LEADS", "WEBSITE_TRAFFIC"], placements: ["SEARCH", "SEARCH_PARTNERS"],
    budgetUnitSemantics: "AVERAGE_DAILY_MICROS", nativeValidationAvailable: true, atomicity: "PLAN", idempotency: "LIMITED",
    immutableFields: IMMUTABLE_FIELDS.GOOGLE_ADS, requiredScopes: ["https://www.googleapis.com/auth/adwords"], eligibleRoles: ["ADMIN", "STANDARD"],
    details: { searchOnly: true, batchJobSupported: false, partialFailureDefault: false, sharedBudgetMutationDefault: false, politicalAdvertisingSupported: false },
  }),
  META: Object.freeze({
    provider: "META", versionPattern: /^v\d+(?:\.\d+)?$/, campaignTypes: ["AUCTION"],
    operationTypes: COMMON_OPERATIONS, resourceTypes: ["CAMPAIGN", "GROUP", "CREATIVE", "AD", "TARGETING"],
    objectives: ["OUTCOME_AWARENESS", "OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_SALES"], placements: ["FACEBOOK_FEED", "INSTAGRAM_FEED", "INSTAGRAM_STORIES", "INSTAGRAM_REELS"],
    budgetUnitSemantics: "ACCOUNT_CURRENCY_MAJOR_UNITS", nativeValidationAvailable: false, atomicity: "OPERATION", idempotency: "LIMITED",
    immutableFields: IMMUTABLE_FIELDS.META, requiredScopes: ["ads_management"], eligibleRoles: ["ADMIN", "ADVERTISER"],
    biddingCompatibility: {
      OUTCOME_AWARENESS: { optimizationGoals: ["REACH", "IMPRESSIONS"], billingEvents: ["IMPRESSIONS"] },
      OUTCOME_TRAFFIC: { optimizationGoals: ["LINK_CLICKS", "LANDING_PAGE_VIEWS"], billingEvents: ["IMPRESSIONS", "LINK_CLICKS"] },
      OUTCOME_ENGAGEMENT: { optimizationGoals: ["POST_ENGAGEMENT", "THRUPLAY"], billingEvents: ["IMPRESSIONS"] },
      OUTCOME_LEADS: { optimizationGoals: ["LEAD_GENERATION"], billingEvents: ["IMPRESSIONS"] },
      OUTCOME_SALES: { optimizationGoals: ["OFFSITE_CONVERSIONS", "VALUE"], billingEvents: ["IMPRESSIONS"] },
    },
    details: { batchSupported: true, batchSubresponsesRequired: true, regulatedSpecialCategoriesSupported: false, pageOwnershipRequired: true, budgetLevels: ["AD_SET_DAILY", "AD_SET_LIFETIME"], creativeFormats: ["IMAGE", "VIDEO"] },
  }),
  TIKTOK: Object.freeze({
    provider: "TIKTOK", versionPattern: /^v\d+(?:\.\d+)?$/, campaignTypes: ["MANUAL"],
    operationTypes: COMMON_OPERATIONS, resourceTypes: ["CAMPAIGN", "GROUP", "CREATIVE", "AD", "TARGETING"],
    objectives: ["TRAFFIC", "CONVERSIONS", "LEAD_GENERATION", "REACH", "VIDEO_VIEWS"], placements: ["TIKTOK"],
    budgetUnitSemantics: "ACCOUNT_CURRENCY_MAJOR_UNITS", nativeValidationAvailable: false, atomicity: "OPERATION", idempotency: "LIMITED",
    immutableFields: IMMUTABLE_FIELDS.TIKTOK, requiredScopes: ["Ad Management"], eligibleRoles: ["ADMIN", "OPERATOR"],
    biddingCompatibility: {
      TRAFFIC: { optimizationGoals: ["CLICK", "LANDING_PAGE_VIEW"], billingEvents: ["CPC", "OCPM"] },
      CONVERSIONS: { optimizationGoals: ["CONVERSION"], billingEvents: ["OCPM"] },
      LEAD_GENERATION: { optimizationGoals: ["LEAD_GENERATION"], billingEvents: ["OCPM"] },
      REACH: { optimizationGoals: ["REACH"], billingEvents: ["CPM"] },
      VIDEO_VIEWS: { optimizationGoals: ["VIDEO_VIEW"], billingEvents: ["CPV", "OCPM"] },
    },
    details: { manualCampaigns: true, smartPlus: false, sparkAdsRequireAuthorization: true, reachFrequency: false, reviewStateSupported: true, creativeFormats: ["VIDEO_REFERENCE"] },
  }),
  LINKEDIN: Object.freeze({
    provider: "LINKEDIN", versionPattern: /^\d{6}$/, campaignTypes: ["SPONSORED_CONTENT"],
    operationTypes: COMMON_OPERATIONS, resourceTypes: ["CAMPAIGN", "GROUP", "CREATIVE", "AD", "TARGETING"],
    objectives: ["BRAND_AWARENESS", "WEBSITE_VISITS", "ENGAGEMENT", "LEAD_GENERATION", "WEBSITE_CONVERSIONS"], placements: ["LINKEDIN_FEED"],
    budgetUnitSemantics: "CURRENCY_AMOUNT", nativeValidationAvailable: false, atomicity: "OPERATION", idempotency: "LIMITED",
    immutableFields: IMMUTABLE_FIELDS.LINKEDIN, requiredScopes: ["rw_ads"], eligibleRoles: ["CAMPAIGN_MANAGER", "ACCOUNT_MANAGER", "ACCOUNT_BILLING_ADMIN"],
    details: { restBase: "/rest/", restliProtocolVersion: "2.0.0", developmentTierLimited: true, discriminatoryTargetingSupported: false, supportedFormats: ["SINGLE_IMAGE", "VIDEO"], limitsAreProviderReported: true },
  }),
  X: Object.freeze({
    provider: "X", versionPattern: /^\d+$/, campaignTypes: ["PROMOTED_TWEETS"],
    operationTypes: COMMON_OPERATIONS, resourceTypes: ["BUDGET", "CAMPAIGN", "GROUP", "TARGETING", "ASSET_LINK"],
    objectives: ["AWARENESS", "WEBSITE_CLICKS", "ENGAGEMENTS", "VIDEO_VIEWS", "APP_INSTALLS"], placements: ["ALL_ON_TWITTER", "PUBLISHER_NETWORK"],
    budgetUnitSemantics: "LOCAL_MICRO_UNITS", nativeValidationAvailable: false, atomicity: "OPERATION", idempotency: "LIMITED",
    immutableFields: IMMUTABLE_FIELDS.X, requiredScopes: ["ADS_API_WRITE"], eligibleRoles: ["ACCOUNT_ADMIN", "AD_MANAGER"],
    details: { fundingInstrumentReadOnly: true, organicPublishingSupported: false, adsApiAccessRequired: true, providerLimitsRequired: true },
  }),
});

module.exports = { COMMON_OPERATIONS, PROVIDER_DEFINITIONS };
