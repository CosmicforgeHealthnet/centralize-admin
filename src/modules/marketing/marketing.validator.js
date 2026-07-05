const { z } = require("zod");

const CAMPAIGN_TYPES = ["Email", "Social", "Events", "Ads"];
const CAMPAIGN_STATUSES = ["Active", "Drafts", "Completed", "Paused", "Archived"];
const CAMPAIGN_LIST_STATUSES = ["Active", "Drafts", "Completed", "Paused"];
const CONTENT_STATUSES = ["Published", "Draft"];
const SOCIAL_PLATFORMS = [
  "Facebook",
  "Instagram",
  "Youtube",
  "Twitter",
  "Tiktok",
  "LinkedIn",
];
const SOCIAL_POST_STATUSES = ["Published", "Scheduled", "Draft", "Deleted"];
const SOCIAL_POST_LIST_PLATFORMS = ["All", ...SOCIAL_PLATFORMS];
const EMAIL_RECIPIENTS = ["Customer", "Recipients", "Admin"];
const PROMOTION_TABS = [
  "All",
  "Active Promotions",
  "Upcoming Promotions",
  "Ended Promotions",
];
const PROMOTION_STATUSES = ["Upcoming", "Active", "Completed", "Ended"];
const BANNER_STATUSES = ["Active", "Inactive", "Expired"];

const emptyToUndefined = (value) =>
  value === undefined || value === null || value === "" ? undefined : value;

const positiveIntegerQuery = (defaultValue) =>
  z.preprocess(
    (value) => (value === undefined || value === null || value === "" ? defaultValue : value),
    z.coerce.number().int().min(1),
  );

const optionalSearch = z.preprocess(
  emptyToUndefined,
  z.string().trim().min(1).optional(),
);

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

const optionalUrl = z.preprocess(
  emptyToUndefined,
  z.string().trim().url().optional(),
);

const isoDateOrDateTime = z.union([validDateString, z.string().trim().datetime({ offset: true })]);

const optionalIsoDate = z.preprocess(
  emptyToUndefined,
  isoDateOrDateTime.optional(),
);

const validIsoDateTime = z
  .string()
  .trim()
  .datetime({ offset: true });

const futureIsoDateTime = validIsoDateTime.refine(
  (value) => new Date(value).getTime() > Date.now(),
  "Use a future date and time",
);

const channelsSchema = z.array(z.string().trim().min(1)).max(25);
const stringOrStringArraySchema = z.union([
  z.string().trim().min(1),
  z.array(z.string().trim().min(1)).min(1),
]);

const numericMetric = z.coerce.number().nonnegative().optional();

function validateDateRange(data) {
  if (!data.startDate || !data.endDate) return true;
  return new Date(data.endDate) >= new Date(data.startDate);
}

function validateValidDateRange(data) {
  if (!data.validFrom || !data.validTo) return true;
  return new Date(data.validTo) >= new Date(data.validFrom);
}

const atLeastOneField = (schema) =>
  schema.refine((data) => Object.keys(data).length > 0, {
    message: "At least one valid field must be provided",
  });

const campaignListQuerySchema = z
  .object({
    page: positiveIntegerQuery(1),
    limit: positiveIntegerQuery(9),
    status: z.enum(CAMPAIGN_LIST_STATUSES).optional(),
    type: z.enum(CAMPAIGN_TYPES).optional(),
    search: optionalSearch,
  })
  .strict();

const createCampaignBodySchema = z
  .object({
    title: z.string().trim().min(1),
    type: z.enum(CAMPAIGN_TYPES),
    description: z.string().trim().optional(),
    launchDate: validDateString,
  })
  .strict();

const updateCampaignBodySchema = atLeastOneField(
  z
    .object({
      title: z.string().trim().min(1).optional(),
      type: z.enum(CAMPAIGN_TYPES).optional(),
      description: z.string().trim().optional(),
      budget: z.coerce.number().nonnegative().optional(),
      launchDate: validDateString.optional(),
      estCompletion: validDateString.optional(),
      targetAudience: z.string().trim().min(1).optional(),
      duration: z.string().trim().min(1).optional(),
      channels: channelsSchema.optional(),
      overview: z.string().trim().min(1).optional(),
    })
    .strict(),
);

const updateCampaignStatusBodySchema = z
  .object({
    status: z.enum(CAMPAIGN_STATUSES),
  })
  .strict();

const contentListQuerySchema = z
  .object({
    page: positiveIntegerQuery(1),
    limit: positiveIntegerQuery(15),
    status: z.enum(CONTENT_STATUSES).optional(),
    search: optionalSearch,
  })
  .strict();

const createContentBodySchema = z
  .object({
    title: z.string().trim().min(1),
    type: z.string().trim().min(1),
    authorId: z.string().trim().uuid(),
    link: optionalUrl,
    description: z.string().trim().optional(),
  })
  .strict();

const updateContentBodySchema = atLeastOneField(
  z
    .object({
      title: z.string().trim().min(1).optional(),
      type: z.string().trim().min(1).optional(),
      authorId: z.string().trim().uuid().optional(),
      link: optionalUrl,
      description: z.string().trim().optional(),
      status: z.enum(CONTENT_STATUSES).optional(),
      performance: z.coerce.number().int().nonnegative().optional(),
    })
    .strict(),
);

const contentReportQuerySchema = z
  .object({
    format: z.preprocess(
      (value) => String(emptyToUndefined(value) || "csv").toLowerCase(),
      z.enum(["csv", "pdf"]),
    ),
  })
  .strict();

const emailTemplateListQuerySchema = z
  .object({
    page: positiveIntegerQuery(1),
    limit: positiveIntegerQuery(15),
    search: optionalSearch,
  })
  .strict();

const emailTemplateCreateSchema = z
  .object({
    event: z.string().trim().min(1),
    validFrom: validDateString,
    validTo: validDateString,
    language: z.string().trim().min(1).max(20),
  })
  .strict()
  .refine(validateValidDateRange, { message: "validTo must not be before validFrom" });

const emailTemplateUpdateSchema = atLeastOneField(
  z
    .object({
      validFrom: validDateString.optional(),
      validTo: validDateString.optional(),
      language: z.string().trim().min(1).max(20).optional(),
    })
    .strict(),
).refine(validateValidDateRange, { message: "validTo must not be before validFrom" });

const emailTemplateNotificationSchema = z
  .object({
    notifyEnabled: z.boolean(),
  })
  .strict();

const emailTemplateRecipientsSchema = z
  .object({
    channels: z
      .object({
        email: z.boolean(),
        whatsapp: z.boolean(),
        sms: z.boolean(),
      })
      .strict(),
    recipients: z.array(z.enum(EMAIL_RECIPIENTS)),
  })
  .strict();

const messageContentBlockSchema = z
  .object({
    greeting: z.string().trim().optional(),
    vars: z.array(z.string().trim().min(1)).default([]),
    body: z.string().trim().optional(),
    trackingVar: z.string().trim().optional(),
  })
  .strict();

const conditionalBlockSchema = z
  .object({
    condition: z.string().trim().optional(),
    message: z.string().trim().optional(),
  })
  .strict();

const emailTemplateContentSchema = atLeastOneField(
  z
    .object({
      emailContent: messageContentBlockSchema.optional(),
      conditionalBlock: conditionalBlockSchema.optional(),
      whatsappContent: messageContentBlockSchema.optional(),
    })
    .strict(),
);

const emailTemplateCustomerSearchSchema = z
  .object({
    query: z.string().trim().min(2),
  })
  .strict();

const socialAccountCreateSchema = z
  .object({
    platform: z.enum(SOCIAL_PLATFORMS),
    username: z.string().trim().min(1),
    password: z.string().min(1),
    saveCredentials: z.boolean().default(false),
  })
  .strict();

const socialPostsListQuerySchema = z
  .object({
    platform: z.enum(SOCIAL_POST_LIST_PLATFORMS).default("All"),
    page: positiveIntegerQuery(1),
    limit: positiveIntegerQuery(15),
  })
  .strict();

const socialPostCreateSchema = z
  .object({
    platform: z.enum(SOCIAL_PLATFORMS),
    caption: z.string().trim().min(1),
    attachmentUrl: optionalUrl,
  })
  .strict();

const socialPostUpdateSchema = atLeastOneField(
  z
    .object({
      caption: z.string().trim().min(1).optional(),
      attachmentUrl: optionalUrl,
      attachmentUrls: z.array(z.string().trim().url()).max(20).optional(),
    })
    .strict(),
);

const socialScheduleQuerySchema = z
  .object({
    month: z.preprocess(
      emptyToUndefined,
      z.string().trim().regex(/^\d{4}-\d{2}$/).optional(),
    ),
    weekStart: z.preprocess(emptyToUndefined, validDateString.optional()),
  })
  .strict();

const socialScheduleCreateSchema = z
  .object({
    platform: z.enum(SOCIAL_PLATFORMS),
    caption: z.string().trim().min(1),
    attachmentUrls: z.array(z.string().trim().url()).max(20).default([]),
    scheduledFor: futureIsoDateTime,
  })
  .strict();

const socialInsightsQuerySchema = z
  .object({
    from: optionalIsoDate,
    to: optionalIsoDate,
  })
  .strict()
  .refine(
    (data) => !data.from || !data.to || new Date(data.from) <= new Date(data.to),
    { message: "from must be before to" },
  );

const promotionListQuerySchema = z
  .object({
    page: positiveIntegerQuery(1),
    limit: positiveIntegerQuery(15),
    tab: z.enum(PROMOTION_TABS).default("All"),
    search: optionalSearch,
  })
  .strict();

const promotionCreateSchema = z
  .object({
    title: z.string().trim().min(1),
    discountType: z.string().trim().min(1),
    startDate: validDateString,
    endDate: validDateString,
  })
  .strict()
  .refine(validateDateRange, { message: "endDate must not be before startDate" });

const promotionUpdateSchema = atLeastOneField(
  z
    .object({
      title: z.string().trim().min(1).optional(),
      discountType: z.string().trim().min(1).optional(),
      startDate: validDateString.optional(),
      endDate: validDateString.optional(),
      grossSales: numericMetric,
      averageRate: numericMetric,
      grossRevenue: numericMetric,
      status: z.enum(PROMOTION_STATUSES).optional(),
    })
    .strict(),
).refine(validateDateRange, { message: "endDate must not be before startDate" });

const bannerListQuerySchema = z
  .object({
    page: positiveIntegerQuery(1),
    limit: positiveIntegerQuery(15),
    search: optionalSearch,
  })
  .strict();

const bannerCreateSchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    display: stringOrStringArraySchema,
    placement: stringOrStringArraySchema,
    externalLink: z.string().trim().url(),
    startDate: validDateString,
    endDate: validDateString,
  })
  .strict()
  .refine(validateDateRange, { message: "endDate must not be before startDate" });

const bannerUpdateSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    display: stringOrStringArraySchema.optional(),
    placement: stringOrStringArraySchema.optional(),
    externalLink: optionalUrl,
    startDate: validDateString.optional(),
    endDate: validDateString.optional(),
    totalImpressions: numericMetric,
    impressionsChange: numericMetric,
    clicks: numericMetric,
    clicksChange: numericMetric,
    signup: numericMetric,
    signupChange: numericMetric,
  })
  .strict()
  .refine(validateDateRange, { message: "endDate must not be before startDate" });

const bannerStatusSchema = z
  .object({
    status: z.enum(BANNER_STATUSES),
  })
  .strict();

const analyticsDateRangeQuerySchema = z
  .object({
    from: optionalIsoDate,
    to: optionalIsoDate,
  })
  .strict()
  .refine(
    (data) => !data.from || !data.to || new Date(data.from) <= new Date(data.to),
    { message: "from must be before to" },
  );

module.exports = {
  CAMPAIGN_LIST_STATUSES,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES,
  CONTENT_STATUSES,
  EMAIL_RECIPIENTS,
  BANNER_STATUSES,
  PROMOTION_STATUSES,
  PROMOTION_TABS,
  SOCIAL_PLATFORMS,
  SOCIAL_POST_LIST_PLATFORMS,
  SOCIAL_POST_STATUSES,
  campaignListQuerySchema,
  contentListQuerySchema,
  contentReportQuerySchema,
  createCampaignBodySchema,
  createContentBodySchema,
  updateCampaignBodySchema,
  updateCampaignStatusBodySchema,
  updateContentBodySchema,
  emailTemplateContentSchema,
  emailTemplateCreateSchema,
  emailTemplateCustomerSearchSchema,
  emailTemplateListQuerySchema,
  emailTemplateNotificationSchema,
  emailTemplateRecipientsSchema,
  emailTemplateUpdateSchema,
  socialAccountCreateSchema,
  socialInsightsQuerySchema,
  socialPostCreateSchema,
  socialPostUpdateSchema,
  socialPostsListQuerySchema,
  socialScheduleCreateSchema,
  socialScheduleQuerySchema,
  analyticsDateRangeQuerySchema,
  bannerCreateSchema,
  bannerListQuerySchema,
  bannerStatusSchema,
  bannerUpdateSchema,
  promotionCreateSchema,
  promotionListQuerySchema,
  promotionUpdateSchema,
};