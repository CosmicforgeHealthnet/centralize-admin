const ApiError = require("../../shared/utils/ApiError");
const asyncHandler = require("../../shared/utils/asyncHandler");
const marketingService = require("./marketing.service");
const {
  campaignListQuerySchema,
  contentListQuerySchema,
  contentReportQuerySchema,
  createCampaignBodySchema,
  createContentBodySchema,
  updateCampaignBodySchema,
  updateCampaignStatusBodySchema,
  updateContentBodySchema,
  analyticsDateRangeQuerySchema,
  bannerCreateSchema,
  bannerListQuerySchema,
  bannerStatusSchema,
  bannerUpdateSchema,
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
  promotionCreateSchema,
  promotionListQuerySchema,
  promotionUpdateSchema,
} = require("./marketing.validator");

function validate(schema, data) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));

    throw new ApiError(400, "Validation failed", errors);
  }

  return result.data;
}

// =======================
// Campaigns
// =======================

const getCampaigns = asyncHandler(async (req, res) => {
  const query = validate(campaignListQuerySchema, req.query);
  const data = await marketingService.listCampaigns(query);

  return res.status(200).json(data);
});

const getCampaignById = asyncHandler(async (req, res) => {
  const data = await marketingService.getCampaign(req.params.id);

  return res.status(200).json(data);
});

const getCampaignPerformance = asyncHandler(async (req, res) => {
  const data = await marketingService.getCampaignPerformance(req.params.id);

  return res.status(200).json(data);
});

const getCampaignTimeline = asyncHandler(async (req, res) => {
  const data = await marketingService.getCampaignTimeline(req.params.id);

  return res.status(200).json(data);
});

const getCampaignTeam = asyncHandler(async (req, res) => {
  const data = await marketingService.getCampaignTeam(req.params.id);

  return res.status(200).json(data);
});

const createCampaign = asyncHandler(async (req, res) => {
  const body = validate(createCampaignBodySchema, req.body);
  const data = await marketingService.createCampaign(body);

  return res.status(201).json({
    message: "Campaign created successfully",
    data,
  });
});

const updateCampaign = asyncHandler(async (req, res) => {
  const body = validate(updateCampaignBodySchema, req.body);
  const data = await marketingService.updateCampaign(req.params.id, body);

  return res.status(200).json({
    message: "Campaign updated successfully",
    data,
  });
});

const deleteCampaign = asyncHandler(async (req, res) => {
  await marketingService.deleteCampaign(req.params.id);

  return res.status(200).json({
    message: "Campaign deleted successfully",
  });
});

const updateCampaignStatus = asyncHandler(async (req, res) => {
  const body = validate(updateCampaignStatusBodySchema, req.body);
  const data = await marketingService.updateCampaignStatus(req.params.id, body);

  return res.status(200).json({
    message: "Campaign status updated",
    data,
  });
});

const duplicateCampaign = asyncHandler(async (req, res) => {
  const data = await marketingService.duplicateCampaign(req.params.id);

  return res.status(201).json({
    message: "Campaign duplicated successfully",
    data,
  });
});

// =======================
// Content Manager
// =======================

const getContentItems = asyncHandler(async (req, res) => {
  const query = validate(contentListQuerySchema, req.query);
  const data = await marketingService.listContent(query);

  return res.status(200).json(data);
});

const getContentById = asyncHandler(async (req, res) => {
  const data = await marketingService.getContent(req.params.id);

  return res.status(200).json(data);
});

const getContentPerformance = asyncHandler(async (req, res) => {
  const data = await marketingService.getContentPerformance(req.params.id);

  return res.status(200).json(data);
});

const createContent = asyncHandler(async (req, res) => {
  const body = validate(createContentBodySchema, req.body);
  const data = await marketingService.createContent(body);

  return res.status(201).json({
    message: "Content created successfully",
    data,
  });
});

const updateContent = asyncHandler(async (req, res) => {
  const body = validate(updateContentBodySchema, req.body);
  const data = await marketingService.updateContent(req.params.id, body);

  return res.status(200).json({
    message: "Content updated successfully",
    data,
  });
});

const deleteContent = asyncHandler(async (req, res) => {
  await marketingService.deleteContent(req.params.id);

  return res.status(200).json({
    message: "Content deleted successfully",
  });
});

const getContentReport = asyncHandler(async (req, res) => {
  const query = validate(contentReportQuerySchema, req.query);
  const result = await marketingService.getContentReport(req.params.id, query);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${result.filename}"`,
  );

  return res.status(200).send(result.csv);
});

// =======================
// Email Templates
// =======================

const getEmailTemplates = asyncHandler(async (req, res) => {
  const query = validate(emailTemplateListQuerySchema, req.query);
  const data = await marketingService.listEmailTemplates(query);

  return res.status(200).json(data);
});

const getEmailTemplateById = asyncHandler(async (req, res) => {
  const data = await marketingService.getEmailTemplate(req.params.id);

  return res.status(200).json(data);
});

const createEmailTemplate = asyncHandler(async (req, res) => {
  const body = validate(emailTemplateCreateSchema, req.body);
  const data = await marketingService.createEmailTemplate(body);

  return res.status(201).json({
    message: "Event created successfully",
    data,
  });
});

const updateEmailTemplate = asyncHandler(async (req, res) => {
  const body = validate(emailTemplateUpdateSchema, req.body);
  const data = await marketingService.updateEmailTemplate(req.params.id, body);

  return res.status(200).json({
    message: "Template updated successfully",
    data,
  });
});

const deleteEmailTemplate = asyncHandler(async (req, res) => {
  await marketingService.deleteEmailTemplate(req.params.id);

  return res.status(200).json({
    message: "Event deleted successfully",
  });
});

const updateEmailTemplateNotification = asyncHandler(async (req, res) => {
  const body = validate(emailTemplateNotificationSchema, req.body);
  const data = await marketingService.updateEmailTemplateNotification(
    req.params.id,
    body,
  );

  return res.status(200).json({
    message: "Notification setting updated",
    data,
  });
});

const updateEmailTemplateRecipients = asyncHandler(async (req, res) => {
  const body = validate(emailTemplateRecipientsSchema, req.body);
  await marketingService.updateEmailTemplateRecipients(req.params.id, body);

  return res.status(200).json({
    message: "Recipients updated successfully",
  });
});

const updateEmailTemplateContent = asyncHandler(async (req, res) => {
  const body = validate(emailTemplateContentSchema, req.body);
  await marketingService.updateEmailTemplateContent(req.params.id, body);

  return res.status(200).json({
    message: "Template content saved successfully",
  });
});

const searchEmailTemplateCustomers = asyncHandler(async (req, res) => {
  const query = validate(emailTemplateCustomerSearchSchema, req.query);
  const data = await marketingService.searchEmailTemplateCustomers(query);

  return res.status(200).json(data);
});

// =======================
// Social Media
// =======================

const getSocialOverview = asyncHandler(async (req, res) => {
  const data = await marketingService.getSocialOverview();

  return res.status(200).json(data);
});

const getSocialAccounts = asyncHandler(async (req, res) => {
  const data = await marketingService.listSocialAccounts();

  return res.status(200).json(data);
});

const createSocialAccount = asyncHandler(async (req, res) => {
  const body = validate(socialAccountCreateSchema, req.body);
  const data = await marketingService.createSocialAccount(body);

  return res.status(201).json({
    message: "Account linked successfully",
    data,
  });
});

const deleteSocialAccount = asyncHandler(async (req, res) => {
  await marketingService.deleteSocialAccount(req.params.id);

  return res.status(200).json({
    message: "Account unlinked successfully",
  });
});

const getSocialPosts = asyncHandler(async (req, res) => {
  const query = validate(socialPostsListQuerySchema, req.query);
  const data = await marketingService.listSocialPosts(query);

  return res.status(200).json(data);
});

const createSocialPost = asyncHandler(async (req, res) => {
  const body = validate(socialPostCreateSchema, req.body);
  const data = await marketingService.createSocialPost(body);

  return res.status(201).json({
    message: "Post sent successfully",
    data,
  });
});

const getSocialPostById = asyncHandler(async (req, res) => {
  const data = await marketingService.getSocialPost(req.params.id);

  return res.status(200).json(data);
});

const updateSocialPost = asyncHandler(async (req, res) => {
  const body = validate(socialPostUpdateSchema, req.body);
  await marketingService.updateSocialPost(req.params.id, body);

  return res.status(200).json({
    message: "Post updated successfully",
  });
});

const deleteSocialPost = asyncHandler(async (req, res) => {
  await marketingService.deleteSocialPost(req.params.id);

  return res.status(200).json({
    message: "Post deleted successfully",
  });
});

const getSocialSchedule = asyncHandler(async (req, res) => {
  const query = validate(socialScheduleQuerySchema, req.query);
  const data = await marketingService.getSocialSchedule(query);

  return res.status(200).json(data);
});

const createSocialSchedule = asyncHandler(async (req, res) => {
  const body = validate(socialScheduleCreateSchema, req.body);
  const data = await marketingService.createSocialSchedule(body);

  return res.status(201).json({
    message: "Post scheduled successfully",
    data,
  });
});

const getSocialInsights = asyncHandler(async (req, res) => {
  const query = validate(socialInsightsQuerySchema, req.query);
  const data = await marketingService.getSocialInsights(query);

  return res.status(200).json(data);
});

// =======================
// Banners & Promotion
// =======================

const getPromotions = asyncHandler(async (req, res) => {
  const query = validate(promotionListQuerySchema, req.query);
  const data = await marketingService.listPromotions(query);

  return res.status(200).json(data);
});

const createPromotion = asyncHandler(async (req, res) => {
  const body = validate(promotionCreateSchema, req.body);
  const data = await marketingService.createPromotion(body);

  return res.status(201).json({
    message: "Promotion created successfully",
    data,
  });
});

const updatePromotion = asyncHandler(async (req, res) => {
  const body = validate(promotionUpdateSchema, req.body);
  const data = await marketingService.updatePromotion(req.params.id, body);

  return res.status(200).json({
    message: "Promotion updated successfully",
    data,
  });
});

const deletePromotion = asyncHandler(async (req, res) => {
  await marketingService.deletePromotion(req.params.id);

  return res.status(200).json({
    message: "Promotion deleted successfully",
  });
});

const getBanners = asyncHandler(async (req, res) => {
  const query = validate(bannerListQuerySchema, req.query);
  const data = await marketingService.listBanners(query);

  return res.status(200).json(data);
});

const getBannerById = asyncHandler(async (req, res) => {
  const data = await marketingService.getBanner(req.params.id);

  return res.status(200).json(data);
});

const createBanner = asyncHandler(async (req, res) => {
  const body = validate(bannerCreateSchema, req.body);
  const data = await marketingService.createBanner(body, req.file);

  return res.status(201).json({
    message: "Banner created successfully",
    data,
  });
});

const updateBanner = asyncHandler(async (req, res) => {
  const body = validate(bannerUpdateSchema, req.body);
  const data = await marketingService.updateBanner(req.params.id, body, req.file);

  return res.status(200).json({
    message: "Banner updated successfully",
    data,
  });
});

const deleteBanner = asyncHandler(async (req, res) => {
  await marketingService.deleteBanner(req.params.id);

  return res.status(200).json({
    message: "Banner deleted successfully",
  });
});

const updateBannerStatus = asyncHandler(async (req, res) => {
  const body = validate(bannerStatusSchema, req.body);
  const data = await marketingService.updateBannerStatus(req.params.id, body);

  return res.status(200).json({
    message: "Banner status updated",
    data,
  });
});

// =======================
// Analytics
// =======================

function validateAnalyticsQuery(query) {
  return validate(analyticsDateRangeQuerySchema, query);
}

const getAnalyticsOverviewStats = asyncHandler(async (req, res) => {
  validateAnalyticsQuery(req.query);
  const data = await marketingService.getAnalyticsOverviewStats();

  return res.status(200).json(data);
});

const getAnalyticsSocialStats = asyncHandler(async (req, res) => {
  validateAnalyticsQuery(req.query);
  const data = await marketingService.getAnalyticsSocialStats();

  return res.status(200).json(data);
});

const getAnalyticsAdsPerformance = asyncHandler(async (req, res) => {
  validateAnalyticsQuery(req.query);
  const data = await marketingService.getAnalyticsAdsPerformance();

  return res.status(200).json(data);
});

const getAnalyticsLocation = asyncHandler(async (req, res) => {
  validateAnalyticsQuery(req.query);
  const data = await marketingService.getAnalyticsLocation();

  return res.status(200).json(data);
});

const getAnalyticsAudienceBreakdown = asyncHandler(async (req, res) => {
  validateAnalyticsQuery(req.query);
  const data = await marketingService.getAnalyticsAudienceBreakdown();

  return res.status(200).json(data);
});

const getAnalyticsConversionFunnel = asyncHandler(async (req, res) => {
  validateAnalyticsQuery(req.query);
  const data = await marketingService.getAnalyticsConversionFunnel();

  return res.status(200).json(data);
});

const getAnalyticsWeeklyEngagement = asyncHandler(async (req, res) => {
  validateAnalyticsQuery(req.query);
  const data = await marketingService.getAnalyticsWeeklyEngagement();

  return res.status(200).json(data);
});

const getAnalyticsPerformanceData = asyncHandler(async (req, res) => {
  validateAnalyticsQuery(req.query);
  const data = await marketingService.getAnalyticsPerformanceData();

  return res.status(200).json(data);
});

const getAnalyticsPlatformIntegrations = asyncHandler(async (req, res) => {
  validateAnalyticsQuery(req.query);
  const data = await marketingService.getAnalyticsPlatformIntegrations();

  return res.status(200).json(data);
});
module.exports = {
  createBanner,
  createCampaign,
  createContent,
  createPromotion,
  deleteCampaign,
  deleteBanner,
  deleteContent,
  deletePromotion,
  duplicateCampaign,
  getAnalyticsAdsPerformance,
  getAnalyticsAudienceBreakdown,
  getAnalyticsConversionFunnel,
  getAnalyticsLocation,
  getAnalyticsOverviewStats,
  getAnalyticsPerformanceData,
  getAnalyticsPlatformIntegrations,
  getAnalyticsSocialStats,
  getAnalyticsWeeklyEngagement,
  getBannerById,
  getBanners,
  getCampaignById,
  getCampaignPerformance,
  getCampaignTeam,
  getCampaignTimeline,
  getCampaigns,
  getContentById,
  getContentItems,
  getContentPerformance,
  getContentReport,
  updateCampaign,
  updateCampaignStatus,
  updateContent,
  updateSocialPost,
  updateEmailTemplateRecipients,
  updateEmailTemplateNotification,
  updateEmailTemplateContent,
  updateEmailTemplate,
  searchEmailTemplateCustomers,
  getSocialSchedule,
  getSocialPosts,
  getSocialPostById,
  getSocialOverview,
  getSocialInsights,
  getSocialAccounts,
  getEmailTemplates,
  getEmailTemplateById,
  getPromotions,
  deleteSocialPost,
  deleteSocialAccount,
  deleteEmailTemplate,
  createSocialSchedule,
  createSocialPost,
  createSocialAccount,
  createEmailTemplate,
  updateBanner,
  updateBannerStatus,
  updatePromotion,
};