const asyncHandler = require("../../../../shared/utils/asyncHandler");
const socialApi = require("../services/social-api.service");
const {
  handleWebhookChallenge,
} = require("../services/webhook-verification.service");
const {
  ingestWebhookRequest,
} = require("../services/webhook-ingestion.service");
const { sanitizeForResponse } = require("../services/sanitization.service");

function context(req) {
  return {
    adminUser: req.adminUser,
    req,
  };
}

function send(res, data, status = 200) {
  return res.status(status).json({
    success: true,
    data: sanitizeForResponse(data),
  });
}

const handlers = {
  oauthCallback: asyncHandler(async (req, res) => {
    return send(
      res,
      await socialApi.verifyOAuthCallback({
        provider: req.params.provider,
        query: req.query,
      }),
    );
  }),

  webhookChallenge: asyncHandler(async (req, res) => {
    const result = handleWebhookChallenge({
      provider: req.params.provider,
      query: req.query,
    });
    if (result.raw) return res.status(200).send(result.challenge);
    return send(res, result);
  }),

  webhookIngest: asyncHandler(async (req, res) => {
    const result = await ingestWebhookRequest({
      provider: req.params.provider,
      req,
    });
    return send(
      res,
      {
        acknowledged: result.acknowledged,
        duplicate: result.duplicate,
        eventId: result.event.id,
      },
      202,
    );
  }),

  listConnections: asyncHandler(async (req, res) =>
    send(res, await socialApi.connectionList()),
  ),
  startOAuth: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.startOAuth({
        provider: req.params.provider,
        context: context(req),
        redirectUri: req.body?.redirectUri,
      }),
      201,
    ),
  ),
  testConnection: asyncHandler(async (req, res) =>
    send(res, await socialApi.testConnection({ id: req.params.id })),
  ),
  reauthorizeConnection: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.reauthorizeConnection({
        id: req.params.id,
        context: context(req),
      }),
      201,
    ),
  ),
  disableConnection: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.setConnectionStatus({
        id: req.params.id,
        status: "DISABLED",
        context: context(req),
        req,
      }),
    ),
  ),
  enableConnection: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.setConnectionStatus({
        id: req.params.id,
        status: "ACTIVE",
        context: context(req),
        req,
      }),
    ),
  ),
  discoverIdentities: asyncHandler(async (req, res) =>
    send(res, await socialApi.discoverIdentities({ id: req.params.id })),
  ),

  listIdentities: asyncHandler(async (req, res) =>
    send(res, await socialApi.identityList()),
  ),
  refreshIdentityCapabilities: asyncHandler(async (req, res) =>
    send(res, await socialApi.refreshIdentityCapabilities({ id: req.params.id })),
  ),

  createPost: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.createPost({ body: req.body, context: context(req) }),
      201,
    ),
  ),
  listPosts: asyncHandler(async (req, res) =>
    send(res, await socialApi.listPosts({ pagination: req.socialPagination })),
  ),
  readPost: asyncHandler(async (req, res) =>
    send(res, await socialApi.readPost({ id: req.params.id })),
  ),
  updatePost: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.updatePost({
        id: req.params.id,
        body: req.body,
        context: context(req),
      }),
    ),
  ),
  deletePost: asyncHandler(async (req, res) =>
    send(res, await socialApi.deletePost({ id: req.params.id })),
  ),
  duplicatePost: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.duplicatePost({
        id: req.params.id,
        context: context(req),
      }),
      201,
    ),
  ),
  listPostVersions: asyncHandler(async (req, res) =>
    send(res, await socialApi.listPostVersions({ id: req.params.id })),
  ),
  submitPost: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.submitPost({ id: req.params.id, context: context(req) }),
      201,
    ),
  ),
  approvePost: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.decideApproval({
        id: req.params.id,
        decision: "APPROVED",
        context: context(req),
      }),
      201,
    ),
  ),
  rejectPost: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.decideApproval({
        id: req.params.id,
        decision: "REJECTED",
        reason: req.body.reason,
        context: context(req),
      }),
      201,
    ),
  ),
  requestChanges: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.decideApproval({
        id: req.params.id,
        decision: "CHANGES_REQUESTED",
        reason: req.body.reason,
        context: context(req),
      }),
      201,
    ),
  ),

  publishPost: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.publishPost({
        id: req.params.id,
        body: req.body,
        context: context(req),
      }),
      202,
    ),
  ),
  schedulePost: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.schedulePost({
        id: req.params.id,
        body: req.body,
        context: context(req),
      }),
      202,
    ),
  ),
  listPublications: asyncHandler(async (req, res) =>
    send(res, await socialApi.listPublications()),
  ),
  readPublication: asyncHandler(async (req, res) =>
    send(res, await socialApi.readPublication({ id: req.params.id })),
  ),
  listPostPublications: asyncHandler(async (req, res) =>
    send(res, await socialApi.listPostPublications({ id: req.params.id })),
  ),
  retryPublication: asyncHandler(async (req, res) =>
    send(res, await socialApi.retryPublication({ id: req.params.id })),
  ),
  cancelPublication: asyncHandler(async (req, res) =>
    send(res, await socialApi.cancelPublication({ id: req.params.id })),
  ),
  deleteProviderPost: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.enqueueDeleteProviderPost({
        id: req.params.id,
        context: context(req),
      }),
      202,
    ),
  ),

  listContent: asyncHandler(async (req, res) =>
    send(res, await socialApi.listContent()),
  ),
  readContent: asyncHandler(async (req, res) =>
    send(res, await socialApi.readContent({ id: req.params.id })),
  ),
  syncContent: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.syncContent({
        id: req.params.id,
        context: context(req),
      }),
      202,
    ),
  ),
  listContentComments: asyncHandler(async (req, res) =>
    send(res, await socialApi.listContentComments({ id: req.params.id })),
  ),
  listContentMetrics: asyncHandler(async (req, res) =>
    send(res, await socialApi.listContentMetrics({ id: req.params.id })),
  ),

  createMedia: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.createMedia({
        body: req.body,
        file: req.file,
        context: context(req),
      }),
      201,
    ),
  ),
  listMedia: asyncHandler(async (req, res) => send(res, await socialApi.listMedia())),
  readMedia: asyncHandler(async (req, res) =>
    send(res, await socialApi.readMedia({ id: req.params.id })),
  ),
  mediaStatus: asyncHandler(async (req, res) =>
    send(res, await socialApi.mediaStatus({ id: req.params.id })),
  ),
  reprocessMedia: asyncHandler(async (req, res) =>
    send(res, await socialApi.reprocessMedia({ id: req.params.id })),
  ),
  mediaUsage: asyncHandler(async (req, res) =>
    send(res, await socialApi.mediaUsage({ id: req.params.id })),
  ),
  deleteMedia: asyncHandler(async (req, res) =>
    send(res, await socialApi.deleteMedia({ id: req.params.id, context: context(req) })),
  ),

  listConversations: asyncHandler(async (req, res) =>
    send(res, await socialApi.listConversations({ context: context(req) })),
  ),
  readConversation: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.readConversation({ id: req.params.id, context: context(req) }),
    ),
  ),
  listConversationMessages: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.listConversationMessages({
        id: req.params.id,
        context: context(req),
      }),
    ),
  ),
  replyConversation: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.replyConversation({
        id: req.params.id,
        body: req.body,
        context: context(req),
      }),
      202,
    ),
  ),
  assignConversation: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.assignConversation({
        id: req.params.id,
        body: req.body,
        context: context(req),
      }),
    ),
  ),
  snoozeConversation: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.snoozeConversation({ id: req.params.id, body: req.body }),
    ),
  ),
  resolveConversation: asyncHandler(async (req, res) =>
    send(res, await socialApi.resolveConversation({ id: req.params.id })),
  ),
  createConversationNote: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.createInternalNote({
        entityType: "CONVERSATION",
        entityId: req.params.id,
        body: req.body,
        context: context(req),
      }),
      201,
    ),
  ),
  tagConversation: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.tagConversation({
        id: req.params.id,
        body: req.body,
        context: context(req),
      }),
    ),
  ),

  listComments: asyncHandler(async (req, res) =>
    send(res, await socialApi.listComments({ context: context(req) })),
  ),
  readComment: asyncHandler(async (req, res) =>
    send(res, await socialApi.readComment({ id: req.params.id, context: context(req) })),
  ),
  replyComment: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.replyComment({
        id: req.params.id,
        body: req.body,
        context: context(req),
      }),
      202,
    ),
  ),
  assignComment: asyncHandler(async (req, res) =>
    send(res, await socialApi.assignComment({ id: req.params.id, body: req.body })),
  ),
  createCommentNote: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.createInternalNote({
        entityType: "COMMENT",
        entityId: req.params.id,
        body: req.body,
        context: context(req),
      }),
      201,
    ),
  ),
  hideComment: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.moderateComment({
        id: req.params.id,
        action: "hide",
        context: context(req),
      }),
      202,
    ),
  ),
  deleteComment: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.moderateComment({
        id: req.params.id,
        action: "delete",
        context: context(req),
      }),
      202,
    ),
  ),
  escalateComment: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.escalateComment({
        id: req.params.id,
        body: req.body,
        context: context(req),
      }),
      201,
    ),
  ),

  listSavedReplies: asyncHandler(async (req, res) =>
    send(res, await socialApi.listSavedReplies()),
  ),
  createSavedReply: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.createSavedReply({ body: req.body, context: context(req) }),
      201,
    ),
  ),

  listOperations: asyncHandler(async (req, res) =>
    send(res, await socialApi.listOperations()),
  ),
  operationsHealth: asyncHandler(async (req, res) =>
    send(res, await socialApi.operationsHealth()),
  ),
  readOperation: asyncHandler(async (req, res) =>
    send(res, await socialApi.readOperation({ id: req.params.id })),
  ),
  retryOperation: asyncHandler(async (req, res) =>
    send(res, await socialApi.retryOperation({ id: req.params.id })),
  ),
  cancelOperation: asyncHandler(async (req, res) =>
    send(res, await socialApi.cancelOperation({ id: req.params.id })),
  ),

  analyticsPosts: asyncHandler(async (req, res) =>
    send(res, await socialApi.analyticsPosts()),
  ),
  analyticsInbox: asyncHandler(async (req, res) =>
    send(res, await socialApi.analyticsInbox()),
  ),
  analyticsExport: asyncHandler(async (req, res) =>
    send(res, await socialApi.analyticsExport({ context: context(req) })),
  ),

  getSettings: asyncHandler(async (req, res) => send(res, await socialApi.getSettings())),
  updateSettings: asyncHandler(async (req, res) =>
    send(
      res,
      await socialApi.updateSettings({ body: req.body, context: context(req) }),
    ),
  ),
};

module.exports = handlers;
