const crypto = require("crypto");
const {
  MediaStorageConfigurationError,
  MediaStoragePermanentError,
  MediaStorageTransientError,
} = require("./media-storage.errors");
const {
  STORAGE_PROVIDER,
  assertUploadInput,
  safeSegment,
  sanitizeProviderMetadata,
} = require("./media-storage.interface");
const {
  withReferencedTimeout,
} = require("../../utils/timeout");

function loadCloudinarySdk() {
  return require("cloudinary").v2;
}

function cloudinaryTimeoutError({ operation }) {
  return new MediaStorageTransientError("Cloudinary media storage timed out", {
    code: "SOCIAL_MEDIA_CLOUDINARY_TIMEOUT",
    operation,
  });
}

function classifyCloudinaryError(error, operation) {
  if (error instanceof MediaStorageTransientError || error instanceof MediaStoragePermanentError) {
    return error;
  }
  const status = Number(error?.http_code || error?.statusCode || error?.status || 0);
  const retryable = status === 429 || status >= 500 || /timeout|temporar|network/i.test(error?.message || "");
  const details = {
    code: retryable ? "SOCIAL_MEDIA_CLOUDINARY_TRANSIENT" : "SOCIAL_MEDIA_CLOUDINARY_PERMANENT",
    operation,
    providerStatus: status || undefined,
  };
  if (retryable) return new MediaStorageTransientError("Cloudinary media storage failed", details);
  return new MediaStoragePermanentError("Cloudinary media storage failed", details);
}

class CloudinaryMediaStorageAdapter {
  constructor({ config, cloudinarySdk = loadCloudinarySdk() } = {}) {
    this.config = config;
    this.cloudinary = cloudinarySdk;
  }

  validateConfiguration() {
    const missing = [
      ["CLOUDINARY_CLOUD_NAME", this.config.cloudinaryCloudName],
      ["CLOUDINARY_API_KEY", this.config.cloudinaryApiKey],
      ["CLOUDINARY_API_SECRET", this.config.cloudinaryApiSecret],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length) {
      throw new MediaStorageConfigurationError("Cloudinary Social media storage is incomplete", {
        missing,
        reasonCode: "SOCIAL_MEDIA_CLOUDINARY_CONFIG_MISSING",
      });
    }
    this.cloudinary.config({
      cloud_name: this.config.cloudinaryCloudName,
      api_key: this.config.cloudinaryApiKey,
      api_secret: this.config.cloudinaryApiSecret,
      secure: true,
    });
    return true;
  }

  buildPublicId(input) {
    const owner = safeSegment(input.ownerId, { fallback: "owner" });
    const idempotency = input.idempotencyKey
      ? safeSegment(input.idempotencyKey, { fallback: "idem", maxLength: 48 })
      : crypto.randomBytes(8).toString("hex");
    return `${owner}/${input.checksumSha256.slice(0, 20)}-${idempotency}`;
  }

  uploadStream(buffer, options, { signal } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stream;
      const cleanup = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const onAbort = () => {
        if (stream && typeof stream.destroy === "function") stream.destroy(signal.reason);
        finish(reject, signal?.reason || new Error("Cloudinary upload aborted"));
      };
      if (signal?.aborted) {
        finish(reject, signal.reason || new Error("Cloudinary upload aborted"));
        return;
      }
      stream = this.cloudinary.uploader.upload_stream(options, (error, result) => {
        if (error) return finish(reject, error);
        return finish(resolve, result);
      });
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      stream.end(buffer);
    });
  }

  async upload(input) {
    this.validateConfiguration();
    const normalized = assertUploadInput(input, this.config);
    const publicId = this.buildPublicId(normalized);
    const options = {
      resource_type: normalized.resourceType,
      folder: this.config.cloudinaryFolderPrefix,
      public_id: publicId,
      overwrite: Boolean(normalized.idempotencyKey),
      unique_filename: false,
      use_filename: false,
    };

    let result;
    try {
      result = await withReferencedTimeout(
        ({ signal }) => this.uploadStream(normalized.buffer, options, { signal }),
        {
          timeoutMs: this.config.uploadTimeoutMs,
          operation: "upload",
          createTimeoutError: cloudinaryTimeoutError,
        },
      );
    } catch (error) {
      throw classifyCloudinaryError(error, "upload");
    }

    if (!result?.secure_url || !result?.public_id) {
      throw new MediaStoragePermanentError("Cloudinary media storage returned an incomplete response", {
        code: "SOCIAL_MEDIA_CLOUDINARY_RESPONSE_INVALID",
        operation: "upload",
      });
    }

    return {
      storageProvider: STORAGE_PROVIDER.CLOUDINARY,
      storageKey: result.public_id,
      publicId: result.public_id,
      secureUrl: result.secure_url,
      mimeType: normalized.mimeType,
      sizeBytes: Number(result.bytes || normalized.sizeBytes),
      checksumSha256: normalized.checksumSha256,
      width: Number.isFinite(Number(result.width)) ? Number(result.width) : null,
      height: Number.isFinite(Number(result.height)) ? Number(result.height) : null,
      durationSeconds: Number.isFinite(Number(result.duration)) ? Number(result.duration) : null,
      resourceType: normalized.resourceType,
      providerMetadata: sanitizeProviderMetadata({
        publicId: result.public_id,
        version: result.version,
        resourceType: result.resource_type || normalized.resourceType,
        format: result.format,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
        duration: result.duration,
        createdAt: result.created_at,
      }),
      complete: true,
    };
  }

  async delete({ storageKey, publicId, resourceType } = {}) {
    this.validateConfiguration();
    const resolvedPublicId = publicId || storageKey;
    if (!resolvedPublicId) {
      return { deleted: true, alreadyDeleted: true };
    }
    try {
      const result = await withReferencedTimeout(
        this.cloudinary.uploader.destroy(resolvedPublicId, {
          resource_type: resourceType || "image",
          invalidate: true,
        }),
        {
          timeoutMs: this.config.uploadTimeoutMs,
          operation: "delete",
          createTimeoutError: cloudinaryTimeoutError,
        },
      );
      const code = String(result?.result || "").toLowerCase().replace(/\s+/g, "_");
      return {
        deleted: ["ok", "not_found"].includes(code),
        alreadyDeleted: code === "not_found",
      };
    } catch (error) {
      throw classifyCloudinaryError(error, "delete");
    }
  }

  async getMetadata({ storageKey, publicId, resourceType } = {}) {
    this.validateConfiguration();
    const resolvedPublicId = publicId || storageKey;
    if (!resolvedPublicId) return { exists: false };
    try {
      const result = await withReferencedTimeout(
        this.cloudinary.uploader.explicit(resolvedPublicId, {
          resource_type: resourceType || "image",
        }),
        {
          timeoutMs: this.config.uploadTimeoutMs,
          operation: "metadata",
          createTimeoutError: cloudinaryTimeoutError,
        },
      );
      return sanitizeProviderMetadata({
        exists: true,
        publicId: result.public_id,
        resourceType: result.resource_type,
        format: result.format,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
        duration: result.duration,
      });
    } catch (error) {
      throw classifyCloudinaryError(error, "metadata");
    }
  }

  async healthCheck() {
    this.validateConfiguration();
    return {
      provider: STORAGE_PROVIDER.CLOUDINARY,
      available: true,
      mode: this.config.mode,
    };
  }
}

module.exports = {
  CloudinaryMediaStorageAdapter,
  classifyCloudinaryError,
};
