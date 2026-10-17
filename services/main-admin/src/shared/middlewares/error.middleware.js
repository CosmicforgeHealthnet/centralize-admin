const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");

function boundedRetryAfter(value) {
  if (value == null) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return String(Math.min(Math.max(Math.ceil(numeric), 1), 3600));
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return String(Math.min(Math.max(Math.ceil((date.getTime() - Date.now()) / 1000), 1), 3600));
}

const errorHandler = (err, req, res, next) => {
  // Known operational error
  if (err instanceof ApiError) {
    const fallbackCode = err.statusCode === 404 ? "NOT_FOUND"
      : err.statusCode === 403 ? "FORBIDDEN"
        : err.statusCode === 429 ? "RATE_LIMITED"
          : err.statusCode === 409 ? "INVALID_TRANSITION"
            : "VALIDATION_ERROR";
    const retryEvidence = err.retryAfterAt || err.errors?.find((item) => item?.retryAfterAt != null || item?.retryAfter != null);
    const retryAfter = err.statusCode === 429 ? boundedRetryAfter(retryEvidence?.retryAfterAt || retryEvidence?.retryAfter || retryEvidence) : null;
    if (retryAfter) res.setHeader("Retry-After", retryAfter);
    return res.status(err.statusCode).json({
      success: false,
      code: err.code || fallbackCode,
      retryable: Boolean(err.retryable),
      message: err.message,
      errors: logger.maskSensitive(err.errors),
      correlationId: req.correlationId || res.locals.correlationId || null,
    });
  }

  // Prisma unique constraint violation
  if (err.code === "P2002") {
    return res.status(409).json({
      success: false,
      message: `${err.meta?.target?.join(", ")} already exists`,
    });
  }

  // Prisma record not found
  if (err.code === "P2025") {
    return res.status(404).json({
      success: false,
      message: "Record not found",
    });
  }

  // Unknown error — log it but don't leak details to client
  logger.error("Unhandled error", logger.maskSensitive({
    name: err?.name,
    code: err?.code,
    message: String(err?.message || "Unhandled failure").slice(0, 500),
  }));

  return res.status(500).json({
    success: false,
    message: "Internal server error",
    correlationId: req.correlationId || res.locals.correlationId || null,
  });
};

// Handle 404 — route not found
const notFound = (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
};

module.exports = { boundedRetryAfter, errorHandler, notFound };
