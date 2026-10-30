class ApiError extends Error {
  constructor(statusCode, message, errors = []) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    this.success = false;
    const errorList = Array.isArray(errors) ? errors : [];
    this.code = errorList.find((item) => item && typeof item.code === "string")?.code;
    this.retryable = errorList.find((item) => item && typeof item.retryable === "boolean")?.retryable ?? false;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = ApiError;
