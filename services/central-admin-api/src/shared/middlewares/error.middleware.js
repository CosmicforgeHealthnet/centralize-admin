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

const MAIL_PATH = /^\/api\/mail\/v1(\/|$)/;

const errorHandler = (err, req, res, next) => {
  const correlationId = req.correlationId || res.locals.correlationId || null;
  // Body parser failures are client errors, never 500s (malformed JSON,
  // oversized or unsupported bodies). No parser detail is echoed back.
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, code: "INVALID_JSON", retryable: false, message: "Request body is not valid JSON", correlationId });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ success: false, code: "PAYLOAD_TOO_LARGE", retryable: false, message: "Request body is too large", correlationId });
  }
  if (err?.type === "encoding.unsupported" || err?.type === "charset.unsupported" || err?.type === "request.aborted") {
    return res.status(400).json({ success: false, code: "INVALID_REQUEST_BODY", retryable: false, message: "Request body could not be read", correlationId });
  }
  // Known operational error
  if (err instanceof ApiError) {
    const fallbackCode = err.statusCode === 503 ? "DEPENDENCY_UNAVAILABLE"
      : err.statusCode === 404 ? "NOT_FOUND"
      : err.statusCode === 401 ? "UNAUTHENTICATED"
      : err.statusCode === 403 ? "FORBIDDEN"
        : err.statusCode === 429 ? "RATE_LIMITED"
          : err.statusCode === 409 ? "INVALID_TRANSITION"
            : "VALIDATION_ERROR";
    const retryEvidence = err.retryAfterAt || err.errors?.find((item) => item?.retryAfterAt != null || item?.retryAfter != null);
    const retryAfter = (err.statusCode === 429 || err.statusCode === 503)
      ? boundedRetryAfter(retryEvidence?.retryAfterAt || retryEvidence?.retryAfter || retryEvidence) : null;
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
    // Mail never reveals column/constraint names; other modules keep their
    // existing message (frontends display it) and gain a code.
    return res.status(409).json({
      success: false,
      code: "CONFLICT",
      message: MAIL_PATH.test(String(req.originalUrl || "")) ? "This record already exists" : `${err.meta?.target?.join(", ")} already exists`,
      correlationId,
    });
  }

  // Prisma foreign key violation: dependent records (retained history) exist
  if (err.code === "P2003") {
    return res.status(409).json({
      success: false,
      code: "INVALID_TRANSITION",
      message: "This record is still referenced by other records and cannot be removed",
      correlationId: req.correlationId || res.locals.correlationId || null,
    });
  }

  // Prisma record not found
  if (err.code === "P2025") {
    return res.status(404).json({
      success: false,
      code: "NOT_FOUND",
      message: "Record not found",
      correlationId,
    });
  }

  // Malformed identifier reached the database (e.g. a non-UUID value for a
  // UUID column): a client error, not a server failure.
  if (err.code === "P2023" || err?.name === "PrismaClientValidationError") {
    logger.warn?.("Rejected invalid query input", { code: err.code || err.name, correlationId });
    return res.status(400).json({ success: false, code: "VALIDATION_ERROR", retryable: false, message: "Invalid request parameters", correlationId });
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
