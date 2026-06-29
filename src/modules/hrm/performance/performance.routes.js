const express = require("express");
const { requireTier } = require("../../../shared/middlewares/rbac.middleware");
const performanceController = require("./performance.controller");
const { eventCreateSchema, validateBody } = require("./performance.validator");

const router = express.Router();

router.get("/stats", requireTier("ADMIN"), performanceController.getStats);
router.get("/score", requireTier("ADMIN"), performanceController.getScore);
router.get("/chart", requireTier("ADMIN"), performanceController.getChart);
router.get("/tasks", requireTier("ADMIN"), performanceController.getTasks);
router.get("/teams", requireTier("ADMIN"), performanceController.getTeams);
router.get("/projects", requireTier("ADMIN"), performanceController.getProjects);
router.get("/employees", requireTier("ADMIN"), performanceController.getEmployees);
router.get("/events", requireTier("ADMIN"), performanceController.getEvents);
router.post(
  "/events",
  requireTier("EXECUTIVE"),
  validateBody(eventCreateSchema),
  performanceController.createEvent,
);
router.get("/events/:id", requireTier("ADMIN"), performanceController.getEvent);

module.exports = router;
