const express = require("express");
const { authenticate } = require("../../shared/middlewares/auth.middleware");

const accountsRoutes = require("./accounts").router;
const attendanceRoutes = require("./attendance").router;
const departmentsRoutes = require("./departments").router;
const documentsRoutes = require("./documents").router;
const employeesRoutes = require("./employees").router;
const hiringRoutes = require("./hiring").router;
const leavesRoutes = require("./leaves").router;
const payrollRoutes = require("./payroll").router;
const performanceRoutes = require("./performance").router;

const router = express.Router();

router.use(authenticate);

router.use("/accounts", accountsRoutes);
router.use("/employees", employeesRoutes);
router.use("/departments", departmentsRoutes);
router.use("/attendance", attendanceRoutes);
router.use("/leaves", leavesRoutes);
router.use("/payroll", payrollRoutes);
router.use("/hiring", hiringRoutes);
router.use("/performance", performanceRoutes);
router.use("/documents", documentsRoutes);

module.exports = router;
