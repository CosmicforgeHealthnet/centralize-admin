const express = require("express");
const {
  requireTier,
  requireSection,
} = require("../../../shared/middlewares/rbac.middleware");
const departmentsController = require("./departments.controller");

const router = express.Router();

router.get(
  "/",
  requireTier("ADMIN"),
  requireSection("hrm", "departments", "VIEW"),
  departmentsController.getDepartments,
);
router.get(
  "/:dept/employees",
  requireTier("ADMIN"),
  requireSection("hrm", "departments", "VIEW"),
  departmentsController.getDepartmentEmployees,
);

module.exports = router;
