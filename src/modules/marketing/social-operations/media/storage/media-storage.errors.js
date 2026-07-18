class MediaStorageError extends Error {
  constructor(message, {
    code = "SOCIAL_MEDIA_STORAGE_ERROR",
    statusCode = 500,
    retryable = false,
    details = {},
  } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

class MediaStorageConfigurationError extends MediaStorageError {
  constructor(message, details = {}) {
    super(message, {
      code: "SOCIAL_MEDIA_STORAGE_CONFIG_INVALID",
      statusCode: 500,
      retryable: false,
      details,
    });
  }
}

class MediaStorageValidationError extends MediaStorageError {
  constructor(message, details = {}) {
    super(message, {
      code: "SOCIAL_MEDIA_STORAGE_VALIDATION_FAILED",
      statusCode: 400,
      retryable: false,
      details,
    });
  }
}

class MediaStorageTransientError extends MediaStorageError {
  constructor(message, details = {}) {
    super(message, {
      code: details.code || "SOCIAL_MEDIA_STORAGE_TRANSIENT",
      statusCode: 503,
      retryable: true,
      details,
    });
  }
}

class MediaStoragePermanentError extends MediaStorageError {
  constructor(message, details = {}) {
    super(message, {
      code: details.code || "SOCIAL_MEDIA_STORAGE_PERMANENT",
      statusCode: 502,
      retryable: false,
      details,
    });
  }
}

module.exports = {
  MediaStorageError,
  MediaStorageConfigurationError,
  MediaStorageValidationError,
  MediaStorageTransientError,
  MediaStoragePermanentError,
};
