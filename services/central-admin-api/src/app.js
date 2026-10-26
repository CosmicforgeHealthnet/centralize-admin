const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const { createOriginPolicy } = require("./shared/config/cors-origins");
const morgan = require("morgan");
const hpp = require("hpp");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const xss = require("xss");
const passport = require("./shared/config/google.strategy");
const cloudinary = require("./shared/config/cloudinary");

const {
  globalLimiter,
} = require("./shared/middlewares/rateLimiter.middleware");
const {
  errorHandler,
  notFound,
} = require("./shared/middlewares/error.middleware");
const logger = require("./shared/utils/logger");
const { requestContext } = require("./shared/middlewares/request-context.middleware");
const { authenticate } = require("./shared/middlewares/auth.middleware");
const { createMailJsonParsing } = require("./modules/mail/http/body-limits");

const MAIL_API_PREFIX = "/api/mail/v1";
const MAIL_WEBHOOK_PATH = `${MAIL_API_PREFIX}/webhooks/resend`;

// Raw-body Mail endpoints (signature checks need the exact bytes).
const MAIL_BRAND_WEBHOOK_PATH = new RegExp(`^${MAIL_WEBHOOK_PATH.replace(/\//g, "\\/")}\\/brand\\/[a-z0-9][a-z0-9-]{0,63}$`);
const MAIL_INTEGRATION_PATH = `${MAIL_API_PREFIX}/integrations/v1/events`;
function isMailRawPath(url) {
  const path = String(url || "").split("?")[0];
  return path === MAIL_WEBHOOK_PATH || path === MAIL_INTEGRATION_PATH || MAIL_BRAND_WEBHOOK_PATH.test(path);
}

const REDACTED_QUERY_KEYS = /^(q|query|token|code|state|access_token|refresh_token|id_token|signature|sig|key|password|email)$/i;
const MAIL_TOKEN_PATH = new RegExp(`^(${MAIL_API_PREFIX.replace(/\//g, "\\/")}\\/public\\/(?:unsubscribe|consent\\/confirm|preferences)\\/)[^/?]+`);

// Logged form of a request URL: capability tokens in Mail public paths and
// sensitive query values are replaced, the rest kept for diagnosis.
function redactLoggedUrl(url) {
  const raw = String(url || "");
  const [path, query] = raw.split(/\?(.*)/s, 2);
  const safePath = path.replace(MAIL_TOKEN_PATH, "$1[redacted]");
  if (!query) return safePath;
  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) if (REDACTED_QUERY_KEYS.test(key)) params.set(key, "[redacted]");
  return `${safePath}?${params.toString()}`;
}

function loadMailBodyMaxBytes(env) {
  try {
    return require("./modules/mail").loadMailConfig(env).limits.bodyMaxBytes;
  } catch {
    return 1024 * 1024;
  }
}

function isMailPath(url) {
  const path = String(url || "").split("?")[0];
  return path === MAIL_API_PREFIX || path.startsWith(`${MAIL_API_PREFIX}/`);
}

function loadRoutes() {
  return {
    authRoutes: require("./modules/auth").router,
    adminUsersRoutes: require("./modules/admin-users").router,
    dashboardRoutes: require("./modules/dashboard").router,
    supportRoutes: require("./modules/support").router,
    profileRouter: require("./modules/profile").router,
    notificationRoutes: require("./modules/notifications").router,
    auditRoutes: require("./modules/audit").router,
    verificationRoutes: require("./modules/verification").router,
    telemedicineRoutes: require("./modules/telemedicine").router,
    rtcRoutes: require("./modules/rtc").router,
    logisticsRoutes: require("./modules/logistics").router,
    paymentsRoutes: require("./modules/payments").router,
    notificationsServiceRoutes: require("./modules/notifications-service").router,
    auditServiceRoutes: require("./modules/audit-service").router,
    usersRoutes: require("./modules/users").router,
    adminOpsRoutes: require("./modules/admin-ops").router,
    analyticsRouter: require("./modules/analytics").router,
    adminSettingsRoutes: require("./modules/admin-settings").router,
    healthnetRoutes: require("./modules/healthnet").router,
    marketingRoutes: require("./modules/marketing").router,
    socialOperationsRoutes: require("./modules/marketing/social-operations").router,
    marketingIntelligenceInternalRoutes: require("./modules/marketing/intelligence/internal.routes"),
    marketingIntelligenceRoutes: require("./modules/marketing/intelligence").router,
    advertisingExecutionRoutes: require("./modules/marketing/advertising-execution").router,
    hrmRoutes: require("./modules/hrm").router,
  };
}

function createApp({
  env = process.env,
  passportInstance = passport,
  appLogger = logger,
  googleStrategyRegistrar = passport.configureGoogleStrategy,
  cloudinaryConfigurator = cloudinary.configureCloudinary,
  mailHttpFactory = (options) => require("./modules/mail").createMailHttp(options),
} = {}) {
  const googleOAuth = googleStrategyRegistrar({
    passport: passportInstance,
    env,
    logger: appLogger,
  });
  const cloudinaryStatus = cloudinaryConfigurator({ env, logger: appLogger });
  const routes = loadRoutes();
  const mailHttp = mailHttpFactory({ env, authenticate });
  const app = express();

  app.locals.googleOAuth = googleOAuth;
  app.locals.cloudinary = cloudinaryStatus;
  app.locals.mail = mailHttp.application;

  app.use(helmet());
  app.use(requestContext);
  app.set("trust proxy", 1);

  const isAllowedOrigin = createOriginPolicy(env);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (isAllowedOrigin(origin)) return callback(null, true);
      appLogger.warn(`Blocked CORS request from: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID", "Idempotency-Key", "X-CSRF-Token"],
    credentials: true,
    optionsSuccessStatus: 200,
  }),
);


  const jsonBodyParser = express.json({ limit: "10kb" });
  const socialWebhookRawParser = express.raw({ type: "*/*", limit: "10kb" });
  // Mail: provider webhooks need the exact raw bytes for signature checks;
  // mail bodies need a larger (bounded) JSON limit than the 10kb default.
  const mailWebhookRawParser = express.raw({ type: "*/*", limit: "256kb" });
  // §17.1: route-specific Mail limits (64 KB by default; drafts, signatures
  // and marketing authoring up to MAIL_BODY_MAX_BYTES) + JSON shape checks.
  const mailJsonParser = createMailJsonParsing({ bodyMaxBytes: mailHttp.application?.config?.limits?.bodyMaxBytes ?? loadMailBodyMaxBytes(env), prefix: MAIL_API_PREFIX });

  app.use((req, res, next) => {
    if (req.method === "POST" && isMailRawPath(req.originalUrl)) {
      return mailWebhookRawParser(req, res, (error) => {
        if (error) return next(error);
        req.rawBody = Buffer.isBuffer(req.body) ? Buffer.from(req.body) : Buffer.alloc(0);
        req.body = {};
        return next();
      });
    }
    if (isMailPath(req.originalUrl)) return mailJsonParser(req, res, next);
    if (
      req.method === "POST" &&
      req.originalUrl?.startsWith("/api/v1/marketing/social/webhooks/")
    ) {
      return socialWebhookRawParser(req, res, (error) => {
        if (error) return next(error);
        req.rawBody = Buffer.isBuffer(req.body)
          ? Buffer.from(req.body)
          : Buffer.alloc(0);
        return next();
      });
    }

    return jsonBodyParser(req, res, next);
  });
  app.use(express.urlencoded({ extended: true, limit: "10kb" }));
  app.use(cookieParser());
  app.use(passportInstance.initialize());
  app.use(hpp());
  app.use(compression());

  const skipXssFields = new Set([
    "password",
    "currentPassword",
    "newPassword",
    "confirmPassword",
  ]);

  app.use((req, res, next) => {
    // Mail performs its own context-aware sanitization (email HTML allowlist,
    // header-injection guards); global escaping would corrupt message bodies.
    if (isMailPath(req.originalUrl)) return next();
    if (req.body && typeof req.body === "object") {
      const sanitize = (obj) => {
        for (const key in obj) {
          if (skipXssFields.has(key)) continue;
          if (typeof obj[key] === "string") obj[key] = xss(obj[key]);
          else if (obj[key] && typeof obj[key] === "object") sanitize(obj[key]);
        }
      };
      sanitize(req.body);
    }
    next();
  });

  if (env.NODE_ENV !== "test") {
    // Access logs never contain capability tokens (unsubscribe / consent
    // links) or private search terms: the logged URL is redacted.
    morgan.token("safe-url", (req) => redactLoggedUrl(req.originalUrl || req.url));
    const format = env.NODE_ENV === "production"
      ? ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"'
      : ":method :safe-url :status :response-time ms - :res[content-length]";
    app.use(morgan(format));
  }

  // Raw Mail routes (provider webhooks, product integration events) have their
  // own signature auth and rate limits; the per-IP global limit would throttle
  // a provider far below them.
  app.use((req, res, next) => (req.method === "POST" && isMailRawPath(req.originalUrl) ? next() : globalLimiter(req, res, next)));

  app.get("/health", (req, res) => {
    res.json({
      success: true,
      status: "healthy",
      service: "cosmicforge-admin-api",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  app.use("/api/auth", routes.authRoutes);
  app.use("/api/admin-users", routes.adminUsersRoutes);
  app.use("/api/dashboard", routes.dashboardRoutes);
  app.use("/api/support", routes.supportRoutes);
  app.use("/api/profile", routes.profileRouter);
  app.use("/api/notifications", routes.notificationRoutes);
  app.use("/api/audit", routes.auditRoutes);
  app.use("/api/verification", routes.verificationRoutes);
  app.use("/api/telemedicine", routes.telemedicineRoutes);
  app.use("/api/rtc", routes.rtcRoutes);
  app.use("/api/logistics", routes.logisticsRoutes);
  app.use("/api/payments", routes.paymentsRoutes);
  app.use("/api/notifications-service", routes.notificationsServiceRoutes);
  app.use("/api/audit-service", routes.auditServiceRoutes);
  app.use("/api/users", routes.usersRoutes);
  app.use("/api/admin/ops", routes.adminOpsRoutes);
  app.use("/api/analytics", routes.analyticsRouter);
  app.use("/api/admin-settings", routes.adminSettingsRoutes);
  app.use("/api/healthnet", routes.healthnetRoutes);
  app.use("/api/marketing", routes.marketingRoutes);
  app.use("/api/v1/marketing/social", routes.socialOperationsRoutes);
  app.use(
    "/api/internal/marketing/intelligence",
    routes.marketingIntelligenceInternalRoutes,
  );
  app.use("/api/v1/marketing/intelligence", routes.marketingIntelligenceRoutes);
  app.use(
    "/api/v1/marketing/advertising-execution",
    routes.advertisingExecutionRoutes,
  );
  app.use("/api/hrm", routes.hrmRoutes);
  app.post(MAIL_WEBHOOK_PATH, mailHttp.webhookHandler);
  if (mailHttp.brandWebhookHandler) app.post(`${MAIL_WEBHOOK_PATH}/brand/:slug`, mailHttp.brandWebhookHandler);
  if (mailHttp.integrationHandler) app.post(MAIL_INTEGRATION_PATH, mailHttp.integrationHandler);
  app.use(MAIL_API_PREFIX, mailHttp.router);

  app.use("/{*splat}", notFound);
  app.use(errorHandler);

  return app;
}

const app = createApp();

module.exports = app;
module.exports.createApp = createApp;
module.exports.isMailRawPath = isMailRawPath;
module.exports.redactLoggedUrl = redactLoggedUrl;
