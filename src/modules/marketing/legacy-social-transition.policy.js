const ApiError = require("../../shared/utils/ApiError");

function envFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getLegacySocialCompatibilityPolicy(env = process.env) {
  return {
    frontendCutoverComplete: envFlag(env.MARKETING_LEGACY_SOCIAL_FRONTEND_CUTOVER_COMPLETE),
    writeDeprecationEnabled: envFlag(env.MARKETING_LEGACY_SOCIAL_WRITE_DEPRECATION_ENABLED),
    readCompatibilityEndsAt: parseDate(env.MARKETING_LEGACY_SOCIAL_READ_COMPATIBILITY_ENDS_AT),
  };
}

function assertLegacySocialReadAllowed(
  policy = getLegacySocialCompatibilityPolicy(),
  now = new Date(),
) {
  if (
    policy.frontendCutoverComplete &&
    policy.readCompatibilityEndsAt &&
    policy.readCompatibilityEndsAt <= now
  ) {
    throw new ApiError(410, "Legacy social reads are no longer available");
  }
}

function assertLegacySocialWriteAllowed(policy = getLegacySocialCompatibilityPolicy()) {
  if (policy.frontendCutoverComplete && policy.writeDeprecationEnabled) {
    throw new ApiError(409, "Legacy social writes are deprecated; use Social Operations");
  }
}

function legacySocialCompatibilityHeaders(policy = getLegacySocialCompatibilityPolicy()) {
  const headers = {
    "X-Legacy-Social-Compatibility": policy.frontendCutoverComplete
      ? "cutover-complete"
      : "active",
  };
  if (policy.writeDeprecationEnabled) {
    headers.Deprecation = "true";
  }
  if (policy.readCompatibilityEndsAt) {
    headers.Sunset = policy.readCompatibilityEndsAt.toUTCString();
  }
  return headers;
}

module.exports = {
  getLegacySocialCompatibilityPolicy,
  assertLegacySocialReadAllowed,
  assertLegacySocialWriteAllowed,
  legacySocialCompatibilityHeaders,
};
