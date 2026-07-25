const { z } = require("zod");
const { AD_PLATFORMS, PLATFORM_FILTERS } = require("./platforms");
const { uuidSchema, calendarDateSchema, isoTimestampSchema } = require("./validation-security");

// Query validation for the intelligence dashboard, following the existing
// marketing.validator.js zod conventions.

const MAX_RANGE_DAYS = 366;
const MAX_MANUAL_SYNC_DAYS = 31;
const FUNNEL_EVENT_TYPES = [
  "MARKETING_CLICK_RECORDED",
  "USER_SIGNUP_COMPLETED",
  "USER_BECAME_ACTIVE",
  "PAYMENT_SUCCESS",
  "PAYMENT_REFUNDED",
  "PAYMENT_CHARGEBACK",
];

const emptyToUndefined = (value) =>
  value === undefined || value === null || value === "" ? undefined : value;

const validDateString = calendarDateSchema;

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
      return spanMs / (24 * 60 * 60 * 1000) + 1 <= MAX_RANGE_DAYS;
    },
    { message: `Date range must not exceed ${MAX_RANGE_DAYS} days`, path: ["to"] },
  );

const nullableString = (max) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

const currencyCode = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .refine((value) => /^[A-Z]{3}$/.test(value), "currency must be an ISO 4217 code")
    .optional(),
);

const decimalAmount = z.preprocess(
  emptyToUndefined,
  z
    .union([z.number(), z.string().trim()])
    .refine((value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed !== 0;
    }, "amount must be a non-zero decimal")
    .optional(),
);

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
    currency: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .refine((value) => value === "UNSPECIFIED" || /^[A-Z]{3}$/.test(value), "currency must be an ISO 4217 code")
        .optional(),
    ),
  })
  .partial()
  .strict();

const connectionIdArray = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === "") return [];
    return Array.isArray(value) ? value : [value];
  },
  z.array(uuidSchema).max(50),
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
  isoTimestampSchema.optional(),
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
    connectionId: z.preprocess(emptyToUndefined, uuidSchema.optional()),
    accountExternalId: nullableString(255),
    accountId: nullableString(255),
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
    refundId: nullableString(255),
    chargebackId: nullableString(255),
    originalPaymentExternalEventId: nullableString(255),
    originalPaymentEventId: nullableString(255),
    userId: nullableString(255),
    anonId: nullableString(255),
    source: nullableString(100),
    platform: z.preprocess(emptyToUndefined, z.enum(AD_PLATFORMS).optional()),
    connectionId: z.preprocess(emptyToUndefined, uuidSchema.optional()),
    accountExternalId: nullableString(255),
    accountId: nullableString(255),
    campaignExternalId: nullableString(255),
    campaignName: nullableString(512),
    utmParams: utmParamsSchema.optional(),
    amount: decimalAmount,
    currency: currencyCode,
    monetaryStatus: nullableString(40),
    status: nullableString(40),
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
    currency: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .refine((value) => value === "UNSPECIFIED" || /^[A-Z]{3}$/.test(value), "currency must be an ISO 4217 code")
        .optional(),
    ),
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
  )
  .refine((data) => !data.since || !data.until || (new Date(data.until) - new Date(data.since)) / 86400000 + 1 <= MAX_MANUAL_SYNC_DAYS, { message: `Connection test range must not exceed ${MAX_MANUAL_SYNC_DAYS} days`, path: ["until"] });

const providerValidationEvidenceSchema = z
  .object({
    checkedAt: optionalDateTime,
    connectionTestPassed: z.literal(true).optional(),
    boundedFetchPassed: z.literal(true).optional(),
    metricReconciled: z.literal(true).optional(),
    paginationVerified: z.literal(true).optional(),
    rateLimitVerified: z.literal(true).optional(),
    tokenRefreshVerified: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (data) =>
      [
        data.connectionTestPassed,
        data.boundedFetchPassed,
        data.metricReconciled,
        data.paginationVerified,
        data.rateLimitVerified,
        data.tokenRefreshVerified,
      ].some(Boolean),
    "At least one validation check must be recorded",
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
    connectionId: z.preprocess(emptyToUndefined, uuidSchema.optional()),
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
      return spanMs / (24 * 60 * 60 * 1000) + 1 <= MAX_MANUAL_SYNC_DAYS;
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
  providerValidationEvidenceSchema,
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
