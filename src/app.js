const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
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
} = {}) {
  const googleOAuth = googleStrategyRegistrar({
    passport: passportInstance,
    env,
    logger: appLogger,
  });
  const cloudinaryStatus = cloudinaryConfigurator({ env, logger: appLogger });
  const routes = loadRoutes();
  const app = express();

  app.locals.googleOAuth = googleOAuth;
  app.locals.cloudinary = cloudinaryStatus;

  app.use(helmet());
  app.use(requestContext);
  app.set("trust proxy", 1);

  const allowedOrigins = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
    : ["http://localhost:3000"];

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        appLogger.warn(`Blocked CORS request from: ${origin}`);
        callback(new Error("Not allowed by CORS"));
      },
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
      credentials: true,
      optionsSuccessStatus: 200,
    }),
  );

  app.options("/{*splat}", cors());

  const jsonBodyParser = express.json({ limit: "10kb" });
  const socialWebhookRawParser = express.raw({ type: "*/*", limit: "10kb" });

  app.use((req, res, next) => {
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
    app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
  }

  app.use(globalLimiter);

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

  app.use("/{*splat}", notFound);
  app.use(errorHandler);

  return app;
}

const app = createApp();

module.exports = app;
module.exports.createApp = createApp;
