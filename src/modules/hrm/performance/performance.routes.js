const express = require("express");
const {
  requireTier,
  requireSection,
} = require("../../../shared/middlewares/rbac.middleware");
const performanceController = require("./performance.controller");
const { eventCreateSchema, validateBody } = require("./performance.validator");

const router = express.Router();

router.get(
  "/stats",
  requireTier("ADMIN"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getStats,
);
router.get(
  "/score",
  requireTier("ADMIN"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getScore,
);
router.get(
  "/chart",
  requireTier("ADMIN"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getChart,
);
router.get(
  "/tasks",
  requireTier("ADMIN"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getTasks,
);
router.get(
  "/teams",
  requireTier("ADMIN"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getTeams,
);
router.get(
  "/projects",
  requireTier("ADMIN"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getProjects,
);
router.get(
  "/employees",
  requireTier("ADMIN"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getEmployees,
);
router.get(
  "/events",
  requireTier("ADMIN"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getEvents,
);
router.post(
  "/events",
  requireTier("EXECUTIVE"),
  requireSection("hrm", "performance", "EDIT"),
  validateBody(eventCreateSchema),
  performanceController.createEvent,
);
router.get(
  "/events/:id",
  requireTier("ADMIN"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getEvent,
);

module.exports = router;
