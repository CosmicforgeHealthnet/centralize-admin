const {
  SOCIAL_POSTING_MODES,
  SOCIAL_PUBLICATION_STATUSES,
} = require("./connector.constants");
const { ConnectorNormalizationError } = require("./connector.errors");

const FAKE_LOCAL_ID_PATTERN = /^(local|fake|test-local)[_-]/i;

function validateProviderPostId(providerPostId) {
  if (providerPostId === null || providerPostId === undefined) return null;
  if (typeof providerPostId !== "string" || providerPostId.trim() === "") {
    throw new ConnectorNormalizationError("Provider post ID must be a string or null");
  }
  if (FAKE_LOCAL_ID_PATTERN.test(providerPostId)) {
    throw new ConnectorNormalizationError("Provider post ID cannot be a fake local ID");
  }
  return providerPostId;
}

function validatePublishResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new ConnectorNormalizationError("Publish result must be an object");
  }

  if (result.status === "SUBMITTED") {
    throw new ConnectorNormalizationError("SUBMITTED is not a Social publication status");
  }

  if (!SOCIAL_PUBLICATION_STATUSES.includes(result.status)) {
    throw new ConnectorNormalizationError("Publish result status is unsupported");
  }

  if (
    result.postingMode !== undefined &&
    result.postingMode !== null &&
    !SOCIAL_POSTING_MODES.includes(result.postingMode)
  ) {
    throw new ConnectorNormalizationError("Posting mode is unsupported");
  }

  if (result.status === "PUBLISHED" && result.confirmed !== true) {
    throw new ConnectorNormalizationError("PUBLISHED requires confirmed final publication");
  }

  return {
    providerPostId: validateProviderPostId(result.providerPostId),
    url: result.url ?? null,
    status: result.status,
    ...(result.postingMode ? { postingMode: result.postingMode } : {}),
  };
}

function mapProviderPublishResult(providerResult = {}) {
  if (providerResult.submitted === true || providerResult.accepted === true) {
    return validatePublishResult({
      providerPostId: providerResult.providerPostId ?? null,
      url: providerResult.url ?? null,
      status: "PROCESSING",
      postingMode: providerResult.postingMode,
      confirmed: false,
    });
  }

  return validatePublishResult(providerResult);
}

module.exports = {
  validatePublishResult,
  mapProviderPublishResult,
};
