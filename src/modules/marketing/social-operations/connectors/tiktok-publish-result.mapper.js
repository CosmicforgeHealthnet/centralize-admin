const { ConnectorNormalizationError } = require("./connector.errors");
const { validatePublishResult } = require("./publish-result.mapper");

function mapTikTokPublishResult(result = {}) {
  if (result.postingMode === "UPLOAD_TO_DRAFT") {
    return validatePublishResult({
      providerPostId: result.providerPostId ?? null,
      url: result.url ?? null,
      status: "AWAITING_USER_ACTION",
      postingMode: "UPLOAD_TO_DRAFT",
      confirmed: false,
    });
  }

  if (result.postingMode !== "DIRECT_POST") {
    throw new ConnectorNormalizationError("TikTok posting mode is unsupported");
  }

  if (result.confirmed === true) {
    return validatePublishResult({
      providerPostId: result.providerPostId ?? null,
      url: result.url ?? null,
      status: "PUBLISHED",
      postingMode: "DIRECT_POST",
      confirmed: true,
    });
  }

  return validatePublishResult({
    providerPostId: result.providerPostId ?? null,
    url: result.url ?? null,
    status: "PROCESSING",
    postingMode: "DIRECT_POST",
    confirmed: false,
  });
}

module.exports = {
  mapTikTokPublishResult,
};
