const express = require("express");
const {
  requireTier,
  requireSection,
  requireTierOrDepartment,
} = require("../../../shared/middlewares/rbac.middleware");
const performanceController = require("./performance.controller");
const { eventCreateSchema, validateBody } = require("./performance.validator");

const router = express.Router();

router.get(
  "/stats",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getStats,
);
router.get(
  "/score",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getScore,
);
router.get(
  "/chart",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getChart,
);
router.get(
  "/tasks",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getTasks,
);
router.get(
  "/teams",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getTeams,
);
router.get(
  "/projects",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getProjects,
);
router.get(
  "/employees",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getEmployees,
);
router.get(
  "/events",
  requireTierOrDepartment("ADMIN", "hrm"),
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
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "performance", "VIEW"),
  performanceController.getEvent,
);

module.exports = router;
