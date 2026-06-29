const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const payrollService = require("./payroll.service");

const getStats = asyncHandler(async (req, res) => {
  const data = await payrollService.getStats(req.query);
  return ApiResponse.success(res, 200, "HRM payroll stats retrieved", data);
});

const listPayroll = asyncHandler(async (req, res) => {
  const data = await payrollService.listPayroll(req.query);
  return ApiResponse.success(res, 200, "HRM payroll retrieved", data);
});

const listPayslips = asyncHandler(async (req, res) => {
  const data = await payrollService.listPayslips(req.query);
  return ApiResponse.success(res, 200, "HRM payslips retrieved", data);
});

const listReceipts = asyncHandler(async (req, res) => {
  const data = await payrollService.listReceipts(req.query);
  return ApiResponse.success(res, 200, "HRM receipts retrieved", data);
});

const listDeductions = asyncHandler(async (req, res) => {
  const data = await payrollService.listDeductions(req.query);
  return ApiResponse.success(res, 200, "HRM deductions retrieved", data);
});

const listInvoices = asyncHandler(async (req, res) => {
  const data = await payrollService.listInvoices(req.query);
  return ApiResponse.success(res, 200, "HRM invoices retrieved", data);
});

const getEmployeePayroll = asyncHandler(async (req, res) => {
  const data = await payrollService.getEmployeePayroll(req.params.employeeId, req.query);
  return ApiResponse.success(res, 200, "HRM employee payroll retrieved", data);
});

const getEmployeePayslips = asyncHandler(async (req, res) => {
  const data = await payrollService.getEmployeePayslips(req.params.employeeId, req.query);
  return ApiResponse.success(res, 200, "HRM employee payslips retrieved", data);
});

const getPayslipDetail = asyncHandler(async (req, res) => {
  const data = await payrollService.getPayslipDetail(req.params.employeeId, req.params.id);
  return ApiResponse.success(res, 200, "HRM payslip retrieved", data);
});

const getEmployeeReceipts = asyncHandler(async (req, res) => {
  const data = await payrollService.getEmployeeReceipts(req.params.employeeId, req.query);
  return ApiResponse.success(res, 200, "HRM employee receipts retrieved", data);
});

const getEmployeeDeductions = asyncHandler(async (req, res) => {
  const data = await payrollService.getEmployeeDeductions(req.params.employeeId, req.query);
  return ApiResponse.success(res, 200, "HRM employee deductions retrieved", data);
});

const getEmployeeInvoices = asyncHandler(async (req, res) => {
  const data = await payrollService.getEmployeeInvoices(req.params.employeeId, req.query);
  return ApiResponse.success(res, 200, "HRM employee invoices retrieved", data);
});

const updatePayroll = asyncHandler(async (req, res) => {
  const data = await payrollService.updatePayroll({
    employeeId: req.params.employeeId,
    data: req.body,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "HRM payroll updated", data);
});

const downloadReport = asyncHandler(async (req, res) => {
  const report = await payrollService.downloadReport(req.query);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${report.filename}"`);
  return res.status(200).send(report.csv);
});

module.exports = {
  downloadReport,
  getEmployeeDeductions,
  getEmployeeInvoices,
  getEmployeePayroll,
  getEmployeePayslips,
  getEmployeeReceipts,
  getPayslipDetail,
  getStats,
  listDeductions,
  listInvoices,
  listPayroll,
  listPayslips,
  listReceipts,
  updatePayroll,
};
