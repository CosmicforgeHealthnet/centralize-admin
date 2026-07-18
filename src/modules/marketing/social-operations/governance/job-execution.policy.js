const { CAPABILITY_STATUS } = require("../connectors/connector.constants");
const {
  identityBlocked,
  providerBlocked,
} = require("./governance-settings.service");

function allow() {
  return {
    allowed: true,
    retryable: false,
    errorCategory: null,
    reasonCode: null,
    message: null,
  };
}

function deny(reasonCode, message, { retryable = false, errorCategory = "PERMANENT" } = {}) {
  return {
    allowed: false,
    retryable,
    errorCategory: retryable ? "RETRYABLE" : errorCategory,
    reasonCode,
    message,
  };
}

function evaluateJobExecutionPolicy({
  connection,
  identity,
  requiredCapability,
  capability,
  publication,
  approvedRevision,
  currentRevision,
  settings,
} = {}) {
  if (!connection) {
    return deny("CONNECTION_NOT_FOUND", "The Social connection no longer exists.");
  }

  if (connection.status !== "ACTIVE") {
    return deny("CONNECTION_NOT_ACTIVE", "The Social connection is not active.");
  }

  if (connection.requiresReauthorization === true) {
    return deny(
      "CONNECTION_REAUTHORIZATION_REQUIRED",
      "The Social connection requires reauthorization.",
    );
  }

  if (!identity) {
    return deny("IDENTITY_NOT_FOUND", "The Social publishing identity no longer exists.");
  }

  if (identity.disabledAt) {
    return deny("IDENTITY_DISABLED", "The Social publishing identity is disabled.");
  }

  if (identity.connectionId !== connection.id) {
    return deny(
      "IDENTITY_CONNECTION_MISMATCH",
      "The Social publishing identity does not belong to the expected connection.",
    );
  }

  if (providerBlocked(settings, connection.provider)) {
    return deny("PROVIDER_BLOCKED_BY_POLICY", "The provider is blocked by company policy.");
  }

  if (identityBlocked(settings, identity.id)) {
    return deny("IDENTITY_BLOCKED_BY_POLICY", "The identity is blocked by company policy.");
  }

  if (!capability || capability.status !== CAPABILITY_STATUS.AVAILABLE) {
    if (capability?.status === CAPABILITY_STATUS.RATE_LIMITED && capability.retryAt) {
      return deny("PROVIDER_RATE_LIMITED", "The provider is rate limited.", {
        retryable: true,
      });
    }

    return deny(
      "CAPABILITY_NOT_AVAILABLE",
      `${requiredCapability || "Provider capability"} is not currently available.`,
    );
  }

  if (!approvedRevision) {
    return deny("APPROVED_REVISION_NOT_FOUND", "The approved revision was not found.");
  }

  if (
    publication?.postVersion !== approvedRevision.version ||
    (publication?.postId && approvedRevision.postId !== publication.postId) ||
    (currentRevision && currentRevision.version > approvedRevision.version)
  ) {
    return deny(
      "APPROVED_REVISION_MISMATCH",
      "The approved revision no longer matches the publication.",
    );
  }

  return allow();
}

module.exports = {
  evaluateJobExecutionPolicy,
};
