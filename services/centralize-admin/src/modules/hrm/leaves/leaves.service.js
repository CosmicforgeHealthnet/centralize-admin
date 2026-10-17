const { prisma } = require("../../../shared/config/database");
const { createAuditLog } = require("../../../shared/middlewares/audit.middleware");
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

const REVIEWER_SELECT = {
  id: true,
  name: true,
  email: true,
};
function assertLeavesSchemaSupported() {
  const missingModels = [];
  if (!prisma.leaveRequest) missingModels.push("LeaveRequest");
  if (!prisma.leaveBalance) missingModels.push("LeaveBalance");

  if (missingModels.length) {
    unsupportedEndpoint("Leaves", missingModels);
  }
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
  const employee = record.adminUser || {};
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

async function ensureEmployee(employeeId) {
  const id = assertUuid(employeeId, "employee id");
  const employee = await prisma.adminUser.findUnique({
    where: { id },
    select: EMPLOYEE_SELECT,
  });
  if (!employee) throw new ApiError(404, "Employee not found");
  return employee;
}

async function updatePendingLeave({ id, actor, req, status }) {
  assertLeavesSchemaSupported();
  const leaveId = assertUuid(id, "leave id");
  const existing = await prisma.leaveRequest.findUnique({ where: { id: leaveId } });
  if (!existing) throw new ApiError(404, "Leave request not found");
  if (existing.status !== "PENDING") throw new ApiError(400, "Only pending leave requests can be updated");

  const updated = await prisma.leaveRequest.update({
    where: { id: leaveId },
    data: {
      status,
      reviewedById: actor?.id || null,
      reviewedAt: new Date(),
    },
    select: { status: true },
  });

  await createAuditLog({
    adminUserId: actor.id,
    action: status === "APPROVED" ? "HRM_LEAVE_APPROVED" : "HRM_LEAVE_DENIED",
    targetId: leaveId,
    targetType: "leave_request",
    metadata: { previousStatus: existing.status, status },
    req,
  });

  return { status: updated.status };
}

class LeavesService {
  async getStats() {
    assertLeavesSchemaSupported();

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
      prisma.leaveRequest.count(),
      prisma.leaveRequest.count({ where: { createdAt: { gte: current.start, lt: current.end } } }),
      prisma.leaveRequest.count({ where: { status: "DENIED" } }),
      prisma.leaveRequest.count({ where: { status: "PENDING" } }),
      prisma.leaveRequest.count({ where: { createdAt: { lt: current.start } } }),
      prisma.leaveRequest.count({ where: { createdAt: { gte: previous.start, lt: previous.end } } }),
      prisma.leaveRequest.count({ where: { status: "DENIED", createdAt: { gte: previous.start, lt: previous.end } } }),
      prisma.leaveRequest.count({ where: { status: "PENDING", createdAt: { gte: previous.start, lt: previous.end } } }),
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
    assertLeavesSchemaSupported();

    const year = new Date().getUTCFullYear();
    const records = await prisma.leaveRequest.findMany({
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

    // Value is this month's share of current-year leave requests from real LeaveRequest rows.
    return {
      data: MONTH_LABELS.map((month, index) => ({
        month,
        value: total ? Math.round((counts[index] / total) * 100) : 0,
      })),
    };
  }

  async listLeaves(query = {}) {
    assertLeavesSchemaSupported();

    const { page, limit, skip } = paginate(query, 10, 100);
    const where = leaveRequestWhere(query);

    const [total, records] = await Promise.all([
      prisma.leaveRequest.count({ where }),
      prisma.leaveRequest.findMany({
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
    assertLeavesSchemaSupported();

    const leaveId = assertUuid(id, "leave id");
    const record = await prisma.leaveRequest.findUnique({
      where: { id: leaveId },
      include: { adminUser: { select: EMPLOYEE_SELECT } },
    });
    if (!record) throw new ApiError(404, "Leave request not found");

    const employee = record.adminUser || {};
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
    assertLeavesSchemaSupported();

    const employee = await ensureEmployee(employeeId);

    const records = await prisma.leaveRequest.findMany({
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
    assertLeavesSchemaSupported();

    const employee = await ensureEmployee(employeeId);
    const rows = await prisma.leaveBalance.findMany({
      where: { adminUserId: employee.id, year: new Date().getUTCFullYear() },
      orderBy: { leaveType: "asc" },
    });

    return {
      data: rows.map((row) => ({
        leaveType: row.leaveType,
        availableDays: row.availableDays,
        usedDays: row.usedDays,
      })),
    };
  }

  async approveLeave({ id, actor, req }) {
    return updatePendingLeave({ id, actor, req, status: "APPROVED" });
  }

  async denyLeave({ id, actor, req }) {
    return updatePendingLeave({ id, actor, req, status: "DENIED" });
  }

  async approveAll({ actor, req }) {
    assertLeavesSchemaSupported();

    const result = await prisma.leaveRequest.updateMany({
      where: { status: "PENDING" },
      data: {
        status: "APPROVED",
        reviewedById: actor?.id || null,
        reviewedAt: new Date(),
      },
    });

    await createAuditLog({
      adminUserId: actor.id,
      action: "HRM_LEAVE_APPROVE_ALL",
      targetId: actor.id,
      targetType: "leave_request",
      metadata: { count: result.count },
      req,
    });

    return { count: result.count };
  }

  async downloadReport(query = {}) {
    assertLeavesSchemaSupported();

    const where = leaveRequestWhere(query);

    const records = await prisma.leaveRequest.findMany({
      where,
      include: {
        adminUser: { select: EMPLOYEE_SELECT },
        reviewedBy: { select: REVIEWER_SELECT },
      },
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
        reviewedBy: record.reviewedBy?.name || record.reviewedById || "",
        reviewedAt: formatDateOnly(record.reviewedAt),
      })),
    );

    return { filename: "leave-report.csv", csv };
  }
}

module.exports = new LeavesService();
