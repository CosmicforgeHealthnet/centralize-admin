const cloudinary = require("cloudinary").v2;

const REQUIRED_CLOUDINARY_ENV = Object.freeze([
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
]);

let cloudinaryStatus = {
  configured: false,
  reasonCode: "CLOUDINARY_NOT_CONFIGURED",
};

class CloudinaryConfigurationError extends Error {
  constructor(reasonCode, issues) {
    super(`Cloudinary configuration is invalid: ${reasonCode}`);
    this.name = "CloudinaryConfigurationError";
    this.reasonCode = reasonCode;
    this.issues = issues;
    Error.captureStackTrace(this, this.constructor);
  }
}

function present(value) {
  return value !== undefined && String(value).trim() !== "";
}

function resolveCloudinaryConfig({ env = process.env, requireComplete = false } = {}) {
  const missing = REQUIRED_CLOUDINARY_ENV.filter((name) => !present(env[name]));

  if (missing.length === REQUIRED_CLOUDINARY_ENV.length) {
    return {
      configured: false,
      reasonCode: "CLOUDINARY_NOT_CONFIGURED",
    };
  }

  if (missing.length) {
    const issues = missing.map((variable) => ({ variable, reasonCode: "REQUIRED" }));
    if (requireComplete) {
      throw new CloudinaryConfigurationError(
        "CLOUDINARY_CONFIGURATION_INCOMPLETE",
        issues,
      );
    }
    return {
      configured: false,
      reasonCode: "CLOUDINARY_CONFIGURATION_INCOMPLETE",
      issues,
    };
  }

  return {
    configured: true,
    reasonCode: "CLOUDINARY_CONFIGURED",
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
  };
}

function configureCloudinary({
  env = process.env,
  logger,
  sdk = cloudinary,
  requireComplete = false,
} = {}) {
  const config = resolveCloudinaryConfig({ env, requireComplete });

  if (!config.configured) {
    cloudinaryStatus = config;
    if (logger?.info) {
      logger.info(
        `[Cloudinary] SDK configuration unavailable: ${JSON.stringify({
          reasonCode: config.reasonCode,
        })}`,
      );
    }
    return config;
  }

  sdk.config({
    cloud_name: config.cloudName,
    api_key: config.apiKey,
    api_secret: config.apiSecret,
    secure: true,
  });

  cloudinaryStatus = {
    configured: true,
    reasonCode: "CLOUDINARY_CONFIGURED",
    cloudNameConfigured: true,
  };
  return cloudinaryStatus;
}

function getCloudinaryStatus() {
  return cloudinaryStatus;
}

module.exports = cloudinary;
module.exports.CloudinaryConfigurationError = CloudinaryConfigurationError;
module.exports.REQUIRED_CLOUDINARY_ENV = REQUIRED_CLOUDINARY_ENV;
module.exports.configureCloudinary = configureCloudinary;
module.exports.getCloudinaryStatus = getCloudinaryStatus;
module.exports.resolveCloudinaryConfig = resolveCloudinaryConfig;
