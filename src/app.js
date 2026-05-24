const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const hpp = require("hpp");
const compression = require("compression");
const cookieParser = require("cookie-parser"); // FIX #5: needed to read HttpOnly cookies
const xss = require("xss");
const passport = require("./shared/config/google.strategy");

const {
  globalLimiter,
} = require("./shared/middlewares/rateLimiter.middleware");
const {
  errorHandler,
  notFound,
} = require("./shared/middlewares/error.middleware");
const logger = require("./shared/utils/logger");

const authRoutes = require("./modules/auth").router;
const adminUsersRoutes = require("./modules/admin-users").router;
const dashboardRoutes = require("./modules/dashboard").router;
const supportRoutes = require("./modules/support").router;
const profileRouter = require("./modules/profile").router;
const notificationRoutes = require("./modules/notifications").router;
const auditRoutes = require("./modules/audit").router;
const verificationRoutes = require("./modules/verification").router;
const telemedicineRoutes = require("./modules/telemedicine").router;
const rtcRoutes = require("./modules/rtc").router;
const logisticsRoutes = require("./modules/logistics").router;
const paymentsRoutes = require("./modules/payments").router;
const notificationsServiceRoutes =
  require("./modules/notifications-service").router;
const auditServiceRoutes = require("./modules/audit-service").router;
const usersRoutes = require("./modules/users").router;
const adminOpsRoutes = require("./modules/admin-ops").router;
const analyticsRouter = require("./modules/analytics").router;
const adminSettingsRoutes = require("./modules/admin-settings").router;


const app = express();

app.use(helmet());
app.set("trust proxy", 1); // Trust first proxy (needed for correct IP behind load balancers)

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : ["http://localhost:3000"];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, Postman in dev)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      logger.warn(`Blocked CORS request from: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true, // Required for cookies to be sent cross-origin
    optionsSuccessStatus: 200,
  }),
);

app.options("/{*splat}", cors());

app.use(express.json({ limit: "10kb" })); // Hard limit on body size
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cookieParser()); // FIX #5: parse cookies before routes
app.use(passport.initialize());
app.use(hpp()); // Prevent HTTP parameter pollution
app.use(compression());

const SKIP_XSS_FIELDS = new Set([
  "password",
  "currentPassword",
  "newPassword",
  "confirmPassword",
]);

app.use((req, res, next) => {
  if (req.body && typeof req.body === "object") {
    const sanitize = (obj) => {
      for (const key in obj) {
        if (SKIP_XSS_FIELDS.has(key)) continue; // FIX #12: leave passwords untouched
        if (typeof obj[key] === "string") obj[key] = xss(obj[key]);
        else if (typeof obj[key] === "object") sanitize(obj[key]);
      }
    };
    sanitize(req.body);
  }
  next();
});

if (process.env.NODE_ENV !== "test") {
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
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

app.use("/api/auth", authRoutes);
app.use("/api/admin-users", adminUsersRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/profile", profileRouter);
app.use("/api/notifications", notificationRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/verification", verificationRoutes);
app.use("/api/telemedicine", telemedicineRoutes);
app.use("/api/rtc", rtcRoutes);
app.use("/api/logistics", logisticsRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/notifications-service", notificationsServiceRoutes);
app.use("/api/audit-service", auditServiceRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/admin/ops", adminOpsRoutes);
app.use("/api/analytics", analyticsRouter);
app.use("/api/admin-settings", adminSettingsRoutes);



app.use("/{*splat}", notFound);
app.use(errorHandler);

module.exports = app;
