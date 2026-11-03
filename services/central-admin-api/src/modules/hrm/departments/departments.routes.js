const express = require("express");
const {
  requireTier,
  requireSection,
} = require("../../../shared/middlewares/rbac.middleware");
const departmentsController = require("./departments.controller");
const { createDepartmentDirectoryAccess, createDepartmentLeavesAccess } = require("./departments.access");

const router = express.Router();

router.get(
  "/",
  requireTier("ADMIN"),
  requireSection("hrm", "departments", "VIEW"),
  departmentsController.getDepartments,
);
// Department Managers: their own department's leave requests (read-only).
router.get(
  "/mine/leaves",
  createDepartmentLeavesAccess(),
  departmentsController.getMyDepartmentLeaves,
);

// HR: any department. Employees: their own department ("mine").
router.get(
  "/:dept/employees",
  createDepartmentDirectoryAccess(),
  departmentsController.getDepartmentEmployees,
);

module.exports = router;
