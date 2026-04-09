const express = require("express");
const router = express.Router();
const controller = require("./tickets.controller");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  requireTier,
  readOnly,
} = require("../../shared/middlewares/rbac.middleware");

router.use(authenticate);
router.use(readOnly);

// ── Aggregators (put before /:id to avoid conflicts) ──
router.get("/stats", requireTier("EMPLOYEE"), controller.getSupportStats);
router.get("/all", requireTier("EMPLOYEE"), controller.getAllTicketsMerged);

// ── Account Tickets ───────────────────────────────────
router.get("/", requireTier("EMPLOYEE"), controller.getAllTickets);
router.get("/:id", requireTier("EMPLOYEE"), controller.getTicketById);
router.put("/:id", requireTier("ADMIN"), controller.updateTicket);
router.post("/:id/assign", requireTier("ADMIN"), controller.assignTicket);
router.post("/:id/resolve", requireTier("ADMIN"), controller.resolveTicket);

// ── Disputes ──────────────────────────────────────────
router.get("/disputes", requireTier("EMPLOYEE"), controller.getAllDisputes);
router.get("/disputes/:id", requireTier("EMPLOYEE"), controller.getDisputeById);
router.put("/disputes/:id", requireTier("ADMIN"), controller.updateDispute);

// ── Insurance ─────────────────────────────────────────
router.get(
  "/insurance",
  requireTier("EMPLOYEE"),
  controller.getAllInsuranceTickets,
);
router.get(
  "/insurance/:id",
  requireTier("EMPLOYEE"),
  controller.getInsuranceTicketById,
);
router.put(
  "/insurance/:id",
  requireTier("ADMIN"),
  controller.updateInsuranceTicket,
);

// ── Reports ───────────────────────────────────────────
router.get("/reports", requireTier("EMPLOYEE"), controller.getAllReports);
router.get("/reports/:id", requireTier("EMPLOYEE"), controller.getReportById);
router.put("/reports/:id", requireTier("ADMIN"), controller.updateReport);

module.exports = router;
