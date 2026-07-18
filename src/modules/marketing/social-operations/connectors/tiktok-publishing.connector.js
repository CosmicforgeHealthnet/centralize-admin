const { buildCapabilities } = require("./connector-capability.service");
const { CAPABILITY_STATUS, REASON_CODES } = require("./connector.constants");
const {
  ConnectorCapabilityError,
  ConnectorNotConfiguredError,
} = require("./connector.errors");
const { assertPublishingConnection } = require("./connector.validators");

const platform = "TIKTOK";

function unavailable(operation, params = {}) {
  assertPublishingConnection(params.connection || {}, platform);
  const capability = buildCapabilities({
    platform,
    identity: params.identity || params.target?.identity || {},
    connection: params.connection || {},
  })[operation] || {
    status: CAPABILITY_STATUS.DISABLED_BY_POLICY,
    reason: REASON_CODES.PROVIDER_RUNTIME_NOT_ENABLED,
  };

  throw new ConnectorCapabilityError("Provider operation is unavailable", {
    platform,
    operation,
    capabilityStatus: capability.status,
    reasonCode: capability.reason,
  });
}

module.exports = {
  platform,
  async discoverIdentities(params = {}) {
    return unavailable("discoverIdentities", params);
  },
  async getCapabilities({ identity, connection } = {}) {
    return buildCapabilities({ platform, identity, connection });
  },
  async validatePost(params = {}) {
    return unavailable("validatePost", params);
  },
  async uploadMedia(params = {}) {
    return unavailable("uploadMedia", params);
  },
  async publishPost(params = {}) {
    return unavailable("publishPost", params);
  },
  async getPublishStatus(params = {}) {
    return unavailable("getPublishStatus", params);
  },
  async updatePost(params = {}) {
    return unavailable("updatePost", params);
  },
  async deletePost(params = {}) {
    return unavailable("deletePost", params);
  },
  async listComments(params = {}) {
    return unavailable("listComments", params);
  },
  async replyToComment(params = {}) {
    return unavailable("replyToComment", params);
  },
  async moderateComment(params = {}) {
    return unavailable("moderateComment", params);
  },
  async listConversations(params = {}) {
    return unavailable("listConversations", params);
  },
  async sendMessage(params = {}) {
    return unavailable("sendMessage", params);
  },
  async listContent(params = {}) {
    return unavailable("listContent", params);
  },
  async getContent(params = {}) {
    return unavailable("getContent", params);
  },
  async listContentMetrics(params = {}) {
    return unavailable("listContentMetrics", params);
  },
  verifyWebhook() {
    throw new ConnectorNotConfiguredError("Webhook verification is not configured", {
      platform,
      operation: "verifyWebhook",
      capabilityStatus: CAPABILITY_STATUS.DISABLED_BY_POLICY,
      reasonCode: REASON_CODES.WEBHOOK_SIGNATURE_VERIFICATION_NOT_CONFIGURED,
    });
  },
  normalizeWebhookEvent(params = {}) {
    return unavailable("normalizeWebhookEvent", params);
  },
};
