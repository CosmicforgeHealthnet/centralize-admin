const express = require("express");
const { requireTier } = require("../../../shared/middlewares/rbac.middleware");
const departmentsController = require("./departments.controller");

const router = express.Router();

router.get("/", requireTier("ADMIN"), departmentsController.getDepartments);
router.get("/:dept/employees", requireTier("ADMIN"), departmentsController.getDepartmentEmployees);

module.exports = router;
