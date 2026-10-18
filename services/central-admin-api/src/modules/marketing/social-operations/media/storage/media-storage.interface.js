const crypto = require("crypto");
const path = require("path");
const {
  MediaStorageConfigurationError,
  MediaStorageValidationError,
} = require("./media-storage.errors");

const STORAGE_PROVIDER = Object.freeze({
  LOCAL: "LOCAL",
  CLOUDINARY: "CLOUDINARY",
});

const RESOURCE_TYPE = Object.freeze({
  IMAGE: "image",
  VIDEO: "video",
});

const SECRET_METADATA_KEY = /secret|signature|token|credential|password|authorization|api[_-]?key/i;

function assertMediaStorageAdapter(adapter) {
  const required = ["validateConfiguration", "upload", "delete", "getMetadata", "healthCheck"];
  for (const method of required) {
    if (typeof adapter?.[method] !== "function") {
      throw new MediaStorageConfigurationError("Social media storage adapter is incomplete", {
        method,
      });
    }
  }
  return adapter;
}

function safeSegment(value, { fallback = "asset", maxLength = 96 } = {}) {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  return cleaned || fallback;
}

function assertSafeFilename(filename) {
  if (!filename) return "media";
  const text = String(filename);
  if (path.isAbsolute(text) || text.includes("..") || /[\\/]/.test(text)) {
    throw new MediaStorageValidationError("Social media filename is not allowed", {
      reasonCode: "SOCIAL_MEDIA_FILENAME_UNSAFE",
    });
  }
  return text;
}

function fileExtensionForMime(mimeType) {
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
  };
  return map[String(mimeType || "").toLowerCase()] || ".bin";
}

function detectMimeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  const head = buffer.subarray(0, 12).toString("ascii");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  return null;
}

function resourceTypeFromMime(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.startsWith("image/")) return RESOURCE_TYPE.IMAGE;
  if (normalized.startsWith("video/")) return RESOURCE_TYPE.VIDEO;
  throw new MediaStorageValidationError("Social media MIME type is not allowed", {
    reasonCode: "SOCIAL_MEDIA_MIME_UNSUPPORTED",
    mimeType: normalized || "missing",
  });
}

function allowedMimeTypes(config) {
  return [
    ...(config.allowedImageMimeTypes || []),
    ...(config.allowedVideoMimeTypes || []),
  ];
}

function assertAllowedMimeType({ mimeType, buffer, config }) {
  const normalized = String(mimeType || "").toLowerCase();
  if (!allowedMimeTypes(config).includes(normalized)) {
    throw new MediaStorageValidationError("Social media MIME type is not allowed", {
      reasonCode: "SOCIAL_MEDIA_MIME_UNSUPPORTED",
      mimeType: normalized || "missing",
    });
  }

  const detected = detectMimeFromBuffer(buffer);
  if (detected && detected !== normalized) {
    throw new MediaStorageValidationError("Social media content type does not match the file", {
      reasonCode: "SOCIAL_MEDIA_MIME_MISMATCH",
      detectedMimeType: detected,
      declaredMimeType: normalized,
    });
  }
  return normalized;
}

function maxBytesForMime({ mimeType, config }) {
  const resourceType = resourceTypeFromMime(mimeType);
  return resourceType === RESOURCE_TYPE.VIDEO ? config.videoMaxBytes : config.imageMaxBytes;
}

function assertUploadInput(input, config) {
  if (!input?.ownerId) {
    throw new MediaStorageValidationError("Social media owner is required", {
      reasonCode: "SOCIAL_MEDIA_OWNER_REQUIRED",
    });
  }
  if (!Buffer.isBuffer(input.buffer)) {
    throw new MediaStorageValidationError("Social media upload buffer is required", {
      reasonCode: "SOCIAL_MEDIA_BUFFER_REQUIRED",
    });
  }
  const mimeType = assertAllowedMimeType({
    mimeType: input.mimeType,
    buffer: input.buffer,
    config,
  });
  const sizeBytes = Number(input.sizeBytes ?? input.buffer.length);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new MediaStorageValidationError("Social media size is invalid", {
      reasonCode: "SOCIAL_MEDIA_SIZE_INVALID",
    });
  }
  const maxBytes = maxBytesForMime({ mimeType, config });
  if (sizeBytes > maxBytes) {
    throw new MediaStorageValidationError("Social media asset is too large", {
      reasonCode: "SOCIAL_MEDIA_SIZE_LIMIT",
      maxBytes,
    });
  }
  const checksumSha256 =
    input.checksumSha256 || crypto.createHash("sha256").update(input.buffer).digest("hex");
  if (!/^[a-f0-9]{64}$/i.test(checksumSha256)) {
    throw new MediaStorageValidationError("Social media checksum is invalid", {
      reasonCode: "SOCIAL_MEDIA_CHECKSUM_INVALID",
    });
  }
  return {
    ...input,
    filename: assertSafeFilename(input.filename),
    mimeType,
    sizeBytes,
    checksumSha256: checksumSha256.toLowerCase(),
    resourceType: resourceTypeFromMime(mimeType),
  };
}

function sanitizeProviderMetadata(value) {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeProviderMetadata(item))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;
  const sanitized = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_METADATA_KEY.test(key)) continue;
    const sanitizedValue = sanitizeProviderMetadata(nested);
    if (sanitizedValue !== undefined) sanitized[key] = sanitizedValue;
  }
  return sanitized;
}

module.exports = {
  STORAGE_PROVIDER,
  RESOURCE_TYPE,
  assertMediaStorageAdapter,
  safeSegment,
  assertSafeFilename,
  fileExtensionForMime,
  detectMimeFromBuffer,
  resourceTypeFromMime,
  allowedMimeTypes,
  assertAllowedMimeType,
  maxBytesForMime,
  assertUploadInput,
  sanitizeProviderMetadata,
};
