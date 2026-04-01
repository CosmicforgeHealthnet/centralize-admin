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

// Route modules
const authRoutes = require("./modules/auth").router;
const adminUsersRoutes = require("./modules/admin-users").router;
const ticketsRoutes = require("./modules/tickets").router;
const paymentsRoutes = require("./modules/payments").router;
const appointmentsRoutes = require("./modules/appointments").router;

const app = express();

// ─────────────────────────────────────────
// SECURITY HEADERS
// ─────────────────────────────────────────
app.use(helmet());
app.set("trust proxy", 1); // Trust first proxy (needed for correct IP behind load balancers)

// ─────────────────────────────────────────
// CORS
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
// BODY PARSING & SANITIZATION
// ─────────────────────────────────────────
app.use(express.json({ limit: "10kb" })); // Hard limit on body size
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cookieParser()); // FIX #5: parse cookies before routes
app.use(passport.initialize());
app.use(hpp()); // Prevent HTTP parameter pollution
app.use(compression());

// FIX #12: XSS sanitize all incoming string values in body,
// but skip password fields — xss() encodes < > " which corrupts
// passwords containing those characters (bcrypt then hashes a mangled value).
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

// ─────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
}

// ─────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────
app.use(globalLimiter);

// ─────────────────────────────────────────
// HEALTH CHECK  (no auth needed)
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/admin-users", adminUsersRoutes);
app.use("/api/tickets", ticketsRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/appointments", appointmentsRoutes);

// ─────────────────────────────────────────
// ERROR HANDLING  (must be last)
// ─────────────────────────────────────────
app.use("/{*splat}", notFound);
app.use(errorHandler);

module.exports = app;
