const os = require("os");
const path = require("path");
const {
  MediaStorageConfigurationError,
} = require("./media-storage.errors");

const ROOT = path.resolve(__dirname, "../../../../../..");
const MiB = 1024 * 1024;

function normalizeMode(value) {
  const normalized = String(value || "development").trim().toLowerCase();
  if (["dev", "development", "local"].includes(normalized)) return "development";
  if (["test", "ci"].includes(normalized)) return "test";
  if (["stage", "staging"].includes(normalized)) return "staging";
  if (["prod", "production"].includes(normalized)) return "production";
  throw new MediaStorageConfigurationError("Social media storage environment is invalid", {
    variable: "NODE_ENV",
    reasonCode: "SOCIAL_ENV_INVALID",
  });
}

function environmentMode({ env = process.env, mode } = {}) {
  return normalizeMode(
    mode ||
      env.SOCIAL_OPERATIONS_ENV ||
      env.APP_ENV ||
      env.NODE_ENV ||
      "development",
  );
}

function splitCsv(value, fallback) {
  const parsed = String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}

function parsePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new MediaStorageConfigurationError("Social media storage numeric setting is invalid", {
      reasonCode: "SOCIAL_MEDIA_STORAGE_NUMBER_INVALID",
    });
  }
  return parsed;
}

function normalizeProvider(provider) {
  const normalized = String(provider || "").trim().toLowerCase();
  if (["local", "filesystem", "file"].includes(normalized)) return "local";
  if (normalized === "cloudinary") return "cloudinary";
  throw new MediaStorageConfigurationError("Social media storage provider is invalid", {
    variable: "SOCIAL_MEDIA_STORAGE_PROVIDER",
    reasonCode: "SOCIAL_MEDIA_STORAGE_PROVIDER_INVALID",
  });
}

function defaultStorageProvider(mode) {
  return ["staging", "production"].includes(mode) ? "cloudinary" : "local";
}

function defaultLocalDir(mode) {
  return path.join(os.tmpdir(), "cosmicforge-social-operations-media", mode);
}

function resolveMediaStorageConfig({ env = process.env, mode, overrides = {} } = {}) {
  const resolvedMode = environmentMode({ env, mode });
  const provider = normalizeProvider(
    overrides.provider || env.SOCIAL_MEDIA_STORAGE_PROVIDER || defaultStorageProvider(resolvedMode),
  );
  return {
    mode: resolvedMode,
    provider,
    repoRoot: ROOT,
    localStorageDir: path.resolve(
      overrides.localStorageDir ||
        env.SOCIAL_LOCAL_MEDIA_STORAGE_DIR ||
        defaultLocalDir(resolvedMode),
    ),
    cloudinaryCloudName: overrides.cloudinaryCloudName || env.CLOUDINARY_CLOUD_NAME,
    cloudinaryApiKey: overrides.cloudinaryApiKey || env.CLOUDINARY_API_KEY,
    cloudinaryApiSecret: overrides.cloudinaryApiSecret || env.CLOUDINARY_API_SECRET,
    cloudinaryFolderPrefix:
      overrides.cloudinaryFolderPrefix ||
      env.SOCIAL_CLOUDINARY_FOLDER_PREFIX ||
      `cosmicforge/social-operations/${resolvedMode}`,
    uploadTimeoutMs: parsePositiveInt(
      overrides.uploadTimeoutMs || env.SOCIAL_MEDIA_UPLOAD_TIMEOUT_MS,
      10_000,
      { min: 500, max: 120_000 },
    ),
    imageMaxBytes: parsePositiveInt(
      overrides.imageMaxBytes || env.SOCIAL_MEDIA_IMAGE_MAX_BYTES,
      10 * MiB,
      { min: 1, max: 100 * MiB },
    ),
    videoMaxBytes: parsePositiveInt(
      overrides.videoMaxBytes || env.SOCIAL_MEDIA_VIDEO_MAX_BYTES,
      30 * MiB,
      { min: 1, max: 500 * MiB },
    ),
    allowedImageMimeTypes: splitCsv(
      overrides.allowedImageMimeTypes || env.SOCIAL_MEDIA_ALLOWED_IMAGE_MIME_TYPES,
      ["image/jpeg", "image/png", "image/webp", "image/gif"],
    ),
    allowedVideoMimeTypes: splitCsv(
      overrides.allowedVideoMimeTypes || env.SOCIAL_MEDIA_ALLOWED_VIDEO_MIME_TYPES,
      ["video/mp4", "video/quicktime", "video/webm"],
    ),
  };
}

function validateMediaStorageConfig(config) {
  if (["staging", "production"].includes(config.mode) && config.provider === "local") {
    throw new MediaStorageConfigurationError("Local Social media storage is not allowed", {
      variable: "SOCIAL_MEDIA_STORAGE_PROVIDER",
      reasonCode: "SOCIAL_MEDIA_LOCAL_STORAGE_FORBIDDEN",
    });
  }
  if (config.provider === "cloudinary") {
    const missing = [
      ["CLOUDINARY_CLOUD_NAME", config.cloudinaryCloudName],
      ["CLOUDINARY_API_KEY", config.cloudinaryApiKey],
      ["CLOUDINARY_API_SECRET", config.cloudinaryApiSecret],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length) {
      throw new MediaStorageConfigurationError("Cloudinary Social media storage is incomplete", {
        missing,
        reasonCode: "SOCIAL_MEDIA_CLOUDINARY_CONFIG_MISSING",
      });
    }
  }
  return config;
}

module.exports = {
  ROOT,
  MiB,
  normalizeMode,
  environmentMode,
  resolveMediaStorageConfig,
  validateMediaStorageConfig,
};
