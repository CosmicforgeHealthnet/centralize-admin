const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  MediaStorageConfigurationError,
  MediaStorageValidationError,
} = require("./media-storage.errors");
const {
  STORAGE_PROVIDER,
  assertUploadInput,
  fileExtensionForMime,
  safeSegment,
  sanitizeProviderMetadata,
} = require("./media-storage.interface");

class LocalMediaStorageAdapter {
  constructor({ config, fsModule = fs, randomBytes = crypto.randomBytes } = {}) {
    this.config = config;
    this.fs = fsModule;
    this.randomBytes = randomBytes;
  }

  validateConfiguration() {
    if (!["development", "test"].includes(this.config.mode)) {
      throw new MediaStorageConfigurationError("Local Social media storage is not allowed", {
        variable: "SOCIAL_MEDIA_STORAGE_PROVIDER",
        reasonCode: "SOCIAL_MEDIA_LOCAL_STORAGE_FORBIDDEN",
      });
    }
    const storageDir = path.resolve(this.config.localStorageDir);
    const repoRoot = path.resolve(this.config.repoRoot);
    if (storageDir === repoRoot || storageDir.startsWith(`${repoRoot}${path.sep}`)) {
      throw new MediaStorageConfigurationError(
        "Local Social media storage must be outside source-controlled directories",
        {
          variable: "SOCIAL_LOCAL_MEDIA_STORAGE_DIR",
          reasonCode: "SOCIAL_MEDIA_LOCAL_DIR_UNSAFE",
        },
      );
    }
    return true;
  }

  buildStorageKey(input) {
    const owner = safeSegment(input.ownerId, { fallback: "owner" });
    const idempotency = input.idempotencyKey
      ? safeSegment(input.idempotencyKey, { fallback: "idem", maxLength: 48 })
      : this.randomBytes(8).toString("hex");
    const extension = fileExtensionForMime(input.mimeType);
    return [
      input.resourceType,
      owner,
      `${input.checksumSha256.slice(0, 20)}-${idempotency}${extension}`,
    ].join("/");
  }

  resolveStoragePath(storageKey) {
    const normalized = String(storageKey || "").replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || normalized.includes("..")) {
      throw new MediaStorageValidationError("Social media storage key is not allowed", {
        reasonCode: "SOCIAL_MEDIA_STORAGE_KEY_UNSAFE",
      });
    }
    const base = path.resolve(this.config.localStorageDir);
    const fullPath = path.resolve(base, normalized);
    if (fullPath !== base && !fullPath.startsWith(`${base}${path.sep}`)) {
      throw new MediaStorageValidationError("Social media storage key is not allowed", {
        reasonCode: "SOCIAL_MEDIA_STORAGE_KEY_UNSAFE",
      });
    }
    return fullPath;
  }

  async upload(input) {
    this.validateConfiguration();
    const normalized = assertUploadInput(input, this.config);
    const storageKey = this.buildStorageKey(normalized);
    const targetPath = this.resolveStoragePath(storageKey);
    await this.fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await this.fs.promises.writeFile(targetPath, normalized.buffer, { flag: "w" });
    return {
      storageProvider: STORAGE_PROVIDER.LOCAL,
      storageKey,
      publicId: null,
      secureUrl: `local://social-media/${storageKey}`,
      mimeType: normalized.mimeType,
      sizeBytes: normalized.sizeBytes,
      checksumSha256: normalized.checksumSha256,
      width: null,
      height: null,
      durationSeconds: null,
      resourceType: normalized.resourceType,
      providerMetadata: sanitizeProviderMetadata({
        adapter: "local",
        resourceType: normalized.resourceType,
      }),
      complete: true,
    };
  }

  async delete({ storageKey } = {}) {
    this.validateConfiguration();
    const targetPath = this.resolveStoragePath(storageKey);
    try {
      await this.fs.promises.unlink(targetPath);
      return { deleted: true, alreadyDeleted: false };
    } catch (error) {
      if (error.code === "ENOENT") return { deleted: true, alreadyDeleted: true };
      throw error;
    }
  }

  async getMetadata({ storageKey } = {}) {
    this.validateConfiguration();
    const targetPath = this.resolveStoragePath(storageKey);
    try {
      const stat = await this.fs.promises.stat(targetPath);
      return {
        exists: true,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    } catch (error) {
      if (error.code === "ENOENT") return { exists: false };
      throw error;
    }
  }

  async healthCheck() {
    this.validateConfiguration();
    await this.fs.promises.mkdir(this.config.localStorageDir, { recursive: true });
    return {
      provider: STORAGE_PROVIDER.LOCAL,
      available: true,
      mode: this.config.mode,
    };
  }
}

module.exports = {
  LocalMediaStorageAdapter,
};
