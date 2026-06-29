const { unsupportedEndpoint } = require("../hrm.utils");

const MISSING_MODELS = ["Payroll", "Payslip", "Deduction", "Receipt", "Invoice"];

class PayrollService {
  getStats() {
    unsupportedEndpoint("Payroll stats", MISSING_MODELS);
  }

  listPayroll() {
    unsupportedEndpoint("Payroll overview", MISSING_MODELS);
  }

  listPayslips() {
    unsupportedEndpoint("Global payslips", MISSING_MODELS);
  }

  listReceipts() {
    unsupportedEndpoint("Global receipts", MISSING_MODELS);
  }

  listDeductions() {
    unsupportedEndpoint("Global deductions", MISSING_MODELS);
  }

  listInvoices() {
    unsupportedEndpoint("Global invoices", MISSING_MODELS);
  }

  getEmployeePayroll() {
    unsupportedEndpoint("Employee payroll detail", MISSING_MODELS);
  }

  getEmployeePayslips() {
    unsupportedEndpoint("Employee payslips", MISSING_MODELS);
  }

  getPayslipDetail() {
    unsupportedEndpoint("Payslip detail", MISSING_MODELS);
  }

  getEmployeeReceipts() {
    unsupportedEndpoint("Employee receipts", MISSING_MODELS);
  }

  getEmployeeDeductions() {
    unsupportedEndpoint("Employee deductions", MISSING_MODELS);
  }

  getEmployeeInvoices() {
    unsupportedEndpoint("Employee invoices", MISSING_MODELS);
  }

  updatePayroll() {
    unsupportedEndpoint("Payroll update", MISSING_MODELS);
  }

  downloadReport() {
    unsupportedEndpoint("Payroll report download", MISSING_MODELS);
  }
}

module.exports = new PayrollService();
