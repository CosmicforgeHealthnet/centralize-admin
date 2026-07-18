const {
  CAPABILITY_STATUS,
  CONNECTOR_METHODS,
  PROVIDER_BACKED_OPERATIONS,
  REASON_CODES,
} = require("./connector.constants");

function entry(status, reason = null, extra = {}) {
  return Object.freeze({ status, reason, ...extra });
}

function allCapabilities(status, reason = null) {
  return Object.freeze(
    Object.fromEntries(CONNECTOR_METHODS.map((operation) => [operation, entry(status, reason)])),
  );
}

function runtimeDisabledCapabilities() {
  return Object.fromEntries(
    CONNECTOR_METHODS.map((operation) => [
      operation,
      operation === "getCapabilities"
        ? entry(CAPABILITY_STATUS.AVAILABLE, null)
        : entry(CAPABILITY_STATUS.DISABLED_BY_POLICY, REASON_CODES.PROVIDER_RUNTIME_NOT_ENABLED),
    ]),
  );
}

function applyConnectionStateRules(connection) {
  if (!connection) {
    return allCapabilities(
      CAPABILITY_STATUS.DISABLED_BY_POLICY,
      REASON_CODES.AUTHORIZATION_INCOMPLETE,
    );
  }

  if (
    connection.requiresReauthorization === true ||
    connection.status === "REAUTHORIZATION_REQUIRED"
  ) {
    return allCapabilities(
      CAPABILITY_STATUS.REQUIRES_REAUTHORIZATION,
      REASON_CODES.CREDENTIAL_REAUTHORIZATION_REQUIRED,
    );
  }

  if (connection.status === "DISABLED") {
    return allCapabilities(
      CAPABILITY_STATUS.DISABLED_BY_POLICY,
      REASON_CODES.CONNECTION_DISABLED,
    );
  }

  if (connection.status === "ERROR") {
    return allCapabilities(CAPABILITY_STATUS.DISABLED_BY_POLICY, REASON_CODES.CONNECTION_ERROR);
  }

  if (connection.status === "PENDING_AUTHORIZATION") {
    return allCapabilities(
      CAPABILITY_STATUS.DISABLED_BY_POLICY,
      REASON_CODES.AUTHORIZATION_INCOMPLETE,
    );
  }

  if (connection.status === "PENDING_PLATFORM_APPROVAL") {
    return allCapabilities(
      CAPABILITY_STATUS.REQUIRES_PLATFORM_APPROVAL,
      REASON_CODES.PROVIDER_PRODUCT_APPROVAL_REQUIRED,
    );
  }

  return null;
}

function isPersonalInstagram(identity = {}) {
  return (
    identity.type === "INSTAGRAM_PERSONAL" ||
    identity.accountType === "PERSONAL_INSTAGRAM" ||
    identity.providerIdentityType === "INSTAGRAM_PERSONAL"
  );
}

function isMessagingWindowOpen(identity = {}, now = new Date()) {
  if (identity.messagingWindowOpen === true || identity.customerWindowOpen === true) {
    return true;
  }

  const inboundAt = identity.lastInboundAt || identity.lastCustomerMessageAt;
  if (!inboundAt) return false;

  const timestamp = new Date(inboundAt).getTime();
  if (Number.isNaN(timestamp)) return false;

  return now.getTime() - timestamp <= 24 * 60 * 60 * 1000;
}

function hasXPaidAccess(identity = {}, connection = {}) {
  return Boolean(
    identity.paidTierApproved ||
      identity.providerProductApproved ||
      connection.paidTierApproved ||
      connection.providerProductApproved ||
      connection.productApprovalStatus === "APPROVED",
  );
}

function buildCapabilities({ platform, identity = {}, connection = {}, now = new Date() }) {
  const connectionState = applyConnectionStateRules(connection);
  if (connectionState) return connectionState;

  const capabilities = runtimeDisabledCapabilities();

  if (platform === "META") {
    if (isPersonalInstagram(identity)) {
      for (const operation of PROVIDER_BACKED_OPERATIONS) {
        capabilities[operation] = entry(
          CAPABILITY_STATUS.UNSUPPORTED_ACCOUNT_TYPE,
          REASON_CODES.UNSUPPORTED_ACCOUNT_TYPE,
        );
      }
      return Object.freeze(capabilities);
    }

    capabilities.sendMessage = isMessagingWindowOpen(identity, now)
      ? entry(CAPABILITY_STATUS.DISABLED_BY_POLICY, REASON_CODES.PROVIDER_RUNTIME_NOT_ENABLED)
      : entry(
          CAPABILITY_STATUS.DISABLED_BY_POLICY,
          REASON_CODES.CUSTOMER_INITIATED_WINDOW_REQUIRED,
        );
  }

  if (platform === "TIKTOK") {
    for (const operation of [
      "listComments",
      "replyToComment",
      "listConversations",
      "sendMessage",
    ]) {
      capabilities[operation] = entry(
        CAPABILITY_STATUS.NATIVE_ONLY,
        REASON_CODES.PROVIDER_API_NOT_AVAILABLE,
      );
    }
  }

  if (platform === "X") {
    for (const operation of ["uploadMedia", "publishPost", "sendMessage"]) {
      capabilities[operation] = hasXPaidAccess(identity, connection)
        ? entry(CAPABILITY_STATUS.DISABLED_BY_POLICY, REASON_CODES.PROVIDER_RUNTIME_NOT_ENABLED)
        : entry(CAPABILITY_STATUS.REQUIRES_PLATFORM_APPROVAL, REASON_CODES.X_PAID_ACCESS_REQUIRED);
    }
  }

  if (platform === "LINKEDIN") {
    capabilities.listConversations = entry(
      CAPABILITY_STATUS.NATIVE_ONLY,
      REASON_CODES.PROVIDER_API_NOT_AVAILABLE,
    );
    capabilities.sendMessage = entry(
      CAPABILITY_STATUS.NATIVE_ONLY,
      REASON_CODES.PROVIDER_API_NOT_AVAILABLE,
    );

    if (identity.type === "LINKEDIN_MEMBER") {
      capabilities.publishPost = entry(
        CAPABILITY_STATUS.DISABLED_BY_POLICY,
        REASON_CODES.LINKEDIN_MEMBER_PUBLISHING_DEFERRED,
      );
    }
  }

  return Object.freeze(capabilities);
}

module.exports = {
  buildCapabilities,
  applyConnectionStateRules,
};
