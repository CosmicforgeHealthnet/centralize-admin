const ApiError = require("../../../../shared/utils/ApiError");

function splitAllowList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function redirectAllowList({ allowList } = {}) {
  return new Set(
    allowList ||
      splitAllowList(
        process.env.SOCIAL_OAUTH_REDIRECT_URIS ||
          process.env.SOCIAL_OPERATIONS_OAUTH_REDIRECT_URIS,
      ),
  );
}

function isLocalhostUri(uri) {
  try {
    const parsed = new URL(uri);
    return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function isDevelopmentLike(env = process.env.NODE_ENV) {
  return ["development", "test", "local"].includes(String(env || "").toLowerCase());
}

function assertAllowedRedirectUri({ redirectUri, allowList, nodeEnv } = {}) {
  const uri = String(redirectUri || "");
  if (!uri) throw new ApiError(400, "OAuth redirect URI is required");

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new ApiError(400, "OAuth redirect URI is not allowed");
  }

  if (parsed.protocol === "http:" && !(isDevelopmentLike(nodeEnv) && isLocalhostUri(uri))) {
    throw new ApiError(400, "OAuth redirect URI is not allowed");
  }

  const allowed = redirectAllowList({ allowList });
  if (!allowed.has(uri)) {
    throw new ApiError(400, "OAuth redirect URI is not allowed");
  }

  return uri;
}

module.exports = {
  assertAllowedRedirectUri,
  redirectAllowList,
};
