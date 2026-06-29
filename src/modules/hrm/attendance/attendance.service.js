const { prisma } = require("../../../shared/config/database");
const ApiError = require("../../../shared/utils/ApiError");
const {
  addUtcDays,
  assertUuid,
  averageMinutesFromDates,
  buildCsv,
  buildMeta,
  dateOnlyRange,
  formatDateOnly,
  formatMinutesAsTime,
  formatSlashDate,
  formatTime,
  normalizeDepartment,
  normalizeEnum,
  paginate,
  parseDateOnly,
  percentageChange,
  startOfUtcDay,
  unsupportedEndpoint,
} = require("../hrm.utils");

const ATTENDANCE_STATUSES = ["PRESENT", "LATE", "ABSENT"];
const ATTENDANCE_MODEL_NAMES = ["attendanceLog", "attendance"];
const MISSING_MODELS = ["AttendanceLog", "Attendance"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LOG_PERIODS = ["This Week", "Last Week", "This Month"];

const EMPLOYEE_SELECT = {
  id: true,
  name: true,
  email: true,
  position: true,
  department: true,
  employmentType: true,
  employmentCategory: true,
  avatarUrl: true,
  createdAt: true,
};

function getAttendanceModel() {
  const modelName = ATTENDANCE_MODEL_NAMES.find((name) => prisma[name]);
  if (!modelName) return null;
  return { modelName, delegate: prisma[modelName] };
}

function requireAttendanceModel(moduleName) {
  const model = getAttendanceModel();
  if (!model) unsupportedEndpoint(moduleName, MISSING_MODELS);
  return model.delegate;
}

function normalizeStatus(value) {
  return normalizeEnum(value, ATTENDANCE_STATUSES, "status");
}

function parseIsoDateTime(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, `Invalid ${fieldName}. Use a valid ISO datetime.`);
  }

  return date;
}

function formatEmploymentType(employee = {}) {
  const parts = [employee.employmentType, employee.employmentCategory].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function mapAttendanceRecord(record) {
  const employee = record.adminUser || record.employee || {};
  return {
    id: record.id,
    adminUserId: record.adminUserId,
    name: employee.name || null,
    email: employee.email || null,
    employeeCode: null,
    employmentType: formatEmploymentType(employee),
    department: employee.department || null,
    designation: employee.position || null,
    clockIn: formatTime(record.clockIn),
    clockOut: formatTime(record.clockOut),
    status: record.status,
    date: formatDateOnly(record.date),
    avatarUrl: employee.avatarUrl || null,
  };
}

function mapLog(record) {
  return {
    id: record.id,
    date: formatSlashDate(record.date),
    clockIn: formatTime(record.clockIn),
    clockOut: formatTime(record.clockOut),
    status: record.status,
  };
}

function employeeRelationWhere(query = {}) {
  const relationWhere = {};
  const department = normalizeDepartment(query.department);
  if (department) relationWhere.department = department;

  const search = String(query.search || "").trim();
  if (search) {
    relationWhere.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    ];
  }

  return Object.keys(relationWhere).length ? { adminUser: relationWhere } : {};
}

function buildAttendanceWhere(query = {}) {
  const where = {};

  if (query.date !== undefined && query.date !== null && query.date !== "") {
    const range = dateOnlyRange(query.date, "date");
    where.date = { gte: range.start, lt: range.end };
  }

  const status = normalizeStatus(query.status);
  if (status) where.status = status;

  Object.assign(where, employeeRelationWhere(query));
  return where;
}

function getWeekRange(now = new Date()) {
  const today = startOfUtcDay(now);
  const day = today.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = addUtcDays(today, mondayOffset);
  return { start, end: addUtcDays(start, 7) };
}

function getLogPeriodRange(period) {
  const normalized = String(period || "This Week").trim().toLowerCase();
  const selected = LOG_PERIODS.find((item) => item.toLowerCase() === normalized);
  if (!selected) throw new ApiError(400, "Invalid period.");

  if (selected === "This Week") return getWeekRange();
  if (selected === "Last Week") {
    const thisWeek = getWeekRange();
    const start = addUtcDays(thisWeek.start, -7);
    return { start, end: thisWeek.start };
  }

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
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

async function countByStatus(delegate, range, status) {
  return delegate.count({
    where: {
      date: { gte: range.start, lt: range.end },
      status,
    },
  });
}

async function averageCheckInMinutes(delegate, range) {
  const rows = await delegate.findMany({
    where: {
      date: { gte: range.start, lt: range.end },
      clockIn: { not: null },
    },
    select: { clockIn: true },
  });

  return averageMinutesFromDates(rows.map((row) => row.clockIn));
}

class AttendanceService {
  async getStats(query = {}) {
    const range = dateOnlyRange(query.date, "date");
    const previousRange = {
      start: addUtcDays(range.start, -1),
      end: range.start,
    };
    const delegate = requireAttendanceModel("Attendance stats");

    const [
      totalPresent,
      lateArrivals,
      totalAbsent,
      previousPresent,
      previousLate,
      previousAbsent,
      averageCheckInMinutesToday,
      averageCheckInMinutesPrevious,
    ] = await Promise.all([
      countByStatus(delegate, range, "PRESENT"),
      countByStatus(delegate, range, "LATE"),
      countByStatus(delegate, range, "ABSENT"),
      countByStatus(delegate, previousRange, "PRESENT"),
      countByStatus(delegate, previousRange, "LATE"),
      countByStatus(delegate, previousRange, "ABSENT"),
      averageCheckInMinutes(delegate, range),
      averageCheckInMinutes(delegate, previousRange),
    ]);

    return {
      totalPresent,
      lateArrivals,
      totalAbsent,
      averageCheckIn: formatMinutesAsTime(averageCheckInMinutesToday, { compact: false }),
      changes: {
        presentChange: percentageChange(totalPresent, previousPresent),
        lateChange: percentageChange(lateArrivals, previousLate),
        absentChange: percentageChange(totalAbsent, previousAbsent),
        checkInChange: percentageChange(averageCheckInMinutesToday || 0, averageCheckInMinutesPrevious),
      },
    };
  }

  async listAttendance(query = {}) {
    const { page, limit, skip } = paginate(query, 10, 100);
    const where = buildAttendanceWhere(query);
    const delegate = requireAttendanceModel("Attendance list");

    const [total, records] = await Promise.all([
      delegate.count({ where }),
      delegate.findMany({
        where,
        include: { adminUser: { select: EMPLOYEE_SELECT } },
        orderBy: [{ date: "desc" }, { clockIn: "asc" }],
        skip,
        take: limit,
      }),
    ]);

    return {
      data: records.map(mapAttendanceRecord),
      meta: buildMeta(total, page, limit),
    };
  }

  async getEmployeeOverview(employeeId, query = {}) {
    const employee = await ensureEmployee(employeeId);
    const delegate = requireAttendanceModel("Attendance employee overview");
    const year = Number(query.year) || new Date().getUTCFullYear();
    if (!Number.isInteger(year) || year < 1900 || year > 3000) {
      throw new ApiError(400, "Invalid year.");
    }

    const records = await delegate.findMany({
      where: {
        adminUserId: employee.id,
        date: {
          gte: new Date(Date.UTC(year, 0, 1)),
          lt: new Date(Date.UTC(year + 1, 0, 1)),
        },
      },
      select: { date: true, status: true },
      orderBy: { date: "asc" },
    });

    const chartData = MONTH_LABELS.map((month) => ({ month, present: 0, late: 0, absent: 0 }));
    for (const record of records) {
      const index = new Date(record.date).getUTCMonth();
      if (record.status === "PRESENT") chartData[index].present += 1;
      if (record.status === "LATE") chartData[index].late += 1;
      if (record.status === "ABSENT") chartData[index].absent += 1;
    }

    return {
      employee: {
        id: employee.id,
        name: employee.name,
        department: employee.department,
        employmentType: employee.employmentType,
        employmentCategory: employee.employmentCategory,
        employmentDate: formatDateOnly(employee.createdAt),
      },
      chartData,
    };
  }

  async getEmployeeLogs(employeeId, query = {}) {
    const employee = await ensureEmployee(employeeId);
    const range = getLogPeriodRange(query.period);
    const delegate = requireAttendanceModel("Attendance employee logs");

    const records = await delegate.findMany({
      where: {
        adminUserId: employee.id,
        date: { gte: range.start, lt: range.end },
      },
      select: {
        id: true,
        date: true,
        clockIn: true,
        clockOut: true,
        status: true,
      },
      orderBy: { date: "desc" },
    });

    return { data: records.map(mapLog) };
  }

  async createAttendance({ data, actor, req }) {
    const adminUserId = assertUuid(data.adminUserId, "employee id");
    await ensureEmployee(adminUserId);

    const date = parseDateOnly(data.date, "date");
    const range = dateOnlyRange(data.date, "date");
    const clockIn = parseIsoDateTime(data.clockIn, "clockIn");
    const clockOut = parseIsoDateTime(data.clockOut, "clockOut");
    const status = normalizeStatus(data.status);
    const delegate = requireAttendanceModel("Attendance create");

    const existing = await delegate.findFirst({
      where: {
        adminUserId,
        date: { gte: range.start, lt: range.end },
      },
      select: { id: true },
    });
    if (existing) throw new ApiError(409, "Attendance already exists for this employee and date");

    const created = await delegate.create({
      data: {
        adminUserId,
        date,
        clockIn,
        clockOut,
        status,
      },
      select: { id: true },
    });

    void actor;
    void req;
    return { id: created.id };
  }

  async updateAttendance({ id, data, actor, req }) {
    const attendanceId = assertUuid(id, "attendance id");
    const update = {};

    if (data.clockIn !== undefined) update.clockIn = parseIsoDateTime(data.clockIn, "clockIn");
    if (data.clockOut !== undefined) update.clockOut = parseIsoDateTime(data.clockOut, "clockOut");
    if (data.status !== undefined) update.status = normalizeStatus(data.status);

    if (!Object.keys(update).length) throw new ApiError(400, "No valid attendance fields provided");

    const delegate = requireAttendanceModel("Attendance update");
    const existing = await delegate.findUnique({ where: { id: attendanceId }, select: { id: true } });
    if (!existing) throw new ApiError(404, "Attendance record not found");

    await delegate.update({ where: { id: attendanceId }, data: update });

    void actor;
    void req;
    return {};
  }

  async downloadReport(query = {}) {
    const where = buildAttendanceWhere(query);
    if (query.employeeId) where.adminUserId = assertUuid(query.employeeId, "employee id");
    const delegate = requireAttendanceModel("Attendance report download");

    const records = await delegate.findMany({
      where,
      include: { adminUser: { select: EMPLOYEE_SELECT } },
      orderBy: [{ date: "desc" }, { clockIn: "asc" }],
    });

    const csv = buildCsv(
      [
        { key: "employeeCode", label: "Employee Code" },
        { key: "name", label: "Name" },
        { key: "email", label: "Email" },
        { key: "department", label: "Department" },
        { key: "designation", label: "Designation" },
        { key: "date", label: "Date" },
        { key: "clockIn", label: "Clock In" },
        { key: "clockOut", label: "Clock Out" },
        { key: "status", label: "Status" },
      ],
      records.map(mapAttendanceRecord),
    );

    return { filename: "attendance-report.csv", csv };
  }
}

module.exports = new AttendanceService();

