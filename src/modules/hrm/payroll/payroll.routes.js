const express = require("express");
const { requireTier } = require("../../../shared/middlewares/rbac.middleware");
const payrollController = require("./payroll.controller");
const { payrollUpdateSchema, validateBody } = require("./payroll.validator");

const router = express.Router();

router.get("/stats", requireTier("EXECUTIVE"), payrollController.getStats);
router.get("/payslips", requireTier("EXECUTIVE"), payrollController.listPayslips);
router.get("/receipts", requireTier("EXECUTIVE"), payrollController.listReceipts);
router.get("/deductions", requireTier("EXECUTIVE"), payrollController.listDeductions);
router.get("/invoices", requireTier("EXECUTIVE"), payrollController.listInvoices);
router.get("/report/download", requireTier("EXECUTIVE"), payrollController.downloadReport);
router.get("/", requireTier("EXECUTIVE"), payrollController.listPayroll);
router.get(
  "/:employeeId/payslips/:id",
  requireTier("EXECUTIVE"),
  payrollController.getPayslipDetail,
);
router.get(
  "/:employeeId/payslips",
  requireTier("EXECUTIVE"),
  payrollController.getEmployeePayslips,
);
router.get(
  "/:employeeId/receipts",
  requireTier("EXECUTIVE"),
  payrollController.getEmployeeReceipts,
);
router.get(
  "/:employeeId/deductions",
  requireTier("EXECUTIVE"),
  payrollController.getEmployeeDeductions,
);
router.get(
  "/:employeeId/invoices",
  requireTier("EXECUTIVE"),
  payrollController.getEmployeeInvoices,
);
router.get("/:employeeId", requireTier("EXECUTIVE"), payrollController.getEmployeePayroll);
router.put(
  "/:employeeId",
  requireTier("EXECUTIVE"),
  validateBody(payrollUpdateSchema),
  payrollController.updatePayroll,
);

module.exports = router;
