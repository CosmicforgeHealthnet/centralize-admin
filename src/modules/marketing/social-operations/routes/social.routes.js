const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../../../shared/middlewares/auth.middleware");
const { requireTier } = require("../../../../shared/middlewares/rbac.middleware");
const ApiError = require("../../../../shared/utils/ApiError");
const socialController = require("../controllers/social.controller");
const {
  createRequireSocialOperation,
} = require("../governance/social-operations.rbac");
const validator = require("../validators/social.validator");

const router = express.Router();
const requireSocialOperation = createRequireSocialOperation();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

function multerSingle(fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (error) => {
      if (!error) return next();
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        return next(new ApiError(400, "Social media asset must not exceed 30MB"));
      }
      return next(error);
    });
  };
}

const SECTION8_PUBLIC_ROUTES = Object.freeze([
  {
    method: "get",
    path: "/oauth/:provider/callback",
    validators: [validator.validateProviderParam],
    handler: "oauthCallback",
    public: true,
    verification: "state",
  },
  {
    method: "get",
    path: "/webhooks/:provider",
    validators: [validator.validateProviderParam],
    handler: "webhookChallenge",
    public: true,
    verification: "provider-challenge",
  },
  {
    method: "post",
    path: "/webhooks/:provider",
    validators: [validator.validateProviderParam],
    handler: "webhookIngest",
    public: true,
    verification: "signature",
  },
]);

const SECTION8_AUTH_ROUTES = Object.freeze([
  { method: "get", path: "/connections", action: "CONNECTION_VIEW", handler: "listConnections" },
  {
    method: "post",
    path: "/connections/:provider/oauth/start",
    action: "CONNECTION_EDIT",
    validators: [validator.validateProviderParam],
    handler: "startOAuth",
  },
  {
    method: "post",
    path: "/connections/:id/test",
    action: "CONNECTION_VIEW",
    validators: [validator.validateUuidParam("id", "connection id")],
    handler: "testConnection",
  },
  {
    method: "post",
    path: "/connections/:id/reauthorize",
    action: "CONNECTION_EDIT",
    validators: [validator.validateUuidParam("id", "connection id")],
    handler: "reauthorizeConnection",
  },
  {
    method: "post",
    path: "/connections/:id/disable",
    action: "CONNECTION_EDIT",
    validators: [validator.validateUuidParam("id", "connection id")],
    handler: "disableConnection",
  },
  {
    method: "post",
    path: "/connections/:id/enable",
    action: "CONNECTION_EDIT",
    validators: [validator.validateUuidParam("id", "connection id")],
    handler: "enableConnection",
  },
  {
    method: "post",
    path: "/connections/:id/discover-identities",
    action: "CONNECTION_EDIT",
    validators: [validator.validateUuidParam("id", "connection id")],
    handler: "discoverIdentities",
  },

  { method: "get", path: "/identities", action: "CONNECTION_VIEW", handler: "listIdentities" },
  {
    method: "post",
    path: "/identities/:id/refresh-capabilities",
    action: "CONNECTION_EDIT",
    validators: [validator.validateUuidParam("id", "identity id")],
    handler: "refreshIdentityCapabilities",
  },
  {
    method: "post",
    path: "/identities/:id/sync-content",
    action: "CONNECTION_EDIT",
    validators: [validator.validateUuidParam("id", "identity id")],
    handler: "syncContent",
  },

  {
    method: "post",
    path: "/posts",
    action: "CONTENT_CREATE",
    validators: [validator.validatePostCreate],
    handler: "createPost",
  },
  {
    method: "get",
    path: "/posts",
    action: "CONTENT_VIEW",
    validators: [validator.validatePagination],
    handler: "listPosts",
  },
  {
    method: "get",
    path: "/posts/:id/versions",
    action: "CONTENT_VIEW",
    validators: [validator.validateUuidParam("id", "post id")],
    handler: "listPostVersions",
  },
  {
    method: "post",
    path: "/posts/:id/duplicate",
    action: "CONTENT_CREATE",
    validators: [validator.validateUuidParam("id", "post id")],
    handler: "duplicatePost",
  },
  {
    method: "post",
    path: "/posts/:id/submit",
    action: "CONTENT_SUBMIT",
    validators: [validator.validateUuidParam("id", "post id")],
    handler: "submitPost",
  },
  {
    method: "post",
    path: "/posts/:id/approve",
    action: "APPROVAL_DECIDE",
    validators: [validator.validateUuidParam("id", "post id")],
    handler: "approvePost",
  },
  {
    method: "post",
    path: "/posts/:id/reject",
    action: "APPROVAL_DECIDE",
    validators: [validator.validateUuidParam("id", "post id"), validator.validateReasonBody],
    handler: "rejectPost",
  },
  {
    method: "post",
    path: "/posts/:id/request-changes",
    action: "APPROVAL_DECIDE",
    validators: [validator.validateUuidParam("id", "post id"), validator.validateReasonBody],
    handler: "requestChanges",
  },
  {
    method: "post",
    path: "/posts/:id/publish",
    action: "PUBLISH",
    validators: [validator.validateUuidParam("id", "post id"), validator.validatePublishNow],
    handler: "publishPost",
  },
  {
    method: "post",
    path: "/posts/:id/schedule",
    action: "SCHEDULE",
    validators: [validator.validateUuidParam("id", "post id"), validator.validateSchedule],
    handler: "schedulePost",
  },
  {
    method: "get",
    path: "/posts/:id/publications",
    action: "PUBLISH",
    validators: [validator.validateUuidParam("id", "post id")],
    handler: "listPostPublications",
  },
  {
    method: "get",
    path: "/posts/:id",
    action: "CONTENT_VIEW",
    validators: [validator.validateUuidParam("id", "post id")],
    handler: "readPost",
  },
  {
    method: "patch",
    path: "/posts/:id",
    action: "CONTENT_EDIT",
    validators: [validator.validateUuidParam("id", "post id"), validator.validatePostUpdate],
    handler: "updatePost",
  },
  {
    method: "delete",
    path: "/posts/:id",
    action: "CONTENT_EDIT",
    validators: [validator.validateUuidParam("id", "post id")],
    handler: "deletePost",
  },

  { method: "get", path: "/publications", action: "PUBLISH", handler: "listPublications" },
  {
    method: "get",
    path: "/publications/:id",
    action: "PUBLISH",
    validators: [validator.validateUuidParam("id", "publication id")],
    handler: "readPublication",
  },
  {
    method: "post",
    path: "/publications/:id/retry",
    action: "PUBLISH_RETRY",
    validators: [validator.validateUuidParam("id", "publication id")],
    handler: "retryPublication",
  },
  {
    method: "post",
    path: "/publications/:id/cancel",
    action: "PUBLISH_CANCEL",
    validators: [validator.validateUuidParam("id", "publication id")],
    handler: "cancelPublication",
  },
  {
    method: "post",
    path: "/publications/:id/delete-provider-post",
    action: "PUBLISH_DELETE",
    validators: [validator.validateUuidParam("id", "publication id")],
    handler: "deleteProviderPost",
  },

  { method: "get", path: "/content", action: "CONTENT_VIEW", handler: "listContent" },
  {
    method: "get",
    path: "/content/:id/comments",
    action: "INBOX_VIEW",
    validators: [validator.validateUuidParam("id", "content id")],
    handler: "listContentComments",
  },
  {
    method: "get",
    path: "/content/:id/metrics",
    action: "ANALYTICS_VIEW",
    validators: [validator.validateUuidParam("id", "content id")],
    handler: "listContentMetrics",
  },
  {
    method: "get",
    path: "/content/:id",
    action: "CONTENT_VIEW",
    validators: [validator.validateUuidParam("id", "content id")],
    handler: "readContent",
  },

  {
    method: "post",
    path: "/media",
    action: "CONTENT_CREATE",
    validators: [multerSingle("asset")],
    handler: "createMedia",
  },
  { method: "get", path: "/media", action: "CONTENT_VIEW", handler: "listMedia" },
  {
    method: "get",
    path: "/media/:id/status",
    action: "CONTENT_VIEW",
    validators: [validator.validateUuidParam("id", "media id")],
    handler: "mediaStatus",
  },
  {
    method: "post",
    path: "/media/:id/reprocess",
    action: "CONTENT_EDIT",
    validators: [validator.validateUuidParam("id", "media id")],
    handler: "reprocessMedia",
  },
  {
    method: "get",
    path: "/media/:id/usage",
    action: "CONTENT_VIEW",
    validators: [validator.validateUuidParam("id", "media id")],
    handler: "mediaUsage",
  },
  {
    method: "get",
    path: "/media/:id",
    action: "CONTENT_VIEW",
    validators: [validator.validateUuidParam("id", "media id")],
    handler: "readMedia",
  },
  {
    method: "delete",
    path: "/media/:id",
    action: "CONTENT_EDIT",
    validators: [validator.validateUuidParam("id", "media id")],
    handler: "deleteMedia",
  },

  { method: "get", path: "/conversations", action: "INBOX_VIEW", handler: "listConversations" },
  {
    method: "get",
    path: "/conversations/:id/messages",
    action: "INBOX_VIEW",
    validators: [validator.validateUuidParam("id", "conversation id")],
    handler: "listConversationMessages",
  },
  {
    method: "get",
    path: "/conversations/:id",
    action: "INBOX_VIEW",
    validators: [validator.validateUuidParam("id", "conversation id")],
    handler: "readConversation",
  },
  {
    method: "post",
    path: "/conversations/:id/reply",
    action: "INBOX_REPLY",
    validators: [validator.validateUuidParam("id", "conversation id"), validator.validateReply],
    handler: "replyConversation",
  },
  {
    method: "post",
    path: "/conversations/:id/assign",
    action: "INBOX_ASSIGN",
    validators: [validator.validateUuidParam("id", "conversation id")],
    handler: "assignConversation",
  },
  {
    method: "post",
    path: "/conversations/:id/snooze",
    action: "INBOX_VIEW",
    validators: [validator.validateUuidParam("id", "conversation id")],
    handler: "snoozeConversation",
  },
  {
    method: "post",
    path: "/conversations/:id/resolve",
    action: "INBOX_RESOLVE",
    validators: [validator.validateUuidParam("id", "conversation id")],
    handler: "resolveConversation",
  },
  {
    method: "post",
    path: "/conversations/:id/notes",
    action: "INBOX_NOTE",
    validators: [validator.validateUuidParam("id", "conversation id")],
    handler: "createConversationNote",
  },
  {
    method: "post",
    path: "/conversations/:id/tags",
    action: "INBOX_TAG",
    validators: [validator.validateUuidParam("id", "conversation id")],
    handler: "tagConversation",
  },

  { method: "get", path: "/comments", action: "INBOX_VIEW", handler: "listComments" },
  {
    method: "get",
    path: "/comments/:id",
    action: "INBOX_VIEW",
    validators: [validator.validateUuidParam("id", "comment id")],
    handler: "readComment",
  },
  {
    method: "post",
    path: "/comments/:id/reply",
    action: "INBOX_REPLY",
    validators: [validator.validateUuidParam("id", "comment id"), validator.validateReply],
    handler: "replyComment",
  },
  {
    method: "post",
    path: "/comments/:id/assign",
    action: "INBOX_ASSIGN",
    validators: [validator.validateUuidParam("id", "comment id")],
    handler: "assignComment",
  },
  {
    method: "post",
    path: "/comments/:id/notes",
    action: "INBOX_NOTE",
    validators: [validator.validateUuidParam("id", "comment id")],
    handler: "createCommentNote",
  },
  {
    method: "post",
    path: "/comments/:id/hide",
    action: "MODERATION_HIDE",
    validators: [validator.validateUuidParam("id", "comment id")],
    handler: "hideComment",
  },
  {
    method: "post",
    path: "/comments/:id/delete",
    action: "MODERATION_DELETE",
    validators: [validator.validateUuidParam("id", "comment id")],
    handler: "deleteComment",
  },
  {
    method: "post",
    path: "/comments/:id/escalate",
    action: "MODERATION_ESCALATE",
    validators: [validator.validateUuidParam("id", "comment id")],
    handler: "escalateComment",
  },

  { method: "get", path: "/saved-replies", action: "INBOX_VIEW", handler: "listSavedReplies" },
  {
    method: "post",
    path: "/saved-replies",
    action: "SETTINGS_EDIT",
    validators: [validator.validateSavedReplyCreate],
    handler: "createSavedReply",
  },

  { method: "get", path: "/operations", action: "OPERATIONS_VIEW", handler: "listOperations" },
  {
    method: "get",
    path: "/operations/:id",
    action: "OPERATIONS_VIEW",
    validators: [validator.validateUuidParam("id", "operation id")],
    handler: "readOperation",
  },
  {
    method: "post",
    path: "/operations/:id/retry",
    action: "OPERATIONS_EDIT",
    validators: [validator.validateUuidParam("id", "operation id")],
    handler: "retryOperation",
  },
  {
    method: "post",
    path: "/operations/:id/cancel",
    action: "OPERATIONS_EDIT",
    validators: [validator.validateUuidParam("id", "operation id")],
    handler: "cancelOperation",
  },

  { method: "get", path: "/analytics/posts", action: "ANALYTICS_VIEW", handler: "analyticsPosts" },
  { method: "get", path: "/analytics/inbox", action: "ANALYTICS_VIEW", handler: "analyticsInbox" },
  {
    method: "get",
    path: "/analytics/export",
    action: "ANALYTICS_VIEW",
    handler: "analyticsExport",
  },

  { method: "get", path: "/settings", action: "SETTINGS_VIEW", handler: "getSettings" },
  {
    method: "patch",
    path: "/settings",
    action: "SETTINGS_EDIT",
    validators: [validator.validateSettingsUpdate],
    handler: "updateSettings",
  },
]);

const SECTION8_ROUTE_DEFINITIONS = Object.freeze([
  ...SECTION8_PUBLIC_ROUTES,
  ...SECTION8_AUTH_ROUTES,
]);

for (const route of SECTION8_PUBLIC_ROUTES) {
  router[route.method](
    route.path,
    ...(route.validators || []),
    socialController[route.handler],
  );
}

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { success: false, message: "Too many Social Operations requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(authenticate);
router.use(requireTier("ADMIN"));
router.use(limiter);

router.get(
  "/operations/health",
  requireSocialOperation("OPERATIONS_VIEW"),
  socialController.operationsHealth,
);

for (const route of SECTION8_AUTH_ROUTES) {
  router[route.method](
    route.path,
    requireSocialOperation(route.action),
    ...(route.validators || []),
    socialController[route.handler],
  );
}

module.exports = {
  router,
  SECTION8_PUBLIC_ROUTES,
  SECTION8_AUTH_ROUTES,
  SECTION8_ROUTE_DEFINITIONS,
};
