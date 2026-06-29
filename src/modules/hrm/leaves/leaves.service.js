const { prisma } = require("../../../shared/config/database");
const ApiError = require("../../../shared/utils/ApiError");
const {
  assertUuid,
  buildCsv,
  buildMeta,
  formatDateOnly,
  normalizeEnum,
  paginate,
  percentageChange,
  unsupportedEndpoint,
} = require("../hrm.utils");

const LEAVE_STATUSES = ["PENDING", "APPROVED", "DENIED"];
const LEAVE_REQUEST_MODEL_NAMES = ["leaveRequest", "leave"];
const LEAVE_BALANCE_MODEL_NAMES = ["leaveBalance"];
const MISSING_LEAVE_MODELS = ["LeaveRequest"];
const MISSING_BALANCE_MODELS = ["LeaveBalance", "LeaveRequest"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const EMPLOYEE_SELECT = {
  id: true,
  name: true,
  email: true,
  position: true,
  department: true,
  avatarUrl: true,
  personalPhone: true,
  workPhone: true,
  location: true,
  createdAt: true,
};

function getPrismaModel(delegateNames) {
  const delegateName = delegateNames.find((name) => prisma[name]);
  if (!delegateName) return null;
  const modelName = delegateName.charAt(0).toUpperCase() + delegateName.slice(1);
  return { delegateName, modelName, delegate: prisma[delegateName] };
}

function requireLeaveRequestModel(moduleName) {
  const model = getPrismaModel(LEAVE_REQUEST_MODEL_NAMES);
  if (!model) unsupportedEndpoint(moduleName, MISSING_LEAVE_MODELS);
  return model;
}

function normalizeStatus(value) {
  return normalizeEnum(value, LEAVE_STATUSES, "status");
}

function monthRange(monthName, year = new Date().getUTCFullYear()) {
  if (monthName === undefined || monthName === null || monthName === "") return undefined;
  const normalized = String(monthName).trim().toLowerCase();
  const monthIndex = MONTHS.findIndex((month) => month.toLowerCase() === normalized);
  if (monthIndex === -1) throw new ApiError(400, "Invalid period. Use a full month name.");

  return {
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}

function currentMonthRange(offset = 0) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
  return { start, end };
}

function leaveRequestWhere(query = {}) {
  const where = {};
  const status = normalizeStatus(query.status);
  if (status) where.status = status;

  const range = monthRange(query.period);
  if (range) where.startDate = { gte: range.start, lt: range.end };

  if (query.employeeId) where.adminUserId = assertUuid(query.employeeId, "employee id");
  return where;
}

function mapLeaveListItem(record) {
  const employee = record.adminUser || record.employee || {};
  return {
    id: record.id,
    adminUserId: record.adminUserId,
    name: employee.name || null,
    email: employee.email || null,
    leaveType: record.leaveType,
    startDate: formatDateOnly(record.startDate),
    resumptionDate: formatDateOnly(record.resumptionDate),
    status: record.status,
    avatarUrl: employee.avatarUrl || null,
  };
}

function mapLeaveHistoryItem(record) {
  return {
    id: record.id,
    leaveType: record.leaveType,
    startDate: formatDateOnly(record.startDate),
    resumptionDate: formatDateOnly(record.resumptionDate),
    status: record.status,
  };
}

function leaveDays(record) {
  if (!record.startDate || !record.resumptionDate) return 0;
  const start = new Date(record.startDate);
  const end = new Date(record.resumptionDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((end - start) / millisecondsPerDay));
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

function getRuntimeFields(modelName) {
  const models = prisma._runtimeDataModel?.models || {};
  return new Set((models[modelName]?.fields || []).map((field) => field.name));
}

function reviewFields(modelName, actor) {
  const fields = getRuntimeFields(modelName);
  const data = {};
  if (fields.has("reviewedBy")) data.reviewedBy = actor?.id || null;
  if (fields.has("reviewedAt")) data.reviewedAt = new Date();
  return data;
}

async function updatePendingLeave({ id, actor, status, moduleName }) {
  const leaveId = assertUuid(id, "leave id");
  const model = requireLeaveRequestModel(moduleName);
  const existing = await model.delegate.findUnique({ where: { id: leaveId } });
  if (!existing) throw new ApiError(404, "Leave request not found");
  if (existing.status !== "PENDING") throw new ApiError(400, "Only pending leave requests can be updated");

  const updated = await model.delegate.update({
    where: { id: leaveId },
    data: {
      status,
      ...reviewFields(model.modelName, actor),
    },
    select: { status: true },
  });

  return { status: updated.status };
}

class LeavesService {
  async getStats() {
    const model = requireLeaveRequestModel("Leave stats");
    const current = currentMonthRange();
    const previous = currentMonthRange(-1);

    const [
      totalRequests,
      newRequests,
      rejectedRequests,
      pendingRequests,
      previousTotal,
      previousNew,
      previousRejected,
      previousPending,
    ] = await Promise.all([
      model.delegate.count(),
      model.delegate.count({ where: { createdAt: { gte: current.start, lt: current.end } } }),
      model.delegate.count({ where: { status: "DENIED" } }),
      model.delegate.count({ where: { status: "PENDING" } }),
      model.delegate.count({ where: { createdAt: { lt: current.start } } }),
      model.delegate.count({ where: { createdAt: { gte: previous.start, lt: previous.end } } }),
      model.delegate.count({ where: { status: "DENIED", createdAt: { gte: previous.start, lt: previous.end } } }),
      model.delegate.count({ where: { status: "PENDING", createdAt: { gte: previous.start, lt: previous.end } } }),
    ]);

    return {
      totalRequests,
      newRequests,
      rejectedRequests,
      pendingRequests,
      changes: {
        totalChange: percentageChange(totalRequests, previousTotal),
        newChange: percentageChange(newRequests, previousNew),
        rejectedChange: percentageChange(rejectedRequests, previousRejected),
        pendingChange: percentageChange(pendingRequests, previousPending),
      },
    };
  }

  async getChart() {
    const model = requireLeaveRequestModel("Leave chart");
    const year = new Date().getUTCFullYear();
    const records = await model.delegate.findMany({
      where: {
        startDate: {
          gte: new Date(Date.UTC(year, 0, 1)),
          lt: new Date(Date.UTC(year + 1, 0, 1)),
        },
      },
      select: { startDate: true },
    });

    const total = records.length;
    const counts = new Array(12).fill(0);
    for (const record of records) counts[new Date(record.startDate).getUTCMonth()] += 1;

    // Value is this month's share of current-year leave requests.
    return {
      data: MONTH_LABELS.map((month, index) => ({
        month,
        value: total ? Math.round((counts[index] / total) * 100) : 0,
      })),
    };
  }

  async listLeaves(query = {}) {
    const { page, limit, skip } = paginate(query, 10, 100);
    const where = leaveRequestWhere(query);
    const model = requireLeaveRequestModel("Leave list");

    const [total, records] = await Promise.all([
      model.delegate.count({ where }),
      model.delegate.findMany({
        where,
        include: { adminUser: { select: EMPLOYEE_SELECT } },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: records.map(mapLeaveListItem),
      meta: buildMeta(total, page, limit),
    };
  }

  async getLeave(id) {
    const leaveId = assertUuid(id, "leave id");
    const model = requireLeaveRequestModel("Leave detail");
    const record = await model.delegate.findUnique({
      where: { id: leaveId },
      include: { adminUser: { select: EMPLOYEE_SELECT } },
    });
    if (!record) throw new ApiError(404, "Leave request not found");

    const employee = record.adminUser || record.employee || {};
    return {
      id: record.id,
      leaveType: record.leaveType,
      startDate: formatDateOnly(record.startDate),
      resumptionDate: formatDateOnly(record.resumptionDate),
      reason: record.reason || null,
      status: record.status,
      attachmentUrl: record.attachmentUrl || null,
      attachmentName: record.attachmentName || null,
      employee: {
        id: employee.id || null,
        name: employee.name || null,
        employeeCode: null,
        phone: employee.personalPhone || employee.workPhone || null,
        email: employee.email || null,
        position: employee.position || null,
        location: employee.location || null,
        headOfDepartment: null,
        employmentDate: formatDateOnly(employee.createdAt),
        avatarUrl: employee.avatarUrl || null,
      },
    };
  }

  async getEmployeeLeaves(employeeId) {
    const employee = await ensureEmployee(employeeId);
    const model = requireLeaveRequestModel("Employee leave history");

    const records = await model.delegate.findMany({
      where: { adminUserId: employee.id },
      select: {
        id: true,
        leaveType: true,
        startDate: true,
        resumptionDate: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return { data: records.map(mapLeaveHistoryItem) };
  }

  async getEmployeeBalance(employeeId) {
    const employee = await ensureEmployee(employeeId);
    const balanceModel = getPrismaModel(LEAVE_BALANCE_MODEL_NAMES);
    if (balanceModel) {
      const rows = await balanceModel.delegate.findMany({
        where: { adminUserId: employee.id, year: new Date().getUTCFullYear() },
        orderBy: { leaveType: "asc" },
      });

      return {
        data: rows.map((row) => ({
          leaveType: row.leaveType,
          availableDays: row.availableDays ?? 0,
          usedDays: row.usedDays ?? 0,
        })),
      };
    }

    const requestModel = getPrismaModel(LEAVE_REQUEST_MODEL_NAMES);
    if (!requestModel) unsupportedEndpoint("Employee leave balance", MISSING_BALANCE_MODELS);

    const year = new Date().getUTCFullYear();
    const approved = await requestModel.delegate.findMany({
      where: {
        adminUserId: employee.id,
        status: "APPROVED",
        startDate: {
          gte: new Date(Date.UTC(year, 0, 1)),
          lt: new Date(Date.UTC(year + 1, 0, 1)),
        },
      },
      select: { leaveType: true, startDate: true, resumptionDate: true },
    });

    const balances = new Map();
    for (const record of approved) {
      const current = balances.get(record.leaveType) || { leaveType: record.leaveType, availableDays: 0, usedDays: 0 };
      current.usedDays += leaveDays(record);
      balances.set(record.leaveType, current);
    }

    return { data: [...balances.values()] };
  }

  async approveLeave({ id, actor, req }) {
    void req;
    return updatePendingLeave({ id, actor, status: "APPROVED", moduleName: "Leave approval" });
  }

  async denyLeave({ id, actor, req }) {
    void req;
    return updatePendingLeave({ id, actor, status: "DENIED", moduleName: "Leave denial" });
  }

  async approveAll({ actor, req }) {
    void req;
    const model = requireLeaveRequestModel("Leave approve all");
    const data = {
      status: "APPROVED",
      ...reviewFields(model.modelName, actor),
    };
    const result = await model.delegate.updateMany({ where: { status: "PENDING" }, data });
    return { count: result.count };
  }

  async downloadReport(query = {}) {
    const where = leaveRequestWhere(query);
    const model = requireLeaveRequestModel("Leave report download");

    const records = await model.delegate.findMany({
      where,
      include: { adminUser: { select: EMPLOYEE_SELECT } },
      orderBy: { createdAt: "desc" },
    });

    const csv = buildCsv(
      [
        { key: "employeeCode", label: "Employee Code" },
        { key: "name", label: "Name" },
        { key: "email", label: "Email" },
        { key: "leaveType", label: "Leave Type" },
        { key: "startDate", label: "Start Date" },
        { key: "resumptionDate", label: "Resumption Date" },
        { key: "status", label: "Status" },
        { key: "reviewedBy", label: "Reviewed By" },
        { key: "reviewedAt", label: "Reviewed At" },
      ],
      records.map((record) => ({
        ...mapLeaveListItem(record),
        employeeCode: null,
        reviewedBy: record.reviewedBy || "",
        reviewedAt: formatDateOnly(record.reviewedAt),
      })),
    );

    return { filename: "leave-report.csv", csv };
  }
}

module.exports = new LeavesService();
