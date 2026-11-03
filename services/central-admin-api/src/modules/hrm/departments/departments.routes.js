const express = require("express");
const {
  requireTier,
  requireSection,
} = require("../../../shared/middlewares/rbac.middleware");
const departmentsController = require("./departments.controller");
const { createDepartmentDirectoryAccess } = require("./departments.access");

const router = express.Router();

router.get(
  "/",
  requireTier("ADMIN"),
  requireSection("hrm", "departments", "VIEW"),
  departmentsController.getDepartments,
);
// HR: any department. Employees: their own department ("mine").
router.get(
  "/:dept/employees",
  createDepartmentDirectoryAccess(),
  departmentsController.getDepartmentEmployees,
);

module.exports = router;
