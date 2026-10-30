const express = require("express");
const {
  requireTier,
  requireSection,
} = require("../../../shared/middlewares/rbac.middleware");
const payrollController = require("./payroll.controller");
const {
  payrollListQuerySchema,
  payrollUpdateSchema,
  validateBody,
  validateQuery,
} = require("./payroll.validator");

const router = express.Router();

router.get(
  "/stats",
  requireTier("EXECUTIVE"),
  requireSection("finance", "payroll", "VIEW"),
  payrollController.getStats,
);
router.get(
  "/payslips",
  requireTier("EXECUTIVE"),
  requireSection("finance", "payroll", "VIEW"),
  payrollController.listPayslips,
);
router.get(
  "/receipts",
  requireTier("EXECUTIVE"),
  requireSection("finance", "payroll", "VIEW"),
  payrollController.listReceipts,
);
router.get(
  "/deductions",
  requireTier("EXECUTIVE"),
  requireSection("finance", "payroll", "VIEW"),
  payrollController.listDeductions,
);
router.get(
  "/invoices",
  requireTier("EXECUTIVE"),
  requireSection("finance", "payroll", "VIEW"),
  payrollController.listInvoices,
);
router.get(
  "/report/download",
  requireTier("EXECUTIVE"),
  requireSection("finance", "payroll", "VIEW"),
  payrollController.downloadReport,
);
router.get(
  "/",
  requireTier("EXECUTIVE"),
  requireSection("finance", "payroll", "VIEW"),
  validateQuery(payrollListQuerySchema),
  payrollController.listPayroll,
);
router.get(
  "/:employeeId/payslips/:id",
  requireTier("EXECUTIVE"),
  requireSection("finance", "payroll", "VIEW"),
  payrollController.getPayslipDetail,
);
router.get(
  "/:employeeId/payslips",
  requireTier("EXECUTIVE"),
  requireSection("finance", "payroll", "VIEW"),
  payrollController.getEmployeePayslips,
);
router.get(
  "/:employeeId/receipts",
  requireTier("EXECUTIVE"),
  requireSection("finance", "payroll", "VIEW"),
  payrollController.getEmployeeReceipts,
);
router.get(
  "/:employeeId/deductions",
  requireTier("EXECUTIVE"),
  requireSection("finance", "payroll", "VIEW"),
  payrollController.getEmployeeDeductions,
);
router.get(
  "/:employeeId/invoices",
  requireTier("EXECUTIVE"),
  requireSection("finance", "payroll", "VIEW"),
  payrollController.getEmployeeInvoices,
);
router.get(
  "/:employeeId",
  requireTier("EXECUTIVE"),
  requireSection("finance", "payroll", "VIEW"),
  payrollController.getEmployeePayroll,
);
router.put(
  "/:employeeId",
  requireTier("EXECUTIVE"),
  requireSection("finance", "payroll", "EDIT"),
  validateBody(payrollUpdateSchema),
  payrollController.updatePayroll,
);

module.exports = router;
