const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier } = require("../../shared/middlewares/rbac.middleware");
const ApiError = require("../../shared/utils/ApiError");
const marketingController = require("./marketing.controller");

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

const BANNER_MAX_FILE_SIZE = 30 * 1024 * 1024;
const BANNER_ALLOWED_EXTENSIONS = new Set([
  "doc",
  "docx",
  "gif",
  "jpeg",
  "jpg",
  "pdf",
  "png",
  "webp",
  "xls",
  "xlsx",
]);
const BANNER_ALLOWED_MIME_TYPES = new Set([
  "application/msword",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const bannerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BANNER_MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const extension = String(file.originalname || "")
      .split(".")
      .pop()
      .toLowerCase();
    const mimeType = String(file.mimetype || "").toLowerCase();
    const hasAllowedExtension = BANNER_ALLOWED_EXTENSIONS.has(extension);
    const hasAllowedMimeType = BANNER_ALLOWED_MIME_TYPES.has(mimeType);

    if (hasAllowedExtension && hasAllowedMimeType) {
      return cb(null, true);
    }

    return cb(new ApiError(400, "Unsupported banner file type"));
  },
});

function multerSingle(upload, fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (error) => {
      if (!error) return next();

      if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
          return next(new ApiError(400, "Banner file must not exceed 30MB"));
        }

        return next(new ApiError(400, error.message));
      }

      return next(error);
    });
  };
}

router.use(authenticate);
router.use(requireTier("ADMIN"));
router.use(limiter);

// Campaigns
router.get("/campaigns", marketingController.getCampaigns);
router.post("/campaigns", marketingController.createCampaign);
router.get("/campaigns/:id/performance", marketingController.getCampaignPerformance);
router.get("/campaigns/:id/timeline", marketingController.getCampaignTimeline);
router.get("/campaigns/:id/team", marketingController.getCampaignTeam);
router.post("/campaigns/:id/duplicate", marketingController.duplicateCampaign);
router.get("/campaigns/:id", marketingController.getCampaignById);
router.put("/campaigns/:id", marketingController.updateCampaign);
router.delete("/campaigns/:id", marketingController.deleteCampaign);
router.patch("/campaigns/:id/status", marketingController.updateCampaignStatus);

// Content Manager
router.get("/content", marketingController.getContentItems);
router.post("/content", marketingController.createContent);
router.get("/content/:id/performance", marketingController.getContentPerformance);
router.get("/content/:id/report", marketingController.getContentReport);
router.get("/content/:id", marketingController.getContentById);
router.put("/content/:id", marketingController.updateContent);
router.delete("/content/:id", marketingController.deleteContent);

// Email Templates
router.get("/email-templates/customers/search", marketingController.searchEmailTemplateCustomers);
router.get("/email-templates", marketingController.getEmailTemplates);
router.post("/email-templates", marketingController.createEmailTemplate);
router.patch("/email-templates/:id/notification", marketingController.updateEmailTemplateNotification);
router.patch("/email-templates/:id/recipients", marketingController.updateEmailTemplateRecipients);
router.put("/email-templates/:id/content", marketingController.updateEmailTemplateContent);
router.get("/email-templates/:id", marketingController.getEmailTemplateById);
router.put("/email-templates/:id", marketingController.updateEmailTemplate);
router.delete("/email-templates/:id", marketingController.deleteEmailTemplate);

// Social Media
router.get("/social/overview", marketingController.getSocialOverview);
router.get("/social/accounts", marketingController.getSocialAccounts);
router.post("/social/accounts", marketingController.createSocialAccount);
router.delete("/social/accounts/:id", marketingController.deleteSocialAccount);
router.get("/social/schedule", marketingController.getSocialSchedule);
router.post("/social/schedule", marketingController.createSocialSchedule);
router.get("/social/insights", marketingController.getSocialInsights);
router.get("/social/posts", marketingController.getSocialPosts);
router.post("/social/posts", marketingController.createSocialPost);
router.get("/social/posts/:id", marketingController.getSocialPostById);
router.put("/social/posts/:id", marketingController.updateSocialPost);
router.delete("/social/posts/:id", marketingController.deleteSocialPost);

// Promotions
router.get("/promotions", marketingController.getPromotions);
router.post("/promotions", marketingController.createPromotion);
router.put("/promotions/:id", marketingController.updatePromotion);
router.delete("/promotions/:id", marketingController.deletePromotion);

// Banners
router.get("/banners", marketingController.getBanners);
router.post("/banners", multerSingle(bannerUpload, "file"), marketingController.createBanner);
router.get("/banners/:id", marketingController.getBannerById);
router.put("/banners/:id", multerSingle(bannerUpload, "file"), marketingController.updateBanner);
router.patch("/banners/:id/status", marketingController.updateBannerStatus);
router.delete("/banners/:id", marketingController.deleteBanner);

// Analytics
router.get("/analytics/overview-stats", marketingController.getAnalyticsOverviewStats);
router.get("/analytics/social-stats", marketingController.getAnalyticsSocialStats);
router.get("/analytics/ads-performance", marketingController.getAnalyticsAdsPerformance);
router.get("/analytics/location", marketingController.getAnalyticsLocation);
router.get("/analytics/audience-breakdown", marketingController.getAnalyticsAudienceBreakdown);
router.get("/analytics/conversion-funnel", marketingController.getAnalyticsConversionFunnel);
router.get("/analytics/weekly-engagement", marketingController.getAnalyticsWeeklyEngagement);
router.get("/analytics/performance-data", marketingController.getAnalyticsPerformanceData);
router.get("/analytics/platform-integrations", marketingController.getAnalyticsPlatformIntegrations);

module.exports = router;