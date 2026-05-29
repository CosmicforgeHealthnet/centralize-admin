const { mainPrisma } = require("../../shared/config/mainDatabase");
const ApiError = require("../../shared/utils/ApiError");

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

const MONTH_LABELS = [
  { short: "Jan" },
  { short: "Feb" },
  { short: "Mar" },
  { short: "Apr" },
  { short: "May" },
  { short: "Jun" },
  { short: "Jul" },
  { short: "Aug" },
  { short: "Sep" },
  { short: "Oct" },
  { short: "Nov" },
  { short: "Dec" },
];

const APPOINTMENT_STATUSES = [
  "pending",
  "scheduled",
  "completed",
  "cancelled",
  "rescheduled",
];

const AVATAR_COLORS = [
  "#272EA7",
  "#0DA53F",
  "#A72775",
  "#D97706",
  "#7C3AED",
  "#0284C7",
];

const APPOINTMENT_COLORS = {
  consultation: "pink",
  follow_up: "green",
  routine_checkup: "solid-blue",
  urgent: "yellow",
};

const CATEGORY_TO_TYPE = {
  consultation: "consultation",
  "follow-up": "follow_up",
  "follow up": "follow_up",
  follow_up: "follow_up",
  emergency: "urgent",
  urgent: "urgent",
  "routine check": "routine_checkup",
  "routine checkup": "routine_checkup",
  "routine-check": "routine_checkup",
  "routine-checkup": "routine_checkup",
  routine_checkup: "routine_checkup",
};

const APPOINTMENT_SELECT = {
  id: true,
  patientId: true,
  doctorId: true,
  appointmentDate: true,
  appointmentTime: true,
  duration: true,
  endTime: true,
  status: true,
  type: true,
  priority: true,
  reason: true,
  notes: true,
  completedAt: true,
  cancelledAt: true,
  isCancelled: true,
  appointmentTimeUTC: true,
  endTimeUTC: true,
  createdAt: true,
  users_appointments_patientIdTousers: {
    select: {
      id: true,
      fullName: true,
      profileImageUrl: true,
      role: true,
    },
  },
  users_appointments_doctorIdTousers: {
    select: {
      id: true,
      fullName: true,
      profileImageUrl: true,
      departmentSpecialty: true,
      averageRating: true,
      doctor_profiles: {
        select: {
          profilePhoto: true,
          professional_licenses: {
            select: {
              areasOfSpecialization: true,
              subspecialty: true,
            },
          },
        },
      },
    },
  },
};

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function parsePositiveInteger(value, fieldName, { defaultValue, max } = {}) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 1) {
    throw new ApiError(400, `Invalid ${fieldName}. Use a positive integer.`);
  }

  return max ? Math.min(numberValue, max) : numberValue;
}

function formatDateYYYYMMDD(value) {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw new ApiError(400, "Invalid date. Use YYYY-MM-DD format.");
  }

  const [year, month, day] = String(value).split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new ApiError(400, "Invalid date. Use YYYY-MM-DD format.");
  }

  return parsed;
}

function parseYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1900 || year > 3000) {
    throw new ApiError(400, "Invalid year. Use a four-digit year.");
  }

  return year;
}

function parseNumericMonth(value) {
  const month = Number(value);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ApiError(400, "Invalid month. Use a number from 1 to 12.");
  }

  return month;
}

function formatTimeHHMM(value) {
  if (!value) return null;
  return value.toISOString().slice(11, 16);
}

function addMinutesToTime(value, minutes = 30) {
  if (!value) return null;
  const nextTime = new Date(value.getTime() + minutes * 60 * 1000);
  return formatTimeHHMM(nextTime);
}

function getInitials(name) {
  if (!name) return "DR";

  const normalized = String(name)
    .replace(/^(dr\.?|doctor|prof\.?)\s+/i, "")
    .trim();

  if (!normalized) return "DR";

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function getDeterministicColor(seed) {
  const value = String(seed || "");
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function getSpecialty(doctor) {
  const license = doctor?.doctor_profiles?.professional_licenses;
  const specialization = Array.isArray(license?.areasOfSpecialization)
    ? license.areasOfSpecialization[0]
    : null;

  return (
    doctor?.departmentSpecialty ||
    specialization ||
    license?.subspecialty ||
    "General Medicine"
  );
}

function getAppointmentColor(type) {
  return APPOINTMENT_COLORS[type] || "solid-blue";
}

function normalizeAppointmentCategory(category) {
  const normalizedCategory = String(category || "")
    .trim()
    .toLowerCase();
  const mappedCategory = CATEGORY_TO_TYPE[normalizedCategory];

  if (!mappedCategory) {
    throw new ApiError(400, "Invalid category.");
  }

  return mappedCategory;
}

function mapSearchQueryToAppointmentType(query) {
  const normalizedQuery = String(query || "")
    .trim()
    .toLowerCase();

  return CATEGORY_TO_TYPE[normalizedQuery] || null;
}

function getStartOfToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function getDisplayStatus(appointment) {
  if (appointment.isCancelled || appointment.status === "cancelled") {
    return "cancelled";
  }

  if (
    appointment.status === "completed" ||
    appointment.appointmentDate < getStartOfToday()
  ) {
    return "past";
  }

  return "upcoming";
}

function getPercentageColor(percentage) {
  if (percentage >= 70) return "#0DA53F";
  if (percentage >= 40) return "#D97706";
  return "#DC2626";
}

function getMonthRange(month) {
  const now = new Date();
  const monthIndex = month
    ? MONTHS.findIndex(
        (monthName) => monthName.toLowerCase() === String(month).toLowerCase(),
      )
    : now.getMonth();

  if (monthIndex === -1) {
    throw new ApiError(400, "Invalid month. Use a full month name.");
  }

  const year = now.getFullYear();
  const monthStart = new Date(Date.UTC(year, monthIndex, 1));
  const nextMonthStart = new Date(Date.UTC(year, monthIndex + 1, 1));

  return {
    monthName: MONTHS[monthIndex],
    monthStart,
    nextMonthStart,
  };
}

function getSelectedMonth(month) {
  return getMonthRange(month).monthName;
}

function mergeAppointmentDateFilter(where, dateFilter) {
  where.appointmentDate = {
    ...(where.appointmentDate || {}),
    ...dateFilter,
  };
}

function buildAppointmentsWhere(query) {
  const where = {};

  if (query.date) {
    const startOfDay = parseIsoDate(query.date);
    const nextDay = new Date(startOfDay);
    nextDay.setUTCDate(startOfDay.getUTCDate() + 1);

    mergeAppointmentDateFilter(where, {
      gte: startOfDay,
      lt: nextDay,
    });
  } else if (query.year || query.month) {
    const year = query.year
      ? parseYear(query.year)
      : new Date().getUTCFullYear();

    if (query.month) {
      const month = parseNumericMonth(query.month);
      mergeAppointmentDateFilter(where, {
        gte: new Date(Date.UTC(year, month - 1, 1)),
        lt: new Date(Date.UTC(year, month, 1)),
      });
    } else {
      mergeAppointmentDateFilter(where, {
        gte: new Date(Date.UTC(year, 0, 1)),
        lt: new Date(Date.UTC(year + 1, 0, 1)),
      });
    }
  }

  if (query.status && query.status !== "all") {
    const status = String(query.status).toLowerCase();
    const today = getStartOfToday();

    if (status === "upcoming") {
      const existingDateFilter = where.appointmentDate || {};
      where.appointmentDate = {
        ...existingDateFilter,
        gte:
          existingDateFilter.gte && existingDateFilter.gte > today
            ? existingDateFilter.gte
            : today,
      };
      where.status = { in: ["pending", "scheduled", "rescheduled"] };
      where.isCancelled = false;
    } else if (status === "past") {
      where.OR = [
        { appointmentDate: { lt: today } },
        { status: { in: ["completed", "cancelled"] } },
        { isCancelled: true },
      ];
    } else if (APPOINTMENT_STATUSES.includes(status)) {
      where.status = status;
    } else {
      throw new ApiError(400, "Invalid status.");
    }
  }

  if (query.department) {
    where.users_appointments_doctorIdTousers = {
      is: {
        departmentSpecialty: {
          contains: String(query.department),
          mode: "insensitive",
        },
      },
    };
  }

  return where;
}

function buildAppointmentsSearchWhere({ searchQuery, department, category }) {
  const orConditions = [
    { reason: { contains: searchQuery, mode: "insensitive" } },
    { notes: { contains: searchQuery, mode: "insensitive" } },
    {
      users_appointments_patientIdTousers: {
        is: {
          fullName: { contains: searchQuery, mode: "insensitive" },
        },
      },
    },
    {
      users_appointments_doctorIdTousers: {
        is: {
          fullName: { contains: searchQuery, mode: "insensitive" },
        },
      },
    },
    {
      users_appointments_doctorIdTousers: {
        is: {
          departmentSpecialty: {
            contains: searchQuery,
            mode: "insensitive",
          },
        },
      },
    },
  ];

  const queryType = mapSearchQueryToAppointmentType(searchQuery);
  if (queryType) {
    orConditions.push({ type: queryType });
  }

  const andConditions = [{ OR: orConditions }];

  if (department) {
    andConditions.push({
      users_appointments_doctorIdTousers: {
        is: {
          departmentSpecialty: {
            contains: String(department),
            mode: "insensitive",
          },
        },
      },
    });
  }

  if (category) {
    andConditions.push({ type: normalizeAppointmentCategory(category) });
  }

  return { AND: andConditions };
}

function groupAppointments(rows) {
  const groupedByDate = new Map();
  const doctorAppointmentCounts = new Map();

  for (const row of rows) {
    const date = formatDateYYYYMMDD(row.appointmentDate);
    const doctorId = row.doctorId;

    if (!groupedByDate.has(date)) {
      groupedByDate.set(date, new Map());
    }

    const doctorsByDate = groupedByDate.get(date);
    if (!doctorsByDate.has(doctorId)) {
      doctorsByDate.set(doctorId, {
        doctor: row.users_appointments_doctorIdTousers,
        rows: [],
      });
    }

    doctorsByDate.get(doctorId).rows.push(row);
    doctorAppointmentCounts.set(
      doctorId,
      (doctorAppointmentCounts.get(doctorId) || 0) + 1,
    );
  }

  const maxDoctorAppointments = Math.max(
    ...doctorAppointmentCounts.values(),
    0,
  );

  return Array.from(groupedByDate.entries()).map(([date, doctorsByDate]) => ({
    date,
    doctors: Array.from(doctorsByDate.entries()).map(
      ([doctorId, doctorGroup]) => {
        const doctor = doctorGroup.doctor;
        const doctorName = doctor?.fullName || "Unknown Doctor";
        const percentage =
          maxDoctorAppointments > 0
            ? Math.round(
                (doctorAppointmentCounts.get(doctorId) /
                  maxDoctorAppointments) *
                  100,
              )
            : 0;

        const sortedAppointments = doctorGroup.rows.sort(
          (left, right) =>
            left.appointmentTime.getTime() - right.appointmentTime.getTime() ||
            left.createdAt.getTime() - right.createdAt.getTime(),
        );

        return {
          id: doctorId,
          name: doctorName,
          specialty: getSpecialty(doctor),
          initials: getInitials(doctorName),
          avatarBg: getDeterministicColor(doctorId || doctorName),
          percentage,
          percentageColor: getPercentageColor(percentage),
          appointments: sortedAppointments.map((appointment, index) => ({
            id: appointment.id,
            patient:
              appointment.users_appointments_patientIdTousers?.fullName ||
              "Unknown Patient",
            time: formatTimeHHMM(appointment.appointmentTime) || "00:00",
            timeEnd:
              formatTimeHHMM(appointment.endTime) ||
              addMinutesToTime(
                appointment.appointmentTime,
                appointment.duration,
              ) ||
              "00:30",
            count: `${index + 1} of ${sortedAppointments.length}`,
            color: getAppointmentColor(appointment.type),
            status: getDisplayStatus(appointment),
          })),
        };
      },
    ),
  }));
}

class HealthnetService {
  async getAppointments(query = {}) {
    const page = parsePositiveInteger(query.page, "page", {
      defaultValue: 1,
    });
    const limit = parsePositiveInteger(query.limit, "limit", {
      defaultValue: 20,
      max: 100,
    });
    const skip = (page - 1) * limit;
    const where = buildAppointmentsWhere(query);

    const [rows, total] = await Promise.all([
      mainPrisma.appointments.findMany({
        where,
        skip,
        take: limit,
        orderBy: [
          { appointmentDate: "asc" },
          { appointmentTime: "asc" },
          { createdAt: "asc" },
        ],
        select: APPOINTMENT_SELECT,
      }),
      mainPrisma.appointments.count({ where }),
    ]);

    return {
      appointments: groupAppointments(rows),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async searchAppointments(query = {}) {
    const searchQuery = String(query.q || "").trim();
    if (!searchQuery) {
      throw new ApiError(400, "Search query is required.");
    }

    const page = parsePositiveInteger(query.page, "page", {
      defaultValue: 1,
    });
    const limit = parsePositiveInteger(query.limit, "limit", {
      defaultValue: 20,
      max: 100,
    });
    const skip = (page - 1) * limit;
    const where = buildAppointmentsSearchWhere({
      searchQuery,
      department: query.department,
      category: query.category,
    });

    const [rows, total] = await Promise.all([
      mainPrisma.appointments.findMany({
        where,
        skip,
        take: limit,
        orderBy: [
          { appointmentDate: "asc" },
          { appointmentTime: "asc" },
          { createdAt: "asc" },
        ],
        select: APPOINTMENT_SELECT,
      }),
      mainPrisma.appointments.count({ where }),
    ]);

    return {
      query: searchQuery,
      total,
      results: groupAppointments(rows),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getDashboardMetrics() {
    const [
      totalAppointments,
      totalDoctors,
      totalPatients,
      balanceAggregate,
    ] = await Promise.all([
      mainPrisma.appointments.count(),
      mainPrisma.users.count({ where: { role: "doctor" } }),
      mainPrisma.users.count({ where: { role: "patient" } }),
      mainPrisma.transactions.aggregate({
        where: { status: "completed" },
        _sum: { usdAmount: true },
      }),
    ]);

    return {
      totalAppointments,
      totalDoctors,
      totalPatients,
      balance: Number(balanceAggregate._sum.usdAmount || 0),
    };
  }

  async getActivityChart({ month } = {}) {
    const { monthName, monthStart, nextMonthStart } = getMonthRange(month);

    const monthFilter = {
      gte: monthStart,
      lt: nextMonthStart,
    };

    const [
      totalDoctors,
      newDoctors,
      appointments,
      productPurchase,
    ] = await Promise.all([
      mainPrisma.users.count({ where: { role: "doctor" } }),
      mainPrisma.users.count({
        where: {
          role: "doctor",
          createdAt: monthFilter,
        },
      }),
      mainPrisma.appointments.count({
        where: {
          appointmentDate: monthFilter,
        },
      }),
      mainPrisma.transactions.count({
        where: {
          serviceType: "pharmacy",
          status: "completed",
          createdAt: monthFilter,
        },
      }),
    ]);

    return {
      month: monthName,
      totalDoctors,
      newDoctors,
      appointments,
      productPurchase,
    };
  }

  async getPatientsChart({ month } = {}) {
    const selectedMonth = getSelectedMonth(month);
    const year = new Date().getFullYear();

    const monthlyActivity = await Promise.all(
      MONTH_LABELS.map(async (monthItem, monthIndex) => {
        const monthStart = new Date(Date.UTC(year, monthIndex, 1));
        const nextMonthStart = new Date(Date.UTC(year, monthIndex + 1, 1));
        const monthFilter = {
          gte: monthStart,
          lt: nextMonthStart,
        };

        const [patientSignups, appointmentEngagement] = await Promise.all([
          mainPrisma.users.count({
            where: {
              role: "patient",
              createdAt: monthFilter,
            },
          }),
          mainPrisma.appointments.count({
            where: {
              appointmentDate: monthFilter,
            },
          }),
        ]);

        return {
          month: monthItem.short,
          rawActivity: patientSignups + appointmentEngagement,
        };
      }),
    );

    const maxActivity = Math.max(
      ...monthlyActivity.map((item) => item.rawActivity),
      0,
    );

    const data = monthlyActivity.map((item) => ({
      month: item.month,
      value:
        maxActivity > 0
          ? Math.round((item.rawActivity / maxActivity) * 100)
          : 0,
    }));

    return {
      selectedMonth,
      data,
    };
  }

  async getRevenueChart() {
    const year = new Date().getFullYear();
    const data = await Promise.all(
      MONTH_LABELS.map(async (monthItem, monthIndex) => {
        const monthStart = new Date(Date.UTC(year, monthIndex, 1));
        const nextMonthStart = new Date(Date.UTC(year, monthIndex + 1, 1));
        const monthFilter = {
          gte: monthStart,
          lt: nextMonthStart,
        };

        const [
          incomeUsdAggregate,
          incomeNgnAggregate,
          doctorWithdrawalAggregate,
          doctorWithdrawalNgnAggregate,
          pharmacyPayoutAggregate,
          refundUsdAggregate,
          refundTransactions,
        ] = await Promise.all([
          mainPrisma.transactions.aggregate({
            where: {
              status: "completed",
              createdAt: monthFilter,
            },
            _sum: {
              usdAmount: true,
            },
          }),
          mainPrisma.transactions.aggregate({
            where: {
              status: "completed",
              originalCurrency: "NGN",
              createdAt: monthFilter,
            },
            _sum: {
              originalAmount: true,
            },
          }),
          mainPrisma.wallet_withdrawals.aggregate({
            where: {
              status: "completed",
              completedAt: monthFilter,
            },
            _sum: {
              amountUsd: true,
            },
          }),
          mainPrisma.wallet_withdrawals.aggregate({
            where: {
              status: "completed",
              requestedCurrency: "NGN",
              completedAt: monthFilter,
            },
            _sum: {
              requestedAmount: true,
            },
          }),
          mainPrisma.pharmacy_payout_requests.aggregate({
            where: {
              status: "completed",
              processedAt: monthFilter,
            },
            _sum: {
              amountUsd: true,
            },
          }),
          mainPrisma.transactions.aggregate({
            where: {
              refundStatus: {
                in: ["partial", "full"],
              },
              refundProcessedAt: monthFilter,
            },
            _sum: {
              refundAmount: true,
            },
          }),
          mainPrisma.transactions.findMany({
            where: {
              originalCurrency: "NGN",
              refundStatus: {
                in: ["partial", "full"],
              },
              refundAmount: {
                not: null,
              },
              refundProcessedAt: monthFilter,
            },
            select: {
              refundAmount: true,
              exchangeRateUsed: true,
            },
          }),
        ]);

        const refundNgn = refundTransactions.reduce((total, transaction) => {
          const exchangeRate = Number(transaction.exchangeRateUsed || 0);
          if (exchangeRate <= 0) return total;

          return total + Number(transaction.refundAmount || 0) / exchangeRate;
        }, 0);

        const expenseUsd =
          Number(doctorWithdrawalAggregate._sum.amountUsd || 0) +
          Number(pharmacyPayoutAggregate._sum.amountUsd || 0) +
          Number(refundUsdAggregate._sum.refundAmount || 0);

        const expenseNgn =
          Number(doctorWithdrawalNgnAggregate._sum.requestedAmount || 0) +
          refundNgn;

        return {
          month: monthItem.short,
          incomeUsd: roundMoney(incomeUsdAggregate._sum.usdAmount),
          incomeNgn: roundMoney(incomeNgnAggregate._sum.originalAmount),
          expenseUsd: roundMoney(expenseUsd),
          expenseNgn: roundMoney(expenseNgn),
        };
      }),
    );

    return {
      data,
    };
  }
}

module.exports = new HealthnetService();
