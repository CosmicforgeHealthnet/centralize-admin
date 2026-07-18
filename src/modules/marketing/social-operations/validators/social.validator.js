const ApiError = require("../../../../shared/utils/ApiError");
const {
  SOCIAL_PROVIDERS,
  CAPABILITY_STATUS_VALUES,
} = require("../connectors/connector.constants");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeProvider(provider) {
  return String(provider || "").trim().toUpperCase();
}

function assertProvider(provider) {
  const normalized = normalizeProvider(provider);
  if (!SOCIAL_PROVIDERS.includes(normalized)) {
    throw new ApiError(400, "Unknown Social provider");
  }
  return normalized;
}

function assertUuid(value, label = "id") {
  if (!UUID_PATTERN.test(String(value || ""))) {
    throw new ApiError(400, `Invalid ${label}`);
  }
  return String(value);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, `${label} is required`);
  }
  return value.trim();
}

function assertOptionalString(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiError(400, `${label} must be a string`);
  return value;
}

function assertStringArray(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ApiError(400, `${label} must be an array of strings`);
  }
  return value;
}

function assertFutureDate(value, label) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new ApiError(400, `${label} must be a valid ISO datetime`);
  }
  if (date.getTime() <= Date.now()) {
    throw new ApiError(400, `${label} must be in the future`);
  }
  return date;
}

function assertTimezone(value) {
  const timezone = assertNonEmptyString(value, "timezone");
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new ApiError(400, "timezone is invalid");
  }
  return timezone;
}

function validateProviderParam(req, res, next) {
  try {
    req.params.provider = assertProvider(req.params.provider);
    next();
  } catch (error) {
    next(error);
  }
}

function validateUuidParam(paramName, label = paramName) {
  return (req, res, next) => {
    try {
      req.params[paramName] = assertUuid(req.params[paramName], label);
      next();
    } catch (error) {
      next(error);
    }
  };
}

function validatePagination(req, res, next) {
  try {
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError(400, "limit must be an integer between 1 and 100");
    }
    req.socialPagination = {
      limit,
      cursor: req.query.cursor ? String(req.query.cursor) : null,
    };
    next();
  } catch (error) {
    next(error);
  }
}

function validatePostCreate(req, res, next) {
  try {
    req.body = {
      ...req.body,
      title: assertOptionalString(req.body?.title, "title"),
      baseText: assertNonEmptyString(req.body?.baseText, "baseText"),
      mediaAssetIds: assertStringArray(req.body?.mediaAssetIds, "mediaAssetIds"),
      targets: Array.isArray(req.body?.targets) ? req.body.targets : [],
    };
    next();
  } catch (error) {
    next(error);
  }
}

function validatePostUpdate(req, res, next) {
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      throw new ApiError(400, "Request body must be an object");
    }
    if (
      req.body.baseText !== undefined &&
      (typeof req.body.baseText !== "string" || !req.body.baseText.trim())
    ) {
      throw new ApiError(400, "baseText must be a non-empty string");
    }
    if (req.body.mediaAssetIds !== undefined) {
      assertStringArray(req.body.mediaAssetIds, "mediaAssetIds");
    }
    next();
  } catch (error) {
    next(error);
  }
}

function validateReasonBody(req, res, next) {
  try {
    req.body = {
      ...req.body,
      reason: assertNonEmptyString(req.body?.reason, "reason"),
    };
    next();
  } catch (error) {
    next(error);
  }
}

function validateSchedule(req, res, next) {
  try {
    const targets = req.body?.targets;
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new ApiError(400, "targets must contain at least one item");
    }

    req.body.targets = targets.map((target) => ({
      ...target,
      identityId: assertUuid(target.identityId, "identityId"),
      text: assertNonEmptyString(target.text, "target text"),
      mediaAssetIds: assertStringArray(target.mediaAssetIds, "mediaAssetIds"),
      scheduledForUtc: assertFutureDate(
        target.scheduledForUtc,
        "scheduledForUtc",
      ),
      timezone: assertTimezone(target.timezone),
      options: target.options && typeof target.options === "object" ? target.options : {},
    }));
    next();
  } catch (error) {
    next(error);
  }
}

function validatePublishNow(req, res, next) {
  try {
    if (req.body?.targets !== undefined && !Array.isArray(req.body.targets)) {
      throw new ApiError(400, "targets must be an array");
    }
    if (Array.isArray(req.body?.targets)) {
      req.body.targets = req.body.targets.map((target) => ({
        ...target,
        identityId: assertUuid(target.identityId, "identityId"),
        text: target.text ? assertNonEmptyString(target.text, "target text") : undefined,
        mediaAssetIds: assertStringArray(target.mediaAssetIds, "mediaAssetIds"),
      }));
    }
    next();
  } catch (error) {
    next(error);
  }
}

function validateReply(req, res, next) {
  try {
    req.body = {
      ...req.body,
      text: assertNonEmptyString(req.body?.text, "reply text"),
    };
    next();
  } catch (error) {
    next(error);
  }
}

function validateSavedReplyCreate(req, res, next) {
  try {
    req.body = {
      ...req.body,
      name: assertNonEmptyString(req.body?.name, "name"),
      channel: assertNonEmptyString(req.body?.channel, "channel"),
      text: assertNonEmptyString(req.body?.text, "text"),
    };
    next();
  } catch (error) {
    next(error);
  }
}

function validateCapabilityPayload(req, res, next) {
  try {
    if (req.body?.status && !CAPABILITY_STATUS_VALUES.includes(req.body.status)) {
      throw new ApiError(400, "Unknown capability status");
    }
    next();
  } catch (error) {
    next(error);
  }
}

function validateSettingsUpdate(req, res, next) {
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      throw new ApiError(400, "Settings update body must be an object");
    }
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  assertProvider,
  assertUuid,
  assertNonEmptyString,
  assertStringArray,
  assertFutureDate,
  assertTimezone,
  validateProviderParam,
  validateUuidParam,
  validatePagination,
  validatePostCreate,
  validatePostUpdate,
  validateReasonBody,
  validateSchedule,
  validatePublishNow,
  validateReply,
  validateSavedReplyCreate,
  validateCapabilityPayload,
  validateSettingsUpdate,
};
