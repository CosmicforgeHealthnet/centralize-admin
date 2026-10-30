const defaultPassport = require("passport");
const { Strategy: GoogleStrategy } = require("passport-google-oauth20");
const { prisma } = require("./database");
const ApiError = require("../utils/ApiError");

const GOOGLE_STRATEGY_NAME = "google";
const REQUIRED_GOOGLE_ENV = Object.freeze([
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALLBACK_URL",
]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SENSITIVE_PARAM_PATTERN = /(?:code|token|secret|key|credential)/i;

let defaultStatus = {
  configured: false,
  reasonCode: "GOOGLE_OAUTH_NOT_CONFIGURED",
};

class GoogleOAuthConfigurationError extends Error {
  constructor(reasonCode, issues) {
    super(`Google OAuth configuration is invalid: ${reasonCode}`);
    this.name = "GoogleOAuthConfigurationError";
    this.reasonCode = reasonCode;
    this.issues = issues;
    Error.captureStackTrace(this, this.constructor);
  }
}

function present(value) {
  return value !== undefined && String(value).trim() !== "";
}

function modeFromEnv(env) {
  return String(env.APP_ENV || env.NODE_ENV || "development").trim().toLowerCase();
}

function isStagingLike(mode) {
  return mode === "staging" || mode === "production";
}

function isLoopback(hostname) {
  return LOCAL_HOSTS.has(String(hostname || "").toLowerCase());
}

function safeCallbackSummary(parsed) {
  if (!parsed) return null;
  return {
    protocol: parsed.protocol.replace(/:$/, ""),
    host: parsed.hostname,
    pathname: parsed.pathname,
    hasQuery: parsed.searchParams.size > 0,
  };
}

function callbackIssue(reasonCode) {
  return { variable: "GOOGLE_CALLBACK_URL", reasonCode };
}

function validateCallbackUrl(rawCallbackUrl, mode) {
  let parsed;
  try {
    parsed = new URL(rawCallbackUrl);
  } catch {
    return { issue: callbackIssue("MALFORMED_URL") };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { issue: callbackIssue("HTTP_SCHEME_REQUIRED") };
  }

  if (String(rawCallbackUrl).includes("*")) {
    return { issue: callbackIssue("WILDCARD_FORBIDDEN") };
  }

  if (parsed.hash) {
    return { issue: callbackIssue("URL_FRAGMENT_FORBIDDEN") };
  }

  if (parsed.searchParams.size > 0) {
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_PARAM_PATTERN.test(key)) {
        return { issue: callbackIssue("SENSITIVE_QUERY_PARAM_FORBIDDEN") };
      }
    }
  }

  if (isStagingLike(mode)) {
    if (parsed.protocol !== "https:") {
      return { issue: callbackIssue("HTTPS_REQUIRED") };
    }
    if (isLoopback(parsed.hostname)) {
      return { issue: callbackIssue("LOCALHOST_FORBIDDEN") };
    }
  } else if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
    return { issue: callbackIssue("HTTPS_REQUIRED") };
  }

  return { parsed };
}

function buildConfigError(reasonCode, issues) {
  return new GoogleOAuthConfigurationError(reasonCode, issues);
}

function resolveGoogleOAuthConfig({ env = process.env, mode = modeFromEnv(env) } = {}) {
  const clientIdPresent = present(env.GOOGLE_CLIENT_ID);
  const clientSecretPresent = present(env.GOOGLE_CLIENT_SECRET);
  const callbackPresent = present(env.GOOGLE_CALLBACK_URL);

  if (!clientIdPresent && !clientSecretPresent && !callbackPresent) {
    return {
      configured: false,
      reasonCode: "GOOGLE_OAUTH_NOT_CONFIGURED",
      required: false,
      mode,
    };
  }

  const issues = [];
  if (!clientIdPresent) issues.push({ variable: "GOOGLE_CLIENT_ID", reasonCode: "REQUIRED" });
  if (!clientSecretPresent) issues.push({ variable: "GOOGLE_CLIENT_SECRET", reasonCode: "REQUIRED" });
  if (!callbackPresent) issues.push({ variable: "GOOGLE_CALLBACK_URL", reasonCode: "REQUIRED" });

  if (issues.length) {
    throw buildConfigError("GOOGLE_OAUTH_CONFIGURATION_INCOMPLETE", issues);
  }

  const callback = validateCallbackUrl(env.GOOGLE_CALLBACK_URL, mode);
  if (callback.issue) {
    throw buildConfigError("GOOGLE_OAUTH_CALLBACK_INVALID", [callback.issue]);
  }

  return {
    configured: true,
    reasonCode: "GOOGLE_OAUTH_CONFIGURED",
    mode,
    clientID: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    callbackURL: env.GOOGLE_CALLBACK_URL,
    callback: safeCallbackSummary(callback.parsed),
  };
}

function getStrategy(passportInstance, name = GOOGLE_STRATEGY_NAME) {
  if (!passportInstance || typeof passportInstance._strategy !== "function") {
    return null;
  }
  return passportInstance._strategy(name);
}

function safeLogInfo(logger, message, metadata) {
  if (!logger || typeof logger.info !== "function") return;
  logger.info(`${message}: ${JSON.stringify(metadata)}`);
}

function buildVerifyCallback(db) {
  return async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value;

      if (!email) {
        return done(new ApiError(401, "No email returned from Google"), null);
      }

      let user = await db.adminUser.findFirst({
        where: {
          OR: [{ googleId: profile.id }, { email }],
        },
      });

      if (!user) {
        return done(
          new ApiError(403, "No admin account found for this Google account"),
          null,
        );
      }

      if (user.status === "INACTIVE") {
        return done(
          new ApiError(403, "Account deactivated. Contact your administrator"),
          null,
        );
      }

      if (user.status === "LOCKED") {
        return done(
          new ApiError(423, "Account is locked. Contact your administrator"),
          null,
        );
      }

      if (!user.googleId) {
        user = await db.adminUser.update({
          where: { id: user.id },
          data: { googleId: profile.id },
        });
      }

      return done(null, user);
    } catch (error) {
      return done(error, null);
    }
  };
}

function configureGoogleStrategy({
  passport = defaultPassport,
  env = process.env,
  logger,
  Strategy = GoogleStrategy,
  db = prisma,
} = {}) {
  const config = resolveGoogleOAuthConfig({ env });

  if (!config.configured) {
    if (passport === defaultPassport) defaultStatus = config;
    safeLogInfo(logger, "[Auth] Google OAuth unavailable", {
      reasonCode: config.reasonCode,
      mode: config.mode,
    });
    return config;
  }

  if (getStrategy(passport)) {
    const status = {
      configured: true,
      reasonCode: "GOOGLE_OAUTH_CONFIGURED",
      alreadyRegistered: true,
      mode: config.mode,
      callback: config.callback,
    };
    if (passport === defaultPassport) defaultStatus = status;
    return status;
  }

  passport.use(
    GOOGLE_STRATEGY_NAME,
    new Strategy(
      {
        clientID: config.clientID,
        clientSecret: config.clientSecret,
        callbackURL: config.callbackURL,
        scope: ["profile", "email"],
      },
      buildVerifyCallback(db),
    ),
  );

  const status = {
    configured: true,
    reasonCode: "GOOGLE_OAUTH_CONFIGURED",
    alreadyRegistered: false,
    mode: config.mode,
    callback: config.callback,
  };
  if (passport === defaultPassport) defaultStatus = status;
  safeLogInfo(logger, "[Auth] Google OAuth strategy registered", {
    mode: status.mode,
    callback: status.callback,
  });
  return status;
}

function getGoogleOAuthStatus({ passport = defaultPassport } = {}) {
  if (getStrategy(passport)) {
    return {
      ...defaultStatus,
      configured: true,
      reasonCode: "GOOGLE_OAUTH_CONFIGURED",
    };
  }
  return defaultStatus;
}

function isGoogleOAuthConfigured({ passport = defaultPassport } = {}) {
  return Boolean(getStrategy(passport));
}

function requireGoogleOAuthConfigured(req, res, next) {
  if (isGoogleOAuthConfigured()) return next();
  return res.status(503).json({
    success: false,
    code: "GOOGLE_OAUTH_NOT_CONFIGURED",
    message: "Google authentication is currently unavailable.",
  });
}

module.exports = defaultPassport;
module.exports.GOOGLE_STRATEGY_NAME = GOOGLE_STRATEGY_NAME;
module.exports.REQUIRED_GOOGLE_ENV = REQUIRED_GOOGLE_ENV;
module.exports.GoogleOAuthConfigurationError = GoogleOAuthConfigurationError;
module.exports.configureGoogleStrategy = configureGoogleStrategy;
module.exports.getGoogleOAuthStatus = getGoogleOAuthStatus;
module.exports.isGoogleOAuthConfigured = isGoogleOAuthConfigured;
module.exports.requireGoogleOAuthConfigured = requireGoogleOAuthConfigured;
module.exports.resolveGoogleOAuthConfig = resolveGoogleOAuthConfig;
module.exports.validateCallbackUrl = validateCallbackUrl;
