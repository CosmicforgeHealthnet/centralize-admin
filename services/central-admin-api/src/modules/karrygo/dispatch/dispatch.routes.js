const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../../shared/middlewares/auth.middleware");
const {
  requireTier,
  requireSection,
} = require("../../../shared/middlewares/rbac.middleware");
const {
  listProviders,
  getProvider,
  approveVerificationStep,
  rejectVerificationStep,
  suspendProvider,
  unsuspendProvider,
  listTrips,
  getTrip,
  listBikes,
  getBike,
  approveBike,
  rejectBike,
} = require("./dispatch.controller");
const { legacyDirectDbTelemetry } = require("./legacy-telemetry");

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(legacyDirectDbTelemetry("karrygo-dispatch"));
router.use(authenticate);
router.use(requireTier("ADMIN"));
router.use(limiter);

router.get(
  "/providers",
  requireSection("operations", "dispatch", "VIEW"),
  listProviders,
);
router.get(
  "/providers/:id",
  requireSection("operations", "dispatch", "VIEW"),
  getProvider,
);
router.post(
  "/providers/:id/verify/approve",
  requireSection("operations", "dispatch", "EDIT"),
  approveVerificationStep,
);
router.post(
  "/providers/:id/verify/reject",
  requireSection("operations", "dispatch", "EDIT"),
  rejectVerificationStep,
);
router.patch(
  "/providers/:id/suspend",
  requireSection("operations", "dispatch", "EDIT"),
  suspendProvider,
);
router.patch(
  "/providers/:id/unsuspend",
  requireSection("operations", "dispatch", "EDIT"),
  unsuspendProvider,
);

router.get(
  "/trips",
  requireSection("operations", "dispatch", "VIEW"),
  listTrips,
);
router.get(
  "/trips/:id",
  requireSection("operations", "dispatch", "VIEW"),
  getTrip,
);

router.get(
  "/bikes",
  requireSection("operations", "dispatch", "VIEW"),
  listBikes,
);
router.get(
  "/bikes/:id",
  requireSection("operations", "dispatch", "VIEW"),
  getBike,
);
router.patch(
  "/bikes/:id/approve",
  requireSection("operations", "dispatch", "EDIT"),
  approveBike,
);
router.patch(
  "/bikes/:id/reject",
  requireSection("operations", "dispatch", "EDIT"),
  rejectBike,
);

module.exports = router;
