const { z } = require("zod");
const { AD_PLATFORMS, PLATFORM_FILTERS } = require("./platforms");

// Query validation for the intelligence dashboard, following the existing
// marketing.validator.js zod conventions.

const MAX_RANGE_DAYS = 366;
const MAX_MANUAL_SYNC_DAYS = 31;
const FUNNEL_EVENT_TYPES = [
  "MARKETING_CLICK_RECORDED",
  "USER_SIGNUP_COMPLETED",
  "USER_BECAME_ACTIVE",
  "PAYMENT_SUCCESS",
];

const emptyToUndefined = (value) =>
  value === undefined || value === null || value === "" ? undefined : value;

const validDateString = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));

    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, "Use a valid calendar date");

const optionalDate = z.preprocess(emptyToUndefined, validDateString.optional());

const platformFilter = z.preprocess(
  (value) =>
    value === undefined || value === null || value === ""
      ? "all"
      : String(value).toLowerCase(),
  z.enum(PLATFORM_FILTERS),
);

const performanceQuerySchema = z
  .object({
    from: optionalDate,
    to: optionalDate,
    platform: platformFilter,
  })
  .strict()
  .refine(
    (data) => {
      if (!data.from || !data.to) return true;
      return new Date(data.to) >= new Date(data.from);
    },
    { message: "from must not be later than to", path: ["from"] },
  )
  .refine(
    (data) => {
      if (!data.from || !data.to) return true;
      const spanMs = new Date(data.to).getTime() - new Date(data.from).getTime();
      return spanMs <= MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;
    },
    { message: `Date range must not exceed ${MAX_RANGE_DAYS} days`, path: ["to"] },
  );

const nullableString = (max) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

const credentialValue = nullableString(8192);
const credentialsSchema = z
  .object({
    accessToken: credentialValue,
    refreshToken: credentialValue,
    accessTokenSecret: credentialValue,
    consumerKey: credentialValue,
    consumerSecret: credentialValue,
    clientId: credentialValue,
    clientSecret: credentialValue,
    developerToken: credentialValue,
  })
  .partial()
  .strict();

const connectionMetadataSchema = z
  .object({
    accountId: nullableString(255),
    advertiserId: nullableString(255),
    customerId: nullableString(255),
    loginCustomerId: nullableString(255),
    apiVersion: nullableString(40),
    graphApiVersion: nullableString(40),
    businessAccountId: nullableString(255),
    managerAccountId: nullableString(255),
    currency: nullableString(10),
  })
  .partial()
  .strict();

const connectionIdArray = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === "") return [];
    return Array.isArray(value) ? value : [value];
  },
  z.array(z.string().trim().min(1).max(255)).max(50),
);

const platformArray = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === "") return [];
    return Array.isArray(value) ? value : [value];
  },
  z.array(z.enum(AD_PLATFORMS)).max(AD_PLATFORMS.length),
);

const optionalDateTime = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .max(40)
    .refine((value) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value), "Use ISO-8601 datetime with timezone")
    .refine((value) => !Number.isNaN(new Date(value).getTime()), "Use a valid datetime")
    .optional(),
);

const utmParamsSchema = z
  .object({
    utm_source: nullableString(255),
    utm_medium: nullableString(255),
    utm_campaign: nullableString(255),
    utm_content: nullableString(255),
    utm_term: nullableString(255),
    source: nullableString(255),
    medium: nullableString(255),
    campaign: nullableString(255),
    content: nullableString(255),
    term: nullableString(255),
  })
  .partial()
  .strict();

const attributionPayloadSchema = z
  .object({
    eventId: nullableString(255),
    anonId: z.string().trim().min(1).max(255),
    userId: nullableString(255),
    source: nullableString(100),
    platform: z.preprocess(emptyToUndefined, z.enum(AD_PLATFORMS).optional()),
    campaignExternalId: nullableString(255),
    campaignName: nullableString(512),
    campaign_id: nullableString(255),
    campaign_name: nullableString(512),
    utmParams: utmParamsSchema.optional(),
    utm: utmParamsSchema.optional(),
    utm_source: nullableString(255),
    utm_medium: nullableString(255),
    utm_campaign: nullableString(255),
    utm_content: nullableString(255),
    utm_term: nullableString(255),
    capturedAt: optionalDateTime,
    occurredAt: optionalDateTime,
    timestamp: optionalDateTime,
  })
  .strict();

const funnelEventPayloadSchema = z
  .object({
    eventId: nullableString(255),
    transactionId: nullableString(255),
    userId: nullableString(255),
    anonId: nullableString(255),
    source: nullableString(100),
    platform: z.preprocess(emptyToUndefined, z.enum(AD_PLATFORMS).optional()),
    campaignExternalId: nullableString(255),
    campaignName: nullableString(512),
    utmParams: utmParamsSchema.optional(),
    amount: z.preprocess(emptyToUndefined, z.union([z.number(), z.string()]).optional()),
    currency: nullableString(10),
    serviceType: nullableString(100),
    serviceId: nullableString(255),
    activationType: nullableString(100),
    occurredAt: optionalDateTime,
  })
  .strict();

const funnelEventEnvelopeSchema = z
  .object({
    eventId: z.string().trim().min(1).max(255),
    eventType: z.enum(FUNNEL_EVENT_TYPES),
    occurredAt: optionalDateTime,
    payload: funnelEventPayloadSchema.default({}),
  })
  .strict();

const connectionUpsertSchema = z
  .object({
    platform: z.enum(AD_PLATFORMS),
    accountId: nullableString(255),
    advertiserId: nullableString(255),
    adsAccountId: nullableString(255),
    adAccountUrn: nullableString(255),
    customerId: nullableString(255),
    loginCustomerId: nullableString(255),
    accessToken: nullableString(8192),
    refreshToken: nullableString(8192),
    accessTokenSecret: nullableString(8192),
    consumerKey: nullableString(8192),
    consumerSecret: nullableString(8192),
    clientId: nullableString(8192),
    clientSecret: nullableString(8192),
    developerToken: nullableString(8192),
    appId: nullableString(8192),
    appSecret: nullableString(8192),
    graphApiVersion: nullableString(40),
    apiVersion: nullableString(40),
    credentials: credentialsSchema.optional(),
    connectionMetadata: connectionMetadataSchema.optional(),
    currency: nullableString(10),
    accessTokenExpiresAt: optionalDateTime,
    refreshTokenExpiresAt: optionalDateTime,
  })
  .strict();

const connectionBootstrapSchema = z
  .object({
    platform: z.preprocess(emptyToUndefined, z.enum(AD_PLATFORMS).optional()),
  })
  .strict();

const connectionTestQuerySchema = z
  .object({
    since: optionalDate,
    until: optionalDate,
  })
  .strict()
  .refine(
    (data) => {
      if (!data.since || !data.until) return true;
      return new Date(data.until) >= new Date(data.since);
    },
    { message: "since must not be later than until", path: ["since"] },
  );

const connectionListQuerySchema = z
  .object({
    platform: z.preprocess(emptyToUndefined, z.enum(AD_PLATFORMS).optional()),
  })
  .strict();

const oauthStartQuerySchema = z
  .object({
    accountId: nullableString(255),
    advertiserId: nullableString(255),
    adsAccountId: nullableString(255),
    adAccountUrn: nullableString(255),
    customerId: nullableString(255),
    loginCustomerId: nullableString(255),
    connectionId: nullableString(255),
    currency: nullableString(10),
  })
  .strict();

const oauthCallbackQuerySchema = z
  .object({
    state: z.string().trim().min(16).max(512),
    code: nullableString(4096),
    oauth_token: nullableString(4096),
    oauth_verifier: nullableString(4096),
    error: nullableString(512),
    error_description: nullableString(1024),
  })
  .passthrough();

const manualSyncSchema = z
  .object({
    platforms: platformArray.optional(),
    connectionIds: connectionIdArray.optional(),
    since: validDateString,
    until: validDateString,
  })
  .strict()
  .refine((data) => new Date(data.until) >= new Date(data.since), {
    message: "since must not be later than until",
    path: ["since"],
  })
  .refine(
    (data) => {
      const spanMs = new Date(data.until).getTime() - new Date(data.since).getTime();
      return spanMs <= MAX_MANUAL_SYNC_DAYS * 24 * 60 * 60 * 1000;
    },
    {
      message: `Manual sync date range must not exceed ${MAX_MANUAL_SYNC_DAYS} days`,
      path: ["until"],
    },
  );

module.exports = {
  performanceQuerySchema,
  attributionPayloadSchema,
  funnelEventEnvelopeSchema,
  connectionUpsertSchema,
  connectionBootstrapSchema,
  connectionTestQuerySchema,
  connectionListQuerySchema,
  oauthStartQuerySchema,
  oauthCallbackQuerySchema,
  manualSyncSchema,
  PLATFORM_FILTERS,
  AD_PLATFORMS,
  FUNNEL_EVENT_TYPES,
  MAX_RANGE_DAYS,
  MAX_MANUAL_SYNC_DAYS,
};
