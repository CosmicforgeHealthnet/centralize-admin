const { prisma } = require("../../../shared/config/database");
const ApiError = require("../../../shared/utils/ApiError");
const { createAuditLog } = require("../../../shared/middlewares/audit.middleware");
const {
  assertUuid,
  buildCsv,
  buildMeta,
  formatDateOnly,
  paginate,
  percentageChange,
  unsupportedEndpoint,
} = require("../hrm.utils");

const PAYROLL_STATUSES = ["PAID", "PENDING"];

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const EMPLOYEE_SELECT = {
  id: true,
  name: true,
  email: true,
  position: true,
  department: true,
  employmentType: true,
  employmentCategory: true,
  avatarUrl: true,
};

function assertPayrollSchemaSupported() {
  if (!prisma.payrollRecord) {
    unsupportedEndpoint("Payroll", ["PayrollRecord"]);
  }
}

function toNum(decimal) {
  if (decimal === null || decimal === undefined) return 0;
  return Number(decimal);
}

function normalizePayrollStatus(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const upper = String(value).trim().toUpperCase();
  if (!PAYROLL_STATUSES.includes(upper)) {
    throw new ApiError(400, "Invalid status. Use Paid or Pending.");
  }
  return upper;
}

function formatEmploymentType(user) {
  const parts = [user.employmentType, user.employmentCategory].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function currentMonthYear() {
  const now = new Date();
  return { month: now.getUTCMonth() + 1, year: now.getUTCFullYear() };
}

function previousMonthYear() {
  const now = new Date();
  let month = now.getUTCMonth(); // 0-based so this is prev month number (1-based)
  let year = now.getUTCFullYear();
  if (month === 0) { month = 12; year -= 1; }
  return { month, year };
}

function mapPayrollRow(record) {
  const employee = record.adminUser || {};
  return {
    id: record.id,
    adminUserId: record.adminUserId,
    name: employee.name || null,
    email: employee.email || null,
    employeeCode: null,
    employmentType: formatEmploymentType(employee),
    department: employee.department || null,
    designation: employee.position || null,
    netPay: toNum(record.netPay),
    status: record.status,
    avatarUrl: employee.avatarUrl || null,
    month: record.month,
    year: record.year,
  };
}

function mapPayslipRow(record) {
  const employee = record.adminUser || {};
  return {
    id: record.id,
    adminUserId: record.adminUserId,
    name: employee.name || null,
    email: employee.email || null,
    month: record.month,
    year: record.year,
    netPay: toNum(record.netPay),
    paymentMethod: record.paymentMethod || null,
    paymentDate: formatDateOnly(record.paymentDate),
  };
}

function mapDeductionRow(record) {
  const employee = record.adminUser || {};
  return {
    id: record.id,
    adminUserId: record.adminUserId,
    name: employee.name || null,
    email: employee.email || null,
    deductionName: record.name,
    amount: toNum(record.amount),
    month: record.month,
    year: record.year,
  };
}

function mapReceiptRow(record) {
  const employee = record.adminUser || {};
  return {
    id: record.id,
    adminUserId: record.adminUserId,
    name: employee.name || null,
    email: employee.email || null,
    amount: toNum(record.amount),
    description: record.description || null,
    month: record.month,
    year: record.year,
    createdAt: formatDateOnly(record.createdAt),
  };
}

function mapInvoiceRow(record) {
  const employee = record.adminUser || {};
  return {
    id: record.id,
    adminUserId: record.adminUserId,
    name: employee.name || null,
    email: employee.email || null,
    amount: toNum(record.amount),
    description: record.description || null,
    dueDate: formatDateOnly(record.dueDate),
    status: record.status,
    month: record.month,
    year: record.year,
  };
}

async function ensureEmployee(employeeId) {
  const id = assertUuid(employeeId, "employee id");
  const employee = await prisma.adminUser.findUnique({
    where: { id },
    select: EMPLOYEE_SELECT,
  });
  if (!employee) throw new ApiError(404, "Employee not found");
  return employee;
}

async function sumNetPay(where) {
  const agg = await prisma.payrollRecord.aggregate({
    where,
    _sum: { netPay: true },
  });
  return toNum(agg._sum.netPay);
}

class PayrollService {
  async getStats() {
    assertPayrollSchemaSupported();

    const current = currentMonthYear();
    const previous = previousMonthYear();

    const [
      totalEmployees,
      totalPayroll,
      pendingPayroll,
      paidPayroll,
      prevTotal,
      prevPending,
      prevPaid,
      prevEmployees,
    ] = await Promise.all([
      prisma.adminUser.count(),
      sumNetPay({ month: current.month, year: current.year }),
      sumNetPay({ month: current.month, year: current.year, status: "PENDING" }),
      sumNetPay({ month: current.month, year: current.year, status: "PAID" }),
      sumNetPay({ month: previous.month, year: previous.year }),
      sumNetPay({ month: previous.month, year: previous.year, status: "PENDING" }),
      sumNetPay({ month: previous.month, year: previous.year, status: "PAID" }),
      prisma.adminUser.count(),
    ]);

    return {
      totalEmployees,
      totalPayroll,
      pendingPayroll,
      paidPayroll,
      changes: {
        totalPayrollChange: percentageChange(totalPayroll, prevTotal),
        pendingPayrollChange: percentageChange(pendingPayroll, prevPending),
        paidPayrollChange: percentageChange(paidPayroll, prevPaid),
        employeesChange: percentageChange(totalEmployees, prevEmployees),
      },
    };
  }

  async listPayroll(query = {}) {
    assertPayrollSchemaSupported();

    const { page, limit, skip } = paginate(query, 10, 100);
    const status = normalizePayrollStatus(query.status);
    const current = currentMonthYear();

    const where = { month: current.month, year: current.year };
    if (status) where.status = status;

    const [total, records] = await Promise.all([
      prisma.payrollRecord.count({ where }),
      prisma.payrollRecord.findMany({
        where,
        include: { adminUser: { select: EMPLOYEE_SELECT } },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: records.map(mapPayrollRow),
      meta: buildMeta(total, page, limit),
    };
  }

  async listPayslips(query = {}) {
    assertPayrollSchemaSupported();

    const { page, limit, skip } = paginate(query, 10, 100);

    const [total, records] = await Promise.all([
      prisma.payslip.count(),
      prisma.payslip.findMany({
        include: { adminUser: { select: EMPLOYEE_SELECT } },
        orderBy: [{ year: "desc" }, { month: "desc" }],
        skip,
        take: limit,
      }),
    ]);

    return {
      data: records.map(mapPayslipRow),
      meta: buildMeta(total, page, limit),
    };
  }

  async listReceipts(query = {}) {
    assertPayrollSchemaSupported();

    const { page, limit, skip } = paginate(query, 10, 100);

    const [total, records] = await Promise.all([
      prisma.receipt.count(),
      prisma.receipt.findMany({
        include: { adminUser: { select: EMPLOYEE_SELECT } },
        orderBy: [{ year: "desc" }, { month: "desc" }],
        skip,
        take: limit,
      }),
    ]);

    return {
      data: records.map(mapReceiptRow),
      meta: buildMeta(total, page, limit),
    };
  }

  async listDeductions(query = {}) {
    assertPayrollSchemaSupported();

    const { page, limit, skip } = paginate(query, 10, 100);

    const [total, records] = await Promise.all([
      prisma.deduction.count(),
      prisma.deduction.findMany({
        include: { adminUser: { select: EMPLOYEE_SELECT } },
        orderBy: [{ year: "desc" }, { month: "desc" }],
        skip,
        take: limit,
      }),
    ]);

    return {
      data: records.map(mapDeductionRow),
      meta: buildMeta(total, page, limit),
    };
  }

  async listInvoices(query = {}) {
    assertPayrollSchemaSupported();

    const { page, limit, skip } = paginate(query, 10, 100);

    const [total, records] = await Promise.all([
      prisma.invoice.count(),
      prisma.invoice.findMany({
        include: { adminUser: { select: EMPLOYEE_SELECT } },
        orderBy: [{ year: "desc" }, { month: "desc" }],
        skip,
        take: limit,
      }),
    ]);

    return {
      data: records.map(mapInvoiceRow),
      meta: buildMeta(total, page, limit),
    };
  }

  async getEmployeePayroll(employeeId, query = {}) {
    assertPayrollSchemaSupported();

    const employee = await ensureEmployee(employeeId);
    const current = currentMonthYear();

    const record = await prisma.payrollRecord.findFirst({
      where: {
        adminUserId: employee.id,
        month: current.month,
        year: current.year,
      },
    });

    const chartYear = Number(query.year) || current.year;
    const chartRecords = await prisma.payrollRecord.findMany({
      where: {
        adminUserId: employee.id,
        year: chartYear,
      },
      select: { month: true, netPay: true },
      orderBy: { month: "asc" },
    });

    const chartData = MONTH_LABELS.map((label, i) => {
      const found = chartRecords.find((r) => r.month === i + 1);
      return { month: label, netPay: found ? toNum(found.netPay) : 0 };
    });

    return {
      employee: {
        id: employee.id,
        name: employee.name,
        email: employee.email,
        employeeCode: null,
        employmentType: formatEmploymentType(employee),
        department: employee.department,
        designation: employee.position,
        avatarUrl: employee.avatarUrl,
      },
      payroll: record
        ? {
            id: record.id,
            month: record.month,
            year: record.year,
            totalSalary: toNum(record.totalSalary),
            allowance: toNum(record.totalAllowance),
            bonus: toNum(record.totalBonus),
            deductions: toNum(record.totalDeductions),
            grossPay: toNum(record.grossPay),
            netPay: toNum(record.netPay),
            status: record.status,
            paymentDate: formatDateOnly(record.paymentDate),
            paymentMethod: record.paymentMethod || null,
            bankName: record.bankName || null,
            bankAccount: record.bankAccount || null,
          }
        : null,
      chartData,
    };
  }

  async getEmployeePayslips(employeeId, query = {}) {
    assertPayrollSchemaSupported();

    const employee = await ensureEmployee(employeeId);
    const { page, limit, skip } = paginate(query, 10, 100);

    const where = { adminUserId: employee.id };

    const [total, records] = await Promise.all([
      prisma.payslip.count({ where }),
      prisma.payslip.findMany({
        where,
        include: { adminUser: { select: EMPLOYEE_SELECT } },
        orderBy: [{ year: "desc" }, { month: "desc" }],
        skip,
        take: limit,
      }),
    ]);

    return {
      data: records.map(mapPayslipRow),
      meta: buildMeta(total, page, limit),
    };
  }

  async getPayslipDetail(employeeId, id) {
    assertPayrollSchemaSupported();

    const employee = await ensureEmployee(employeeId);
    const payslipId = assertUuid(id, "payslip id");

    const record = await prisma.payslip.findFirst({
      where: { id: payslipId, adminUserId: employee.id },
      include: { adminUser: { select: EMPLOYEE_SELECT } },
    });
    if (!record) throw new ApiError(404, "Payslip not found");

    return {
      id: record.id,
      employee: {
        id: employee.id,
        name: employee.name,
        email: employee.email,
        employeeCode: null,
        department: employee.department,
        designation: employee.position,
        avatarUrl: employee.avatarUrl,
      },
      month: record.month,
      year: record.year,
      paymentMethod: record.paymentMethod || null,
      paymentDate: formatDateOnly(record.paymentDate),
      basicSalary: toNum(record.basicSalary),
      allowance: toNum(record.allowance),
      bonus: toNum(record.bonus),
      deductions: record.deductionsJson || {},
      netPay: toNum(record.netPay),
    };
  }

  async getEmployeeReceipts(employeeId, query = {}) {
    assertPayrollSchemaSupported();

    const employee = await ensureEmployee(employeeId);
    const { page, limit, skip } = paginate(query, 10, 100);
    const where = { adminUserId: employee.id };

    const [total, records] = await Promise.all([
      prisma.receipt.count({ where }),
      prisma.receipt.findMany({
        where,
        include: { adminUser: { select: EMPLOYEE_SELECT } },
        orderBy: [{ year: "desc" }, { month: "desc" }],
        skip,
        take: limit,
      }),
    ]);

    return {
      data: records.map(mapReceiptRow),
      meta: buildMeta(total, page, limit),
    };
  }

  async getEmployeeDeductions(employeeId, query = {}) {
    assertPayrollSchemaSupported();

    const employee = await ensureEmployee(employeeId);
    const { page, limit, skip } = paginate(query, 10, 100);
    const where = { adminUserId: employee.id };

    const [total, records] = await Promise.all([
      prisma.deduction.count({ where }),
      prisma.deduction.findMany({
        where,
        include: { adminUser: { select: EMPLOYEE_SELECT } },
        orderBy: [{ year: "desc" }, { month: "desc" }],
        skip,
        take: limit,
      }),
    ]);

    return {
      data: records.map(mapDeductionRow),
      meta: buildMeta(total, page, limit),
    };
  }

  async getEmployeeInvoices(employeeId, query = {}) {
    assertPayrollSchemaSupported();

    const employee = await ensureEmployee(employeeId);
    const { page, limit, skip } = paginate(query, 10, 100);
    const where = { adminUserId: employee.id };

    const [total, records] = await Promise.all([
      prisma.invoice.count({ where }),
      prisma.invoice.findMany({
        where,
        include: { adminUser: { select: EMPLOYEE_SELECT } },
        orderBy: [{ year: "desc" }, { month: "desc" }],
        skip,
        take: limit,
      }),
    ]);

    return {
      data: records.map(mapInvoiceRow),
      meta: buildMeta(total, page, limit),
    };
  }

  async updatePayroll({ employeeId, data, actor, req }) {
    assertPayrollSchemaSupported();

    const employee = await ensureEmployee(employeeId);

    const month = Number(data.month);
    const year = Number(data.year);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new ApiError(400, "Invalid month. Use 1-12.");
    }
    if (!Number.isInteger(year) || year < 1900 || year > 3000) {
      throw new ApiError(400, "Invalid year.");
    }

    function toDecimal(value, defaultValue = 0) {
      if (value === null || value === undefined || value === "") return defaultValue;
      const n = Number(value);
      if (!Number.isFinite(n)) throw new ApiError(400, "Invalid numeric value.");
      return n;
    }

    const totalSalary = toDecimal(data.totalSalary);
    const totalAllowance = toDecimal(data.totalAllowance);
    const totalBonus = toDecimal(data.totalBonus);
    const totalDeductions = toDecimal(data.totalDeductions);
    const grossPay = totalSalary + totalAllowance + totalBonus;
    const netPay = grossPay - totalDeductions;

    const upsertData = {
      totalSalary,
      totalAllowance,
      totalBonus,
      totalDeductions,
      grossPay,
      netPay,
      paymentMethod: data.paymentMethod ?? null,
      bankName: data.bankName ?? null,
      bankAccount: data.bankAccount ?? null,
    };

    const record = await prisma.payrollRecord.upsert({
      where: {
        adminUserId_month_year: {
          adminUserId: employee.id,
          month,
          year,
        },
      },
      update: upsertData,
      create: {
        adminUserId: employee.id,
        month,
        year,
        ...upsertData,
      },
      select: {
        id: true,
        month: true,
        year: true,
        totalSalary: true,
        totalAllowance: true,
        totalBonus: true,
        totalDeductions: true,
        grossPay: true,
        netPay: true,
        status: true,
        paymentMethod: true,
        bankName: true,
        bankAccount: true,
      },
    });

    await createAuditLog({
      adminUserId: actor?.id,
      action: "HRM_PAYROLL_UPDATED",
      targetId: record.id,
      targetType: "payroll_record",
      metadata: { employeeId: employee.id, month, year },
      req,
    });

    return {
      id: record.id,
      month: record.month,
      year: record.year,
      totalSalary: toNum(record.totalSalary),
      allowance: toNum(record.totalAllowance),
      bonus: toNum(record.totalBonus),
      deductions: toNum(record.totalDeductions),
      grossPay: toNum(record.grossPay),
      netPay: toNum(record.netPay),
      status: record.status,
      paymentMethod: record.paymentMethod,
      bankName: record.bankName,
      bankAccount: record.bankAccount,
    };
  }

  async downloadReport(query = {}) {
    assertPayrollSchemaSupported();

    const status = normalizePayrollStatus(query.status);
    const where = {};
    if (status) where.status = status;

    const records = await prisma.payrollRecord.findMany({
      where,
      include: { adminUser: { select: EMPLOYEE_SELECT } },
      orderBy: [{ year: "desc" }, { month: "desc" }],
    });

    const csv = buildCsv(
      [
        { key: "employeeCode", label: "Employee Code" },
        { key: "name", label: "Name" },
        { key: "email", label: "Email" },
        { key: "department", label: "Department" },
        { key: "designation", label: "Designation" },
        { key: "month", label: "Month" },
        { key: "year", label: "Year" },
        { key: "totalSalary", label: "Salary" },
        { key: "allowance", label: "Allowance" },
        { key: "bonus", label: "Bonus" },
        { key: "deductions", label: "Deductions" },
        { key: "grossPay", label: "Gross Pay" },
        { key: "netPay", label: "Net Pay" },
        { key: "status", label: "Status" },
        { key: "paymentMethod", label: "Payment Method" },
        { key: "bankName", label: "Bank" },
      ],
      records.map((r) => {
        const employee = r.adminUser || {};
        return {
          employeeCode: null,
          name: employee.name || "",
          email: employee.email || "",
          department: employee.department || "",
          designation: employee.position || "",
          month: MONTH_LABELS[r.month - 1] || r.month,
          year: r.year,
          totalSalary: toNum(r.totalSalary),
          allowance: toNum(r.totalAllowance),
          bonus: toNum(r.totalBonus),
          deductions: toNum(r.totalDeductions),
          grossPay: toNum(r.grossPay),
          netPay: toNum(r.netPay),
          status: r.status,
          paymentMethod: r.paymentMethod || "",
          bankName: r.bankName || "",
        };
      }),
    );

    return { filename: "payroll-report.csv", csv };
  }
}

module.exports = new PayrollService();
