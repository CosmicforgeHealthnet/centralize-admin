const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");

const errorHandler = (err, req, res, next) => {
  // Known operational error
  if (err instanceof ApiError) {
    const fallbackCode = err.statusCode === 404 ? "NOT_FOUND"
      : err.statusCode === 403 ? "FORBIDDEN"
        : err.statusCode === 429 ? "RATE_LIMITED"
          : err.statusCode === 409 ? "INVALID_TRANSITION"
            : "VALIDATION_ERROR";
    return res.status(err.statusCode).json({
      success: false,
      code: err.code || fallbackCode,
      retryable: Boolean(err.retryable),
      message: err.message,
      errors: logger.maskSensitive(err.errors),
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
  });
};

// Handle 404 — route not found
const notFound = (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
};

module.exports = { errorHandler, notFound };
