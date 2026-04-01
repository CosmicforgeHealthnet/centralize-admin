const express = require("express");
const router = express.Router();
const controller = require("./tickets.controller");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  requireTier,
  readOnly,
} = require("../../shared/middlewares/rbac.middleware");

router.use(authenticate);
router.use(readOnly); // EXECUTIVE can only read

// Tickets
router.get("/", requireTier("EMPLOYEE"), controller.getAllTickets);
router.get("/disputes", requireTier("EMPLOYEE"), controller.getAllDisputes);
router.get("/disputes/:id", requireTier("EMPLOYEE"), controller.getDisputeById);
router.get("/:id", requireTier("EMPLOYEE"), controller.getTicketById);

// Write operations — ADMIN and above
router.put("/:id", requireTier("ADMIN"), controller.updateTicket);
router.post("/:id/assign", requireTier("ADMIN"), controller.assignTicket);
router.post("/:id/resolve", requireTier("ADMIN"), controller.resolveTicket);
router.put("/disputes/:id", requireTier("ADMIN"), controller.updateDispute);

module.exports = router;
