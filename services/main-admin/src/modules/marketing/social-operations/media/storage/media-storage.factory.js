const {
  resolveMediaStorageConfig,
  validateMediaStorageConfig,
} = require("./media-storage.config");
const {
  assertMediaStorageAdapter,
} = require("./media-storage.interface");
const {
  LocalMediaStorageAdapter,
} = require("./local-media-storage.adapter");
const {
  CloudinaryMediaStorageAdapter,
} = require("./cloudinary-media-storage.adapter");

function createMediaStorageAdapter({ env, mode, overrides, cloudinarySdk, fsModule, randomBytes } = {}) {
  const config = validateMediaStorageConfig(resolveMediaStorageConfig({ env, mode, overrides }));
  if (config.provider === "local") {
    return assertMediaStorageAdapter(
      new LocalMediaStorageAdapter({ config, fsModule, randomBytes }),
    );
  }
  if (config.provider === "cloudinary") {
    return assertMediaStorageAdapter(
      new CloudinaryMediaStorageAdapter({ config, cloudinarySdk }),
    );
  }
  throw new Error("Unsupported Social media storage provider");
}

module.exports = {
  createMediaStorageAdapter,
};
