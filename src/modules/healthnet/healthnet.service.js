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

const USER_STATUSES = [
  "pending_email_verification",
  "active",
  "pending_doctor_verification",
  "doctor_active",
  "pending_pharmacy_verification",
  "pharmacy_active",
  "locked",
];

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DAY_LABELS = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

const DAY_SHORT_LABELS = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

const DAY_ORDER = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const RECORD_TYPES = ["lab", "imaging", "prescription", "referral", "other", "all"];
const FINANCE_REVENUE_TYPES = ["sales", "subscriptions"];
const FINANCE_REVENUE_FORMATS = ["json", "csv"];
const FINANCE_APPOINTMENT_HISTORY_DATE_FILTERS = [
  "today",
  "week",
  "month",
  "all",
];

const LAB_STAFF_GROUPS = [
  "Phlebotomists",
  "Sample Collector",
  "Radiologists",
  "Result Entry",
  "Result Reviewer",
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

const DOCTOR_SELECT = {
  id: true,
  fullName: true,
  departmentSpecialty: true,
  email: true,
  phoneNumber: true,
  averageRating: true,
  status: true,
  createdAt: true,
  profileImageUrl: true,
  doctor_profiles: {
    select: {
      contactNumber: true,
      profilePhoto: true,
      professional_licenses: {
        select: {
          yearsOfExperience: true,
        },
      },
    },
  },
};

const PATIENT_SELECT = {
  id: true,
  fullName: true,
  email: true,
  phoneNumber: true,
  createdAt: true,
  profileImageUrl: true,
  patient_profiles: {
    select: {
      profileType: true,
      mobileNumber: true,
      profilePhoto: true,
    },
  },
};

const LAB_SELECT = {
  id: true,
  facilityName: true,
  email: true,
  phone: true,
  address: true,
  city: true,
  state: true,
  country: true,
  createdAt: true,
  users_lab_facilities_adminUserIdTousers: {
    select: {
      profileImageUrl: true,
    },
  },
};

const LAB_DETAIL_SELECT = {
  id: true,
  facilityName: true,
  registrationNumber: true,
  website: true,
  address: true,
  city: true,
  state: true,
  country: true,
  operatingHours: true,
  status: true,
  phone: true,
  email: true,
  adminFullName: true,
  adminEmail: true,
  adminPhone: true,
  createdAt: true,
  users_lab_facilities_adminUserIdTousers: {
    select: {
      fullName: true,
      profileImageUrl: true,
    },
  },
};

const LAB_DOCUMENT_SELECT = {
  id: true,
  govIdUrl: true,
  registrationDocument: true,
  businessRegistrationUrl: true,
  licenseDocument: true,
};

const LAB_STAFF_SELECT = {
  id: true,
  role: true,
  fullName: true,
  phone: true,
  yearsOfExperience: true,
};

const PHARMACY_SELECT = {
  id: true,
  pharmacyName: true,
  address: true,
  email: true,
  phone: true,
  logoUrl: true,
  createdAt: true,
  users: {
    select: {
      email: true,
      phoneNumber: true,
      profileImageUrl: true,
    },
  },
};

const PHARMACY_DETAIL_SELECT = {
  id: true,
  pharmacyName: true,
  registrationNumber: true,
  address: true,
  website: true,
  operatingHours: true,
  serviceRadius: true,
  primaryContactPerson: true,
  phone: true,
  email: true,
  verificationStatus: true,
  isActive: true,
  logoUrl: true,
  createdAt: true,
  users: {
    select: {
      fullName: true,
      email: true,
      phoneNumber: true,
      profileImageUrl: true,
    },
  },
};

const PHARMACY_DOCUMENT_SELECT = {
  id: true,
  documentType: true,
  document_files: {
    select: {
      file_path: true,
      file_size: true,
      mime_type: true,
    },
  },
};

const PATIENT_DETAIL_SELECT = {
  id: true,
  fullName: true,
  email: true,
  country: true,
  profileImageUrl: true,
  patient_profiles: {
    select: {
      id: true,
      gender: true,
      dateOfBirth: true,
      genotype: true,
      bloodGroup: true,
      nationality: true,
      address: true,
      height: true,
      weight: true,
      profileType: true,
      profilePhoto: true,
      allergies: {
        select: {
          type: true,
          allergen: true,
          description: true,
        },
      },
    },
  },
};

const DOCTOR_DETAIL_SELECT = {
  id: true,
  fullName: true,
  departmentSpecialty: true,
  email: true,
  phoneNumber: true,
  averageRating: true,
  country: true,
  profileImageUrl: true,
  doctor_profiles: {
    select: {
      id: true,
      contactNumber: true,
      profilePhoto: true,
      nationality: true,
      residentialAddress: true,
      professional_licenses: {
        select: {
          medicalInstitution: true,
          yearsOfExperience: true,
          areasOfSpecialization: true,
          subspecialty: true,
        },
      },
    },
  },
  doctor_availability: {
    where: {
      isAvailable: true,
    },
    orderBy: [
      {
        dayOfWeek: "asc",
      },
      {
        startTime: "asc",
      },
    ],
    select: {
      dayOfWeek: true,
      startTime: true,
      endTime: true,
    },
  },
};

const DOCTOR_TIMELINE_SELECT = {
  id: true,
  departmentSpecialty: true,
  doctor_profiles: {
    select: {
      professional_licenses: {
        select: {
          areasOfSpecialization: true,
          subspecialty: true,
        },
      },
    },
  },
};

const DOCTOR_TIMELINE_APPOINTMENT_SELECT = {
  id: true,
  appointmentDate: true,
  appointmentTime: true,
  appointmentTimeUTC: true,
  doctorLocalTime: true,
  status: true,
  type: true,
  reason: true,
  users_appointments_patientIdTousers: {
    select: {
      fullName: true,
    },
  },
};

const PATIENT_TIMELINE_APPOINTMENT_SELECT = {
  id: true,
  appointmentDate: true,
  appointmentTime: true,
  appointmentTimeUTC: true,
  doctorLocalTime: true,
  patientLocalTime: true,
  status: true,
  type: true,
  reason: true,
  users_appointments_doctorIdTousers: {
    select: {
      fullName: true,
      departmentSpecialty: true,
      doctor_profiles: {
        select: {
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

function formatJoiningDate(value) {
  if (!value) return null;

  const month = MONTH_LABELS[value.getUTCMonth()]?.short;
  if (!month) return null;

  return `${month} ${value.getUTCDate()}, ${value.getUTCFullYear()}`;
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

function parseDateQuery(value) {
  if (value === undefined || value === null || value === "") {
    return getStartOfToday();
  }

  return parseIsoDate(value);
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

function assertValidUuid(value, fieldName) {
  if (!value || !UUID_REGEX.test(String(value).trim())) {
    throw new ApiError(400, `Invalid ${fieldName}.`);
  }

  return String(value).trim();
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

function getNullableSpecialty(doctor) {
  const license = doctor?.doctor_profiles?.professional_licenses;
  const specialization = Array.isArray(license?.areasOfSpecialization)
    ? license.areasOfSpecialization.find(Boolean)
    : null;

  return doctor?.departmentSpecialty || specialization || license?.subspecialty || null;
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

function getFinanceMonthRanges() {
  const now = new Date();
  const currentMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const nextMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  const previousMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  );

  return {
    current: {
      gte: currentMonthStart,
      lt: nextMonthStart,
    },
    previous: {
      gte: previousMonthStart,
      lt: currentMonthStart,
    },
  };
}

function getCompletedTransactionDateWhere(dateRange) {
  if (!dateRange) return {};

  return {
    OR: [
      {
        completedAt: dateRange,
      },
      {
        completedAt: null,
        createdAt: dateRange,
      },
    ],
  };
}

function getFinanceYearRange(year) {
  const yearNumber =
    year === undefined || year === null || year === ""
      ? new Date().getUTCFullYear()
      : Number(year);

  if (
    !Number.isInteger(yearNumber) ||
    !/^\d{4}$/.test(String(yearNumber)) ||
    yearNumber < 1
  ) {
    throw new ApiError(400, "Invalid year. Use YYYY format.");
  }

  return {
    year: yearNumber,
    range: {
      gte: new Date(Date.UTC(yearNumber, 0, 1)),
      lt: new Date(Date.UTC(yearNumber + 1, 0, 1)),
    },
  };
}

function parseFinanceRevenueTrackingQuery(query = {}) {
  const { year, range } = getFinanceYearRange(query.year);
  const type = String(query.type || "sales").toLowerCase();
  const format = String(query.format || "json").toLowerCase();

  if (!FINANCE_REVENUE_TYPES.includes(type)) {
    throw new ApiError(400, "Invalid type. Use sales or subscriptions.");
  }

  if (!FINANCE_REVENUE_FORMATS.includes(format)) {
    throw new ApiError(400, "Invalid format. Use json or csv.");
  }

  return {
    year,
    range,
    type,
    format,
  };
}

function getFinanceHistoryDateRange(dateFilter) {
  const filter = String(dateFilter || "today").toLowerCase();

  if (!FINANCE_APPOINTMENT_HISTORY_DATE_FILTERS.includes(filter)) {
    throw new ApiError(400, "Invalid date. Use today, week, month, or all.");
  }

  if (filter === "all") {
    return { date: filter, range: null };
  }

  const now = new Date();
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  let start = todayStart;

  if (filter === "week") {
    const day = todayStart.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    start = new Date(todayStart);
    start.setUTCDate(todayStart.getUTCDate() + mondayOffset);
  }

  if (filter === "month") {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  return {
    date: filter,
    range: {
      gte: start,
      lt: now,
    },
  };
}

function parseFinanceHistoryQuery(query = {}) {
  const page = parsePositiveInteger(query.page, "page", {
    defaultValue: 1,
  });
  const limit = parsePositiveInteger(query.limit, "limit", {
    defaultValue: 20,
    max: 100,
  });
  const { range } = getFinanceHistoryDateRange(query.date);

  return {
    page,
    limit,
    skip: (page - 1) * limit,
    range,
  };
}

function getCompletedTransactionDate(transaction) {
  return transaction.completedAt || transaction.createdAt || null;
}

function getTransactionAmount(transaction) {
  return Number(transaction.usdAmount ?? transaction.originalAmount ?? 0);
}

function formatFinanceDate(value) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();

  return `${day}/${month}/${year}`;
}

function toTitleCase(value) {
  if (!value) return null;

  return String(value)
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\w\S*/g, (word) => (
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    ));
}

function mapTransactionStatus(status) {
  if (!status) return null;

  const normalizedStatus = String(status).toLowerCase();
  const statusMap = {
    completed: "Successful",
    success: "Successful",
    successful: "Successful",
    pending: "Pending",
    processing: "Pending",
    failed: "Failed",
    cancelled: "Cancelled",
    canceled: "Cancelled",
    refunded: "Refunded",
  };

  return statusMap[normalizedStatus] || status;
}

function getPaymentMode(transaction) {
  const paymentMethod = transaction.user_payment_methods;

  if (paymentMethod?.cardLast4) return "Card";
  if (paymentMethod?.cardType) return toTitleCase(paymentMethod.cardType);
  if (paymentMethod?.lastSuccessfulProvider) {
    return toTitleCase(paymentMethod.lastSuccessfulProvider);
  }

  return toTitleCase(transaction.paymentProvider);
}

function getPaymentBankDisplay(transaction) {
  const paymentMethod = transaction.user_payment_methods;

  if (paymentMethod?.bankName) return paymentMethod.bankName;

  if (paymentMethod?.cardBrand || paymentMethod?.cardLast4) {
    return [
      paymentMethod.cardBrand,
      paymentMethod.cardLast4 && `**** ${paymentMethod.cardLast4}`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  return transaction.providerReference || transaction.providerTransactionId || null;
}

function mapAppointmentFinanceTransaction(transaction) {
  const payer =
    transaction.users_transactions_patientIdTousers ||
    transaction.users_transactions_doctorIdTousers ||
    null;
  const date = getCompletedTransactionDate(transaction);

  return {
    id: transaction.id,
    payerName: payer?.fullName || null,
    paymentMode: getPaymentMode(transaction),
    bank: getPaymentBankDisplay(transaction),
    amount: Number(transaction.originalAmount ?? transaction.usdAmount ?? 0),
    currency: transaction.originalCurrency || null,
    description: transaction.description || "Doctor's Appointment",
    date: formatFinanceDate(date),
    status: mapTransactionStatus(transaction.status),
    avatarUrl: payer?.profileImageUrl || null,
  };
}

function getSubscriptionDescription(transaction) {
  if (transaction.description) return transaction.description;

  const planType = toTitleCase(transaction.planType);
  const billingCycle = toTitleCase(transaction.billingCycle);

  if (planType && billingCycle) {
    return `${planType} ${billingCycle} Subscription`;
  }

  if (billingCycle) {
    return `${billingCycle} Subscription`;
  }

  return "Subscription";
}

function mapSaleTransactionStatus(status) {
  if (!status) return null;

  const normalizedStatus = String(status).toLowerCase();
  const statusMap = {
    completed: "Paid",
    success: "Paid",
    successful: "Paid",
    paid: "Paid",
    pending: "Pending",
    processing: "Pending",
    failed: "Failed",
    cancelled: "Cancelled",
    canceled: "Cancelled",
    refunded: "Refunded",
  };

  return statusMap[normalizedStatus] || status;
}

function getSaleOrderId(transaction) {
  return (
    transaction.providerReference ||
    transaction.providerTransactionId ||
    transaction.serviceId ||
    null
  );
}

function mapSaleTransaction(transaction) {
  const customer = transaction.users_transactions_patientIdTousers || null;
  const date = transaction.completedAt || transaction.createdAt || null;

  return {
    id: transaction.id,
    orderId: getSaleOrderId(transaction),
    date: formatFinanceDate(date),
    status: mapSaleTransactionStatus(transaction.status),
    price: Number(transaction.originalAmount ?? transaction.usdAmount ?? 0),
    currency: transaction.originalCurrency || null,
    customerName: customer?.fullName || null,
    customerEmail: customer?.email || null,
    avatarUrl: customer?.profileImageUrl || null,
  };
}

function mapSubscriptionFinanceTransaction(transaction, subscriptionsById = {}) {
  const subscription = transaction.serviceId
    ? subscriptionsById[transaction.serviceId]
    : null;
  const payer =
    transaction.users_transactions_patientIdTousers ||
    transaction.users_transactions_doctorIdTousers ||
    subscription?.users ||
    null;
  const date = getCompletedTransactionDate(transaction);

  return {
    id: transaction.id,
    payerName: payer?.fullName || null,
    paymentMode: getPaymentMode(transaction),
    bank: getPaymentBankDisplay(transaction),
    amount: Number(transaction.originalAmount ?? transaction.usdAmount ?? 0),
    currency: transaction.originalCurrency || null,
    description: getSubscriptionDescription(transaction),
    date: formatFinanceDate(date),
    status: mapTransactionStatus(transaction.status),
    avatarUrl: payer?.profileImageUrl || null,
  };
}

function buildMonthlyRevenueRows(transactions, type) {
  const secondaryKey = type === "subscriptions" ? "subscriptions" : "sales";
  const months = MONTH_LABELS.map((monthItem) => ({
    month: monthItem.short,
    appointments: 0,
    [secondaryKey]: 0,
  }));

  transactions.forEach((transaction) => {
    const date = getCompletedTransactionDate(transaction);
    if (!date) return;

    const monthIndex = date.getUTCMonth();
    const amount = getTransactionAmount(transaction);

    if (transaction.serviceType === "appointment") {
      months[monthIndex].appointments += amount;
      return;
    }

    if (
      (type === "sales" && transaction.serviceType === "pharmacy") ||
      (type === "subscriptions" && transaction.serviceType === "subscription")
    ) {
      months[monthIndex][secondaryKey] += amount;
    }
  });

  return months.map((month) => ({
    ...month,
    appointments: roundMoney(month.appointments),
    [secondaryKey]: roundMoney(month[secondaryKey]),
  }));
}

function escapeCsvValue(value) {
  const text = value === null || value === undefined ? "" : String(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function buildFinanceRevenueCsv(data) {
  const secondaryKey = data.type === "subscriptions" ? "subscriptions" : "sales";
  const headers = ["month", "appointments", secondaryKey];
  const rows = data.months.map((month) =>
    headers.map((header) => escapeCsvValue(month[header])).join(","),
  );

  return [headers.join(","), ...rows].join("\n");
}

function buildAppointmentsOverviewCsv(data) {
  const headers = ["month", "appointments"];
  const rows = data.months.map((month) =>
    headers.map((header) => escapeCsvValue(month[header])).join(","),
  );

  return [headers.join(","), ...rows].join("\n");
}

function getChangeCard(value, current, previous) {
  const currentValue = Number(current || 0);
  const previousValue = Number(previous || 0);
  let trend = "neutral";
  let change = "0%";

  if (previousValue === 0 && currentValue > 0) {
    trend = "up";
    change = "+100%";
  } else if (previousValue > 0) {
    const changePercent =
      ((currentValue - previousValue) / previousValue) * 100;
    const roundedChange = Math.round((changePercent + Number.EPSILON) * 10) / 10;

    if (roundedChange > 0) {
      trend = "up";
      change = `+${roundedChange}%`;
    } else if (roundedChange < 0) {
      trend = "down";
      change = `${roundedChange}%`;
    }
  }

  return {
    value,
    change,
    trend,
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

function getAppointmentDateTime(appointment) {
  const date = appointment.appointmentDate;
  const time =
    appointment.doctorLocalTime ||
    appointment.appointmentTime ||
    appointment.appointmentTimeUTC;

  if (!date || !time) return date || null;

  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      time.getUTCHours(),
      time.getUTCMinutes(),
      time.getUTCSeconds(),
    ),
  );
}

function getTimelineCategory(appointment) {
  const normalizedStatus = String(appointment.status || "").toLowerCase();

  if (normalizedStatus === "cancelled" || normalizedStatus === "canceled") {
    return "cancelled";
  }

  if (normalizedStatus === "completed") {
    return "past";
  }

  const appointmentDateTime = getAppointmentDateTime(appointment);
  if (appointmentDateTime && appointmentDateTime < new Date()) {
    return "past";
  }

  return "upcoming";
}

function getTimelineSlotIndex(timeValue) {
  if (!timeValue) return null;

  const hour = timeValue.getUTCHours();
  if (hour < 7 || hour > 19) return null;

  return hour - 7;
}

function buildDoctorsWhere(query) {
  const where = {
    role: "doctor",
  };

  const andConditions = [];
  const searchQuery = String(query.search || "").trim();

  if (searchQuery) {
    andConditions.push({
      OR: [
        { fullName: { contains: searchQuery, mode: "insensitive" } },
        { email: { contains: searchQuery, mode: "insensitive" } },
        { phoneNumber: { contains: searchQuery, mode: "insensitive" } },
        {
          departmentSpecialty: {
            contains: searchQuery,
            mode: "insensitive",
          },
        },
        {
          doctor_profiles: {
            is: {
              contactNumber: {
                contains: searchQuery,
                mode: "insensitive",
              },
            },
          },
        },
      ],
    });
  }

  const department = String(query.department || "").trim();
  if (department) {
    andConditions.push({
      departmentSpecialty: {
        contains: department,
        mode: "insensitive",
      },
    });
  }

  const status = String(query.status || "")
    .trim()
    .toLowerCase();
  if (status) {
    if (!USER_STATUSES.includes(status)) {
      throw new ApiError(400, "Invalid status.");
    }

    where.status = status;
  }

  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  return where;
}

function buildPatientsWhere(query) {
  const where = {
    role: "patient",
  };

  const andConditions = [];
  const searchQuery = String(query.search || "").trim();

  if (searchQuery) {
    andConditions.push({
      OR: [
        { fullName: { contains: searchQuery, mode: "insensitive" } },
        { email: { contains: searchQuery, mode: "insensitive" } },
        { phoneNumber: { contains: searchQuery, mode: "insensitive" } },
        {
          patient_profiles: {
            is: {
              mobileNumber: {
                contains: searchQuery,
                mode: "insensitive",
              },
            },
          },
        },
      ],
    });
  }

  const profileType = String(query.profileType || "").trim();
  if (profileType) {
    andConditions.push({
      patient_profiles: {
        is: {
          profileType: {
            equals: profileType,
            mode: "insensitive",
          },
        },
      },
    });
  }

  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  return where;
}

function buildLabsWhere(query) {
  const searchQuery = String(query.search || "").trim();

  if (!searchQuery) {
    return {};
  }

  return {
    OR: [
      { facilityName: { contains: searchQuery, mode: "insensitive" } },
      { email: { contains: searchQuery, mode: "insensitive" } },
      { phone: { contains: searchQuery, mode: "insensitive" } },
      { address: { contains: searchQuery, mode: "insensitive" } },
      { city: { contains: searchQuery, mode: "insensitive" } },
      { state: { contains: searchQuery, mode: "insensitive" } },
      { country: { contains: searchQuery, mode: "insensitive" } },
      { adminFullName: { contains: searchQuery, mode: "insensitive" } },
      { adminEmail: { contains: searchQuery, mode: "insensitive" } },
      { adminPhone: { contains: searchQuery, mode: "insensitive" } },
    ],
  };
}

function buildPharmaciesWhere(query) {
  const searchQuery = String(query.search || "").trim();

  if (!searchQuery) {
    return {};
  }

  return {
    OR: [
      { pharmacyName: { contains: searchQuery, mode: "insensitive" } },
      { email: { contains: searchQuery, mode: "insensitive" } },
      { phone: { contains: searchQuery, mode: "insensitive" } },
      { address: { contains: searchQuery, mode: "insensitive" } },
      { primaryContactPerson: { contains: searchQuery, mode: "insensitive" } },
      { preferredUsername: { contains: searchQuery, mode: "insensitive" } },
      { registrationNumber: { contains: searchQuery, mode: "insensitive" } },
      { licenseNumber: { contains: searchQuery, mode: "insensitive" } },
      {
        users: {
          is: {
            fullName: { contains: searchQuery, mode: "insensitive" },
          },
        },
      },
      {
        users: {
          is: {
            email: { contains: searchQuery, mode: "insensitive" },
          },
        },
      },
      {
        users: {
          is: {
            phoneNumber: { contains: searchQuery, mode: "insensitive" },
          },
        },
      },
    ],
  };
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

function mapDoctorRow(doctor, patientCounts) {
  const profile = doctor.doctor_profiles;
  const license = profile?.professional_licenses;

  return {
    id: doctor.id,
    name: doctor.fullName,
    department: doctor.departmentSpecialty || null,
    email: doctor.email,
    phone: doctor.phoneNumber || profile?.contactNumber || null,
    patients: patientCounts.get(doctor.id) || 0,
    experience: license?.yearsOfExperience || 0,
    rating: Number(doctor.averageRating || 0),
    status: doctor.status,
    joiningDate: formatJoiningDate(doctor.createdAt),
    avatarUrl: doctor.profileImageUrl || profile?.profilePhoto || null,
  };
}

function mapPatientRow(patient) {
  const profile = patient.patient_profiles;

  return {
    id: patient.id,
    name: patient.fullName,
    profileType: profile?.profileType || null,
    email: patient.email,
    phone: patient.phoneNumber || profile?.mobileNumber || null,
    joiningDate: formatJoiningDate(patient.createdAt),
    avatarUrl: patient.profileImageUrl || profile?.profilePhoto || null,
  };
}

function mapPharmacyRow(pharmacy) {
  return {
    id: pharmacy.id,
    name: pharmacy.pharmacyName || null,
    location: pharmacy.address || null,
    email: pharmacy.email || pharmacy.users?.email || null,
    phone: pharmacy.phone || pharmacy.users?.phoneNumber || null,
    joiningDate: formatJoiningDate(pharmacy.createdAt),
    avatarUrl: pharmacy.logoUrl || pharmacy.users?.profileImageUrl || null,
  };
}

function mapPharmacyStatus(verificationStatus, isActive) {
  const normalizedStatus = String(verificationStatus || "").toLowerCase();

  if (normalizedStatus === "approved") {
    return isActive === false ? "suspended" : "active";
  }

  if (normalizedStatus === "suspended") {
    return "suspended";
  }

  return "pending";
}

function hasPharmacyDeliveryCapacity(serviceRadius) {
  if (serviceRadius === undefined || serviceRadius === null) return false;

  const radius = Number(serviceRadius);
  return Number.isFinite(radius) && radius > 0;
}

function normalizePharmacyDocumentType(documentType) {
  const normalizedType = String(documentType || "")
    .trim()
    .toLowerCase();

  if (["government_id", "gov_id", "id_card"].includes(normalizedType)) {
    return "government_id";
  }

  if (
    ["business_registration", "registration_document", "registration"].includes(
      normalizedType,
    )
  ) {
    return "registration_document";
  }

  if (["pharmacy_license", "license"].includes(normalizedType)) {
    return "license";
  }

  return null;
}

function getPharmacyDocumentLabel(type) {
  if (type === "government_id") return "Government Approved I.D";
  if (type === "registration_document") return "Registration Document";
  if (type === "license") return "License";

  return null;
}

function formatTimeAgo(date) {
  if (!date) return null;

  const diffMs = Date.now() - new Date(date).getTime();
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 60) return "just now";

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} ${diffMinutes === 1 ? "minute" : "minutes"} ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} ${diffHours === 1 ? "hour" : "hours"} ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} ${diffDays === 1 ? "day" : "days"} ago`;

  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths} ${diffMonths === 1 ? "month" : "months"} ago`;

  const diffYears = Math.floor(diffDays / 365);
  return `${diffYears} ${diffYears === 1 ? "year" : "years"} ago`;
}

function formatFileSizeMb(value) {
  if (value === undefined || value === null) return null;

  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return null;

  return Math.round((bytes / (1024 * 1024) + Number.EPSILON) * 100) / 100;
}

function getDocumentFileType(file) {
  return file?.mime_type || inferFileType(file?.file_path);
}

function mapPharmacyDocument(document) {
  const type = normalizePharmacyDocumentType(document.documentType);
  if (!type) return null;

  const file = document.document_files;

  return {
    id: document.id,
    type,
    label: getPharmacyDocumentLabel(type),
    fileUrl: file?.file_path || null,
    fileType: getDocumentFileType(file),
    fileSizeMb: formatFileSizeMb(file?.file_size),
  };
}

function mapPharmacyDetail(pharmacy) {
  const user = pharmacy.users;

  return {
    id: pharmacy.id,
    businessName: pharmacy.pharmacyName || null,
    registrationNumber: pharmacy.registrationNumber || null,
    businessAddress: pharmacy.address || null,
    pharmacyWebsite: pharmacy.website || null,
    hours: formatOperatingHours(pharmacy.operatingHours),
    deliveryCapacity: hasPharmacyDeliveryCapacity(pharmacy.serviceRadius),
    staffCount: 0,
    contactName: pharmacy.primaryContactPerson || user?.fullName || null,
    phone: pharmacy.phone || user?.phoneNumber || null,
    email: pharmacy.email || user?.email || null,
    location: pharmacy.address || null,
    registrationDate: formatJoiningDate(pharmacy.createdAt),
    status: mapPharmacyStatus(pharmacy.verificationStatus, pharmacy.isActive),
    avatarUrl: pharmacy.logoUrl || user?.profileImageUrl || null,
  };
}

function formatLabLocation(lab) {
  const locationParts = [lab.city, lab.state, lab.country].filter(Boolean);
  if (locationParts.length > 0) {
    return locationParts.join(", ");
  }

  return lab.address || null;
}

function mapLabRow(lab) {
  return {
    id: lab.id,
    name: lab.facilityName || null,
    location: formatLabLocation(lab),
    email: lab.email || null,
    phone: lab.phone || null,
    joiningDate: formatJoiningDate(lab.createdAt),
    avatarUrl:
      lab.users_lab_facilities_adminUserIdTousers?.profileImageUrl || null,
  };
}

function formatOperatingHours(operatingHours) {
  if (operatingHours === undefined || operatingHours === null || operatingHours === "") {
    return null;
  }

  if (typeof operatingHours === "string") {
    return operatingHours.trim() || null;
  }

  try {
    return JSON.stringify(operatingHours);
  } catch {
    return null;
  }
}

function mapLabStatus(status) {
  const normalizedStatus = String(status || "").toLowerCase();

  if (normalizedStatus === "approved" || normalizedStatus === "active") {
    return "active";
  }

  if (normalizedStatus === "suspended") {
    return "suspended";
  }

  return "pending";
}

function getLabStaffGroup(role) {
  const normalizedRole = String(role || "").toLowerCase();

  if (normalizedRole === "sample_collector") return "Sample Collector";
  if (normalizedRole === "radiologist") return "Radiologists";
  if (normalizedRole === "result_reviewer") return "Result Reviewer";
  if (normalizedRole === "lab_technician") return "Result Entry";

  return "Result Entry";
}

function formatStaffExperience(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return `${value} years experience`;

  return String(value).trim() || null;
}

function mapLabStaffMember(staff) {
  return {
    id: staff.id,
    name: staff.fullName || null,
    experience: formatStaffExperience(staff.yearsOfExperience),
    phone: staff.phone || null,
    avatarUrl: null,
  };
}

function inferFileType(fileUrl) {
  if (!fileUrl) return null;

  const sanitizedUrl = String(fileUrl).split("?")[0].split("#")[0];
  const match = sanitizedUrl.match(/\.([a-z0-9]+)$/i);

  return match ? match[1].toLowerCase() : null;
}

function mapLabDocument({ id, type, label, fileUrl }) {
  return {
    id,
    type,
    label,
    fileUrl: fileUrl || null,
    fileType: inferFileType(fileUrl),
    fileSizeMb: null,
  };
}

function mapLabDocuments(lab) {
  return [
    mapLabDocument({
      id: "government_id",
      type: "government_id",
      label: "Government Approved I.D",
      fileUrl: lab.govIdUrl,
    }),
    mapLabDocument({
      id: "registration_document",
      type: "registration_document",
      label: "Registration Document",
      fileUrl: lab.registrationDocument || lab.businessRegistrationUrl,
    }),
    mapLabDocument({
      id: "license",
      type: "license",
      label: "License",
      fileUrl: lab.licenseDocument,
    }),
  ];
}

function groupLabStaff(staffRows) {
  const groups = LAB_STAFF_GROUPS.map((role) => ({
    role,
    members: [],
  }));
  const groupMap = new Map(groups.map((group) => [group.role, group]));

  for (const staff of staffRows) {
    const groupName = getLabStaffGroup(staff.role);
    groupMap.get(groupName).members.push(mapLabStaffMember(staff));
  }

  return {
    staffCount: staffRows.length,
    groups,
  };
}

function getEmptyStaffGroups() {
  return {
    staffCount: 0,
    groups: LAB_STAFF_GROUPS.map((role) => ({
      role,
      members: [],
    })),
  };
}

function mapLabDetail(lab, staffCount) {
  const admin = lab.users_lab_facilities_adminUserIdTousers;

  return {
    id: lab.id,
    businessName: lab.facilityName || null,
    registrationNumber: lab.registrationNumber || null,
    businessAddress: lab.address || null,
    labWebsite: lab.website || null,
    hours: formatOperatingHours(lab.operatingHours),
    deliveryCapacity: false,
    staffCount,
    contactName: lab.adminFullName || admin?.fullName || null,
    phone: lab.phone || lab.adminPhone || null,
    email: lab.email || lab.adminEmail || null,
    location: formatLabLocation(lab),
    registrationDate: formatJoiningDate(lab.createdAt),
    status: mapLabStatus(lab.status),
    avatarUrl: admin?.profileImageUrl || null,
  };
}

function calculateAge(dateOfBirth) {
  if (!dateOfBirth || Number.isNaN(dateOfBirth.getTime())) return null;

  const now = new Date();
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const hasBirthdayPassed =
    now.getUTCMonth() > dateOfBirth.getUTCMonth() ||
    (now.getUTCMonth() === dateOfBirth.getUTCMonth() &&
      now.getUTCDate() >= dateOfBirth.getUTCDate());

  if (!hasBirthdayPassed) {
    age -= 1;
  }

  return age >= 0 ? age : null;
}

function formatMeasurement(value, unit) {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value === "number") {
    return `${value} ${unit}`;
  }

  const textValue = String(value).trim();
  if (!textValue) return null;

  return new RegExp(`\\b${unit}\\b`, "i").test(textValue)
    ? textValue
    : `${textValue} ${unit}`;
}

function mapPatientAllergies(profile) {
  if (!profile?.allergies) return [];

  const allergies = Array.isArray(profile.allergies)
    ? profile.allergies
    : [profile.allergies];

  return allergies
    .map((allergy) => allergy?.allergen || allergy?.type || allergy?.description)
    .filter(Boolean);
}

function mapPatientDetail(patient) {
  const profile = patient.patient_profiles;

  return {
    id: patient.id,
    name: patient.fullName,
    email: patient.email,
    location: patient.country || profile?.nationality || null,
    profileType: profile?.profileType || null,
    sex: profile?.gender || null,
    age: calculateAge(profile?.dateOfBirth),
    bloodGroup: profile?.bloodGroup || null,
    genotype: profile?.genotype || null,
    height: formatMeasurement(profile?.height, "cm"),
    weight: formatMeasurement(profile?.weight, "kg"),
    allergies: mapPatientAllergies(profile),
    homeAddress: profile?.address || null,
    workAddress: null,
    avatarUrl: patient.profileImageUrl || profile?.profilePhoto || null,
  };
}

function getHistorySortTime(item) {
  return item.sortDate ? item.sortDate.getTime() : 0;
}

function stringifyNotes(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function mapMedicalConditionHistory(condition) {
  return {
    id: condition.id,
    date: formatDateYYYYMMDD(condition.createdAt),
    type: "Diagnosis",
    title: condition.name || null,
    doctor: null,
    department: null,
    notes: condition.status || null,
    attachments: [],
    sortDate: condition.createdAt,
  };
}

function mapSurgeryHistory(surgery) {
  return {
    id: surgery.id,
    date: formatDateYYYYMMDD(surgery.date || surgery.createdAt),
    type: "Procedure",
    title: surgery.name || null,
    doctor: null,
    department: null,
    notes: surgery.location || null,
    attachments: [],
    sortDate: surgery.date || surgery.createdAt,
  };
}

function mapAppointmentVisitHistory(appointment) {
  const doctor = appointment.users_appointments_doctorIdTousers;

  return {
    id: appointment.id,
    date: formatDateYYYYMMDD(appointment.appointmentDate),
    type: "Visit",
    title: appointment.reason || appointment.type || "Visit",
    doctor: doctor?.fullName || null,
    department: doctor?.departmentSpecialty || null,
    notes:
      appointment.notes ||
      stringifyNotes(appointment.symptoms) ||
      appointment.cancellationReason ||
      null,
    attachments: [],
    sortDate: appointment.appointmentDate || appointment.createdAt,
  };
}

function paginateHistory(rows, page, limit) {
  const sortedRows = rows.sort(
    (left, right) => getHistorySortTime(right) - getHistorySortTime(left),
  );
  const total = sortedRows.length;
  const start = (page - 1) * limit;

  return {
    total,
    page,
    limit,
    history: sortedRows.slice(start, start + limit).map((row) => ({
      id: row.id,
      date: row.date,
      type: row.type,
      title: row.title,
      doctor: row.doctor,
      department: row.department,
      notes: row.notes,
      attachments: row.attachments,
    })),
  };
}

function parseRecordType(value) {
  const type = String(value || "all")
    .trim()
    .toLowerCase();

  if (!RECORD_TYPES.includes(type)) {
    throw new ApiError(400, "Invalid type.");
  }

  return type;
}

function normalizeRecordType(documentType) {
  const value = String(documentType || "").toLowerCase();

  if (/(lab|laboratory|test|result)/.test(value)) return "lab";
  if (/(imaging|image|radiology|scan|xray|x-ray|mri|ct|ultrasound)/.test(value)) {
    return "imaging";
  }
  if (/(prescription|medication|drug)/.test(value)) return "prescription";
  if (/referral/.test(value)) return "referral";

  return "other";
}

function formatFileSizeKb(value) {
  if (value === undefined || value === null) return null;

  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return null;

  return Math.round(bytes / 1024);
}

function mapPatientRecord(file) {
  return {
    id: file.id,
    type: normalizeRecordType(file.document_type),
    title: file.original_file_name || file.stored_file_name || file.document_type || null,
    uploadedBy: file.users?.fullName || null,
    uploadedAt: formatDateYYYYMMDD(file.created_at),
    fileUrl: file.file_path || null,
    fileType: file.mime_type || null,
    fileSizeKb: formatFileSizeKb(file.file_size),
  };
}

function paginateRecords(rows, type, page, limit) {
  const filteredRows =
    type === "all" ? rows : rows.filter((row) => row.type === type);
  const total = filteredRows.length;
  const start = (page - 1) * limit;

  return {
    total,
    page,
    limit,
    records: filteredRows.slice(start, start + limit),
  };
}

function getDoctorDetailSpecialty(doctor) {
  const license = doctor?.doctor_profiles?.professional_licenses;
  const specializations = Array.isArray(license?.areasOfSpecialization)
    ? license.areasOfSpecialization.filter(Boolean)
    : [];

  if (specializations.length > 0) {
    return specializations.join(", ");
  }

  return license?.subspecialty || doctor.departmentSpecialty || null;
}

function getAvailabilitySummary(availabilityRows = []) {
  const sortedRows = [...availabilityRows].sort((left, right) => {
    const leftDay = DAY_ORDER.indexOf(left.dayOfWeek);
    const rightDay = DAY_ORDER.indexOf(right.dayOfWeek);

    if (leftDay !== rightDay) return leftDay - rightDay;
    return left.startTime.getTime() - right.startTime.getTime();
  });

  const workingDays = Array.from(
    new Set(
      sortedRows
        .map((row) => DAY_LABELS[row.dayOfWeek])
        .filter(Boolean),
    ),
  );

  const timeRanges = sortedRows
    .map((row) => ({
      day: row.dayOfWeek,
      start: formatTimeHHMM(row.startTime),
      end: formatTimeHHMM(row.endTime),
    }))
    .filter((row) => row.start && row.end);

  if (timeRanges.length === 0) {
    return {
      workingDays,
      workingHours: null,
    };
  }

  const uniqueRanges = new Set(
    timeRanges.map((row) => `${row.start} - ${row.end}`),
  );

  if (uniqueRanges.size === 1) {
    return {
      workingDays,
      workingHours: [...uniqueRanges][0],
    };
  }

  return {
    workingDays,
    workingHours: timeRanges
      .map(
        (row) =>
          `${DAY_SHORT_LABELS[row.day] || row.day} ${row.start}-${row.end}`,
      )
      .join(", "),
  };
}

function mapDoctorDetail(doctor, patients) {
  const profile = doctor.doctor_profiles;
  const license = profile?.professional_licenses;
  const { workingDays, workingHours } = getAvailabilitySummary(
    doctor.doctor_availability,
  );

  return {
    id: doctor.id,
    name: doctor.fullName,
    hospital: license?.medicalInstitution || null,
    email: doctor.email,
    phone: doctor.phoneNumber || profile?.contactNumber || null,
    department: doctor.departmentSpecialty || null,
    specialty: getDoctorDetailSpecialty(doctor),
    patients,
    experience: license?.yearsOfExperience || 0,
    rating: Number(doctor.averageRating || 0),
    location: doctor.country || profile?.nationality || null,
    address: profile?.residentialAddress || null,
    bio: null,
    workingDays,
    workingHours,
    avatarUrl: doctor.profileImageUrl || profile?.profilePhoto || null,
  };
}

function mapTimelineAppointment(appointment, doctor) {
  const timeValue =
    appointment.doctorLocalTime ||
    appointment.appointmentTime ||
    appointment.appointmentTimeUTC;

  return {
    id: appointment.id,
    patientName:
      appointment.users_appointments_patientIdTousers?.fullName || null,
    specialty: appointment.type || appointment.reason || getNullableSpecialty(doctor),
    date: formatDateYYYYMMDD(appointment.appointmentDate),
    time: formatTimeHHMM(timeValue),
    slotIndex: getTimelineSlotIndex(timeValue),
    index: 1,
    total: 1,
  };
}

function mapPatientTimelineAppointment(appointment) {
  const doctor = appointment.users_appointments_doctorIdTousers;
  const timeValue =
    appointment.patientLocalTime ||
    appointment.appointmentTime ||
    appointment.doctorLocalTime ||
    appointment.appointmentTimeUTC;

  return {
    id: appointment.id,
    doctorName: doctor?.fullName || null,
    specialty: getNullableSpecialty(doctor) || appointment.type || appointment.reason || null,
    date: formatDateYYYYMMDD(appointment.appointmentDate),
    time: formatTimeHHMM(timeValue),
    slotIndex: getTimelineSlotIndex(timeValue),
    index: 1,
    total: 1,
  };
}

function getLicenseTitle(license) {
  const specializations = Array.isArray(license.areasOfSpecialization)
    ? license.areasOfSpecialization.filter(Boolean)
    : [];

  return (
    specializations.join(", ") ||
    license.subspecialty ||
    license.licenseAuthority ||
    "Professional License"
  );
}

function getCertificateTitle(certificate) {
  return (
    certificate.certificateName ||
    certificate.degree ||
    certificate.fieldOfStudy ||
    null
  );
}

function getCertificationSortTime(item) {
  if (item.sortDate) {
    return item.sortDirection === "desc"
      ? -item.sortDate.getTime()
      : item.sortDate.getTime();
  }

  return item.stableIndex;
}

function mapLicenseCertification(license, stableIndex) {
  return {
    id: license.id,
    title: getLicenseTitle(license),
    licenseNumber: license.medicalLicenseNumber || null,
    expiryDate: formatDateYYYYMMDD(license.licenseExpiryDate),
    imageUrl: license.licenseDocument || null,
    sortDate: license.createdAt || license.licenseExpiryDate || null,
    sortDirection: license.createdAt ? "desc" : "asc",
    stableIndex,
  };
}

function mapCertificateCertification(certificate, stableIndex) {
  return {
    id: certificate.id,
    title: getCertificateTitle(certificate),
    licenseNumber: certificate.verificationLink || null,
    expiryDate: formatDateYYYYMMDD(certificate.expiryDate),
    imageUrl: certificate.certificateDocument || null,
    sortDate: certificate.createdAt || certificate.issueDate || certificate.expiryDate || null,
    sortDirection: certificate.createdAt || certificate.issueDate ? "desc" : "asc",
    stableIndex,
  };
}

function normalizeCertifications(licenses, certificates) {
  const rows = [
    ...licenses.map((license, index) =>
      mapLicenseCertification(license, index),
    ),
    ...certificates.map((certificate, index) =>
      mapCertificateCertification(certificate, licenses.length + index),
    ),
  ];

  return rows
    .sort((left, right) => {
      const sortDifference =
        getCertificationSortTime(left) - getCertificationSortTime(right);

      if (sortDifference !== 0) return sortDifference;
      return left.stableIndex - right.stableIndex;
    })
    .map((row, index) => ({
      id: row.id,
      index: index + 1,
      title: row.title,
      licenseNumber: row.licenseNumber,
      expiryDate: row.expiryDate,
      imageUrl: row.imageUrl,
    }));
}

function applyTimelineSlotIndexes(appointments) {
  const slots = new Map();

  for (const appointment of appointments) {
    const key =
      appointment.slotIndex === null ? `outside-${appointment.id}` : appointment.slotIndex;

    if (!slots.has(key)) {
      slots.set(key, []);
    }

    slots.get(key).push(appointment);
  }

  for (const slotAppointments of slots.values()) {
    const total = slotAppointments.length;
    slotAppointments.forEach((appointment, index) => {
      appointment.index = index + 1;
      appointment.total = total;
    });
  }
}

function groupTimelineAppointments(rows, doctor) {
  const grouped = {
    upcoming: [],
    past: [],
    cancelled: [],
  };

  for (const row of rows) {
    const category = getTimelineCategory(row);
    grouped[category].push(mapTimelineAppointment(row, doctor));
  }

  applyTimelineSlotIndexes(grouped.upcoming);
  applyTimelineSlotIndexes(grouped.past);
  applyTimelineSlotIndexes(grouped.cancelled);

  return grouped;
}

function groupPatientTimelineAppointments(rows) {
  const grouped = {
    upcoming: [],
    past: [],
    cancelled: [],
  };

  for (const row of rows) {
    const category = getTimelineCategory(row);
    grouped[category].push(mapPatientTimelineAppointment(row));
  }

  applyTimelineSlotIndexes(grouped.upcoming);
  applyTimelineSlotIndexes(grouped.past);
  applyTimelineSlotIndexes(grouped.cancelled);

  return grouped;
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
  async getPharmacies(query = {}) {
    const page = parsePositiveInteger(query.page, "page", {
      defaultValue: 1,
    });
    const limit = parsePositiveInteger(query.limit, "limit", {
      defaultValue: 20,
      max: 100,
    });
    const skip = (page - 1) * limit;
    const where = buildPharmaciesWhere(query);

    const [rows, total] = await Promise.all([
      mainPrisma.pharmacy_profiles.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ createdAt: "desc" }, { pharmacyName: "asc" }],
        select: PHARMACY_SELECT,
      }),
      mainPrisma.pharmacy_profiles.count({ where }),
    ]);

    return {
      total,
      page,
      limit,
      pharmacies: rows.map(mapPharmacyRow),
    };
  }

  async getPharmacyById(id) {
    const pharmacyId = assertValidUuid(id, "pharmacy id");

    const pharmacy = await mainPrisma.pharmacy_profiles.findUnique({
      where: {
        id: pharmacyId,
      },
      select: PHARMACY_DETAIL_SELECT,
    });

    if (!pharmacy) {
      throw new ApiError(404, "Pharmacy not found.");
    }

    return mapPharmacyDetail(pharmacy);
  }

  async getPharmacyStaff(id) {
    const pharmacyId = assertValidUuid(id, "pharmacy id");

    const pharmacy = await mainPrisma.pharmacy_profiles.findUnique({
      where: {
        id: pharmacyId,
      },
      select: {
        id: true,
      },
    });

    if (!pharmacy) {
      throw new ApiError(404, "Pharmacy not found.");
    }

    return getEmptyStaffGroups();
  }

  async getPharmacyDocuments(id) {
    const pharmacyId = assertValidUuid(id, "pharmacy id");

    const pharmacy = await mainPrisma.pharmacy_profiles.findUnique({
      where: {
        id: pharmacyId,
      },
      select: {
        id: true,
      },
    });

    if (!pharmacy) {
      throw new ApiError(404, "Pharmacy not found.");
    }

    const documents = await mainPrisma.pharmacy_documents.findMany({
      where: {
        pharmacyId,
      },
      orderBy: {
        createdAt: "desc",
      },
      select: PHARMACY_DOCUMENT_SELECT,
    });

    return documents.map(mapPharmacyDocument).filter(Boolean);
  }

  async getLabs(query = {}) {
    const page = parsePositiveInteger(query.page, "page", {
      defaultValue: 1,
    });
    const limit = parsePositiveInteger(query.limit, "limit", {
      defaultValue: 20,
      max: 100,
    });
    const skip = (page - 1) * limit;
    const where = buildLabsWhere(query);

    const [rows, total] = await Promise.all([
      mainPrisma.lab_facilities.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ createdAt: "desc" }, { facilityName: "asc" }],
        select: LAB_SELECT,
      }),
      mainPrisma.lab_facilities.count({ where }),
    ]);

    return {
      total,
      page,
      limit,
      labs: rows.map(mapLabRow),
    };
  }

  async getLabById(id) {
    const labId = assertValidUuid(id, "lab id");

    const lab = await mainPrisma.lab_facilities.findUnique({
      where: {
        id: labId,
      },
      select: LAB_DETAIL_SELECT,
    });

    if (!lab) {
      throw new ApiError(404, "Lab not found.");
    }

    const staffCount = await mainPrisma.lab_personnel.count({
      where: {
        facilityId: labId,
      },
    });

    return mapLabDetail(lab, staffCount);
  }

  async getLabStaff(id) {
    const labId = assertValidUuid(id, "lab id");

    const lab = await mainPrisma.lab_facilities.findUnique({
      where: {
        id: labId,
      },
      select: {
        id: true,
      },
    });

    if (!lab) {
      throw new ApiError(404, "Lab not found.");
    }

    const staffRows = await mainPrisma.lab_personnel.findMany({
      where: {
        facilityId: labId,
      },
      orderBy: [
        { role: "asc" },
        { fullName: "asc" },
      ],
      select: LAB_STAFF_SELECT,
    });

    return groupLabStaff(staffRows);
  }

  async getLabDocuments(id) {
    const labId = assertValidUuid(id, "lab id");

    const lab = await mainPrisma.lab_facilities.findUnique({
      where: {
        id: labId,
      },
      select: LAB_DOCUMENT_SELECT,
    });

    if (!lab) {
      throw new ApiError(404, "Lab not found.");
    }

    return mapLabDocuments(lab);
  }

  async getPatients(query = {}) {
    const page = parsePositiveInteger(query.page, "page", {
      defaultValue: 1,
    });
    const limit = parsePositiveInteger(query.limit, "limit", {
      defaultValue: 20,
      max: 100,
    });
    const skip = (page - 1) * limit;
    const where = buildPatientsWhere(query);

    const [rows, total] = await Promise.all([
      mainPrisma.users.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ createdAt: "desc" }, { fullName: "asc" }],
        select: PATIENT_SELECT,
      }),
      mainPrisma.users.count({ where }),
    ]);

    return {
      total,
      page,
      limit,
      patients: rows.map(mapPatientRow),
    };
  }

  async getPatientById(id) {
    const patientId = assertValidUuid(id, "patient id");

    const patient = await mainPrisma.users.findFirst({
      where: {
        id: patientId,
        role: "patient",
      },
      select: PATIENT_DETAIL_SELECT,
    });

    if (!patient) {
      throw new ApiError(404, "Patient not found.");
    }

    return mapPatientDetail(patient);
  }

  async getPatientAppointmentsTimeline(id, query = {}) {
    const patientId = assertValidUuid(id, "patient id");
    const selectedDate = parseDateQuery(query.date);
    const nextDate = new Date(selectedDate);
    nextDate.setUTCDate(selectedDate.getUTCDate() + 1);

    const patient = await mainPrisma.users.findFirst({
      where: {
        id: patientId,
        role: "patient",
      },
      select: {
        id: true,
      },
    });

    if (!patient) {
      throw new ApiError(404, "Patient not found.");
    }

    const appointments = await mainPrisma.appointments.findMany({
      where: {
        patientId,
        appointmentDate: {
          gte: selectedDate,
          lt: nextDate,
        },
      },
      orderBy: [
        { appointmentTime: "asc" },
        { createdAt: "asc" },
      ],
      select: PATIENT_TIMELINE_APPOINTMENT_SELECT,
    });

    return {
      date: formatDateYYYYMMDD(selectedDate),
      ...groupPatientTimelineAppointments(appointments),
    };
  }

  async getPatientMedicalHistory(id, query = {}) {
    const patientId = assertValidUuid(id, "patient id");
    const page = parsePositiveInteger(query.page, "page", {
      defaultValue: 1,
    });
    const limit = parsePositiveInteger(query.limit, "limit", {
      defaultValue: 20,
      max: 100,
    });

    const patient = await mainPrisma.users.findFirst({
      where: {
        id: patientId,
        role: "patient",
      },
      select: {
        id: true,
        patient_profiles: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!patient) {
      throw new ApiError(404, "Patient not found.");
    }

    const patientProfileId = patient.patient_profiles?.id;
    if (!patientProfileId) {
      return {
        total: 0,
        page,
        limit,
        history: [],
      };
    }

    const today = getStartOfToday();
    const [conditions, surgeries, visits] = await Promise.all([
      mainPrisma.medical_conditions.findMany({
        where: {
          patientProfileId,
        },
        select: {
          id: true,
          name: true,
          status: true,
          createdAt: true,
        },
      }),
      mainPrisma.surgeries.findMany({
        where: {
          patientProfileId,
        },
        select: {
          id: true,
          name: true,
          date: true,
          location: true,
          createdAt: true,
        },
      }),
      mainPrisma.appointments.findMany({
        where: {
          patientId,
          isCancelled: false,
          status: {
            not: "cancelled",
          },
          OR: [
            {
              status: "completed",
            },
            {
              appointmentDate: {
                lt: today,
              },
            },
          ],
        },
        select: {
          id: true,
          appointmentDate: true,
          type: true,
          reason: true,
          notes: true,
          symptoms: true,
          cancellationReason: true,
          createdAt: true,
          users_appointments_doctorIdTousers: {
            select: {
              fullName: true,
              departmentSpecialty: true,
            },
          },
        },
      }),
    ]);

    return paginateHistory(
      [
        ...conditions.map(mapMedicalConditionHistory),
        ...surgeries.map(mapSurgeryHistory),
        ...visits.map(mapAppointmentVisitHistory),
      ],
      page,
      limit,
    );
  }

  async getPatientRecords(id, query = {}) {
    const patientId = assertValidUuid(id, "patient id");
    const type = parseRecordType(query.type);
    const page = parsePositiveInteger(query.page, "page", {
      defaultValue: 1,
    });
    const limit = parsePositiveInteger(query.limit, "limit", {
      defaultValue: 20,
      max: 100,
    });

    const patient = await mainPrisma.users.findFirst({
      where: {
        id: patientId,
        role: "patient",
      },
      select: {
        id: true,
      },
    });

    if (!patient) {
      throw new ApiError(404, "Patient not found.");
    }

    const files = await mainPrisma.document_files.findMany({
      where: {
        document_folders: {
          is: {
            owner_id: patientId,
          },
        },
      },
      orderBy: {
        created_at: "desc",
      },
      select: {
        id: true,
        document_type: true,
        original_file_name: true,
        stored_file_name: true,
        created_at: true,
        file_path: true,
        mime_type: true,
        file_size: true,
        users: {
          select: {
            fullName: true,
          },
        },
      },
    });

    return paginateRecords(files.map(mapPatientRecord), type, page, limit);
  }

  async getDoctors(query = {}) {
    const page = parsePositiveInteger(query.page, "page", {
      defaultValue: 1,
    });
    const limit = parsePositiveInteger(query.limit, "limit", {
      defaultValue: 20,
      max: 100,
    });
    const skip = (page - 1) * limit;
    const where = buildDoctorsWhere(query);

    const [rows, total] = await Promise.all([
      mainPrisma.users.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ createdAt: "desc" }, { fullName: "asc" }],
        select: DOCTOR_SELECT,
      }),
      mainPrisma.users.count({ where }),
    ]);

    const doctorIds = rows.map((doctor) => doctor.id);
    const patientCounts = new Map();

    if (doctorIds.length > 0) {
      const doctorPatientPairs = await mainPrisma.appointments.groupBy({
        by: ["doctorId", "patientId"],
        where: {
          doctorId: {
            in: doctorIds,
          },
        },
      });

      for (const pair of doctorPatientPairs) {
        patientCounts.set(
          pair.doctorId,
          (patientCounts.get(pair.doctorId) || 0) + 1,
        );
      }
    }

    return {
      total,
      page,
      limit,
      doctors: rows.map((doctor) => mapDoctorRow(doctor, patientCounts)),
    };
  }

  async getDoctorById(id) {
    const doctorId = assertValidUuid(id, "doctor id");

    const doctor = await mainPrisma.users.findFirst({
      where: {
        id: doctorId,
        role: "doctor",
      },
      select: DOCTOR_DETAIL_SELECT,
    });

    if (!doctor) {
      throw new ApiError(404, "Doctor not found.");
    }

    const distinctPatients = await mainPrisma.appointments.groupBy({
      by: ["patientId"],
      where: {
        doctorId,
      },
    });

    return mapDoctorDetail(doctor, distinctPatients.length);
  }

  async getDoctorAppointmentsTimeline(id, query = {}) {
    const doctorId = assertValidUuid(id, "doctor id");
    const selectedDate = parseDateQuery(query.date);
    const nextDate = new Date(selectedDate);
    nextDate.setUTCDate(selectedDate.getUTCDate() + 1);

    const doctor = await mainPrisma.users.findFirst({
      where: {
        id: doctorId,
        role: "doctor",
      },
      select: DOCTOR_TIMELINE_SELECT,
    });

    if (!doctor) {
      throw new ApiError(404, "Doctor not found.");
    }

    const appointments = await mainPrisma.appointments.findMany({
      where: {
        doctorId,
        appointmentDate: {
          gte: selectedDate,
          lt: nextDate,
        },
      },
      orderBy: [
        { appointmentTime: "asc" },
        { createdAt: "asc" },
      ],
      select: DOCTOR_TIMELINE_APPOINTMENT_SELECT,
    });

    return {
      date: formatDateYYYYMMDD(selectedDate),
      ...groupTimelineAppointments(appointments, doctor),
    };
  }

  async getDoctorCertifications(id) {
    const doctorId = assertValidUuid(id, "doctor id");

    const doctor = await mainPrisma.users.findFirst({
      where: {
        id: doctorId,
        role: "doctor",
      },
      select: {
        id: true,
        doctor_profiles: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!doctor) {
      throw new ApiError(404, "Doctor not found.");
    }

    const doctorProfileId = doctor.doctor_profiles?.id;
    if (!doctorProfileId) {
      return [];
    }

    const [licenses, certificates] = await Promise.all([
      mainPrisma.professional_licenses.findMany({
        where: {
          doctorProfileId,
        },
        select: {
          id: true,
          medicalLicenseNumber: true,
          licenseAuthority: true,
          licenseExpiryDate: true,
          licenseDocument: true,
          yearsOfExperience: true,
          areasOfSpecialization: true,
          subspecialty: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      mainPrisma.professional_certificates.findMany({
        where: {
          doctorProfileId,
        },
        select: {
          id: true,
          degree: true,
          fieldOfStudy: true,
          certificateName: true,
          issueDate: true,
          expiryDate: true,
          certificateDocument: true,
          verificationLink: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
    ]);

    return normalizeCertifications(licenses, certificates);
  }

  async getDoctorRatings(id, query = {}) {
    const doctorId = assertValidUuid(id, "doctor id");
    const page = parsePositiveInteger(query.page, "page", {
      defaultValue: 1,
    });
    const limit = parsePositiveInteger(query.limit, "limit", {
      defaultValue: 20,
      max: 100,
    });

    const doctor = await mainPrisma.users.findFirst({
      where: {
        id: doctorId,
        role: "doctor",
      },
      select: {
        id: true,
      },
    });

    if (!doctor) {
      throw new ApiError(404, "Doctor not found.");
    }

    const where = { userId: doctorId };
    const skip = (page - 1) * limit;

    const [total, rows] = await Promise.all([
      mainPrisma.user_ratings.count({ where }),
      mainPrisma.user_ratings.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          rating: true,
          message: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      total,
      page,
      limit,
      ratings: rows.map((row) => ({
        id: row.id,
        reviewerName: null,
        stars: Number(row.rating),
        comment: row.message || null,
        timeAgo: formatTimeAgo(row.createdAt),
        avatar: null,
      })),
    };
  }

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

  async getFinanceStats() {
    const { current, previous } = getFinanceMonthRanges();

    const getCompletedTransactionSum = async ({
      serviceType,
      dateRange,
    } = {}) => {
      const aggregate = await mainPrisma.transactions.aggregate({
        where: {
          status: "completed",
          ...(serviceType ? { serviceType } : {}),
          ...getCompletedTransactionDateWhere(dateRange),
        },
        _sum: {
          usdAmount: true,
        },
      });

      return Number(aggregate._sum.usdAmount || 0);
    };

    const getCompletedAppointmentTransactionCount = async (dateRange) =>
      mainPrisma.transactions.count({
        where: {
          status: "completed",
          serviceType: "appointment",
          ...getCompletedTransactionDateWhere(dateRange),
        },
      });

    const getFinanceExpenseTotal = async (dateRange) => {
      const [
        doctorWithdrawalAggregate,
        pharmacyPayoutAggregate,
        refundAggregate,
      ] = await Promise.all([
        mainPrisma.wallet_withdrawals.aggregate({
          where: {
            status: "completed",
            ...(dateRange ? { completedAt: dateRange } : {}),
          },
          _sum: {
            amountUsd: true,
          },
        }),
        mainPrisma.pharmacy_payout_requests.aggregate({
          where: {
            status: "completed",
            ...(dateRange ? { processedAt: dateRange } : {}),
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
            refundAmount: {
              not: null,
            },
            ...(dateRange ? { refundProcessedAt: dateRange } : {}),
          },
          _sum: {
            refundAmount: true,
          },
        }),
      ]);

      return (
        Number(doctorWithdrawalAggregate._sum.amountUsd || 0) +
        Number(pharmacyPayoutAggregate._sum.amountUsd || 0) +
        Number(refundAggregate._sum.refundAmount || 0)
      );
    };

    const getNetBalance = async (dateRange) => {
      const [income, expenses] = await Promise.all([
        getCompletedTransactionSum({ dateRange }),
        getFinanceExpenseTotal(dateRange),
      ]);

      return roundMoney(income - expenses);
    };

    const [
      totalBalance,
      currentBalance,
      previousBalance,
      totalAppointments,
      currentAppointments,
      previousAppointments,
      totalSales,
      currentSales,
      previousSales,
    ] = await Promise.all([
      getNetBalance(),
      getNetBalance(current),
      getNetBalance(previous),
      getCompletedAppointmentTransactionCount(),
      getCompletedAppointmentTransactionCount(current),
      getCompletedAppointmentTransactionCount(previous),
      getCompletedTransactionSum({ serviceType: "pharmacy" }).then(roundMoney),
      getCompletedTransactionSum({
        serviceType: "pharmacy",
        dateRange: current,
      }).then(roundMoney),
      getCompletedTransactionSum({
        serviceType: "pharmacy",
        dateRange: previous,
      }).then(roundMoney),
    ]);

    return {
      totalBalance: getChangeCard(totalBalance, currentBalance, previousBalance),
      totalAppointments: getChangeCard(
        totalAppointments,
        currentAppointments,
        previousAppointments,
      ),
      totalSales: getChangeCard(totalSales, currentSales, previousSales),
    };
  }

  async getFinanceRevenueTracking(query = {}) {
    const { year, range, type, format } = parseFinanceRevenueTrackingQuery(query);
    const secondaryServiceType =
      type === "subscriptions" ? "subscription" : "pharmacy";

    const transactions = await mainPrisma.transactions.findMany({
      where: {
        status: "completed",
        serviceType: {
          in: ["appointment", secondaryServiceType],
        },
        ...getCompletedTransactionDateWhere(range),
      },
      select: {
        serviceType: true,
        usdAmount: true,
        originalAmount: true,
        completedAt: true,
        createdAt: true,
      },
      orderBy: [
        {
          completedAt: "asc",
        },
        {
          createdAt: "asc",
        },
      ],
    });

    const data = {
      year,
      type,
      months: buildMonthlyRevenueRows(transactions, type),
    };

    if (format === "csv") {
      return {
        format,
        filename: `healthnet-finance-revenue-tracking-${year}-${type}.csv`,
        csv: buildFinanceRevenueCsv(data),
        data,
      };
    }

    return {
      format,
      data,
    };
  }

  async getFinanceAppointmentsHistory(query = {}) {
    const { page, limit, skip, range } = parseFinanceHistoryQuery(query);
    const where = {
      status: "completed",
      serviceType: "appointment",
      ...getCompletedTransactionDateWhere(range),
    };

    const [transactions, total] = await Promise.all([
      mainPrisma.transactions.findMany({
        where,
        skip,
        take: limit,
        orderBy: [
          {
            completedAt: "desc",
          },
          {
            createdAt: "desc",
          },
        ],
        select: {
          id: true,
          patientId: true,
          doctorId: true,
          appointmentId: true,
          paymentMethodId: true,
          serviceType: true,
          originalAmount: true,
          originalCurrency: true,
          usdAmount: true,
          paymentProvider: true,
          providerTransactionId: true,
          providerReference: true,
          description: true,
          status: true,
          createdAt: true,
          completedAt: true,
          users_transactions_patientIdTousers: {
            select: {
              id: true,
              fullName: true,
              profileImageUrl: true,
            },
          },
          users_transactions_doctorIdTousers: {
            select: {
              id: true,
              fullName: true,
              profileImageUrl: true,
            },
          },
          user_payment_methods: {
            select: {
              cardLast4: true,
              cardType: true,
              cardBrand: true,
              bankName: true,
              lastSuccessfulProvider: true,
            },
          },
        },
      }),
      mainPrisma.transactions.count({ where }),
    ]);

    return {
      total,
      page,
      limit,
      transactions: transactions.map(mapAppointmentFinanceTransaction),
    };
  }

  async getFinanceSubscriptionsHistory(query = {}) {
    const { page, limit, skip, range } = parseFinanceHistoryQuery(query);
    const where = {
      status: "completed",
      serviceType: "subscription",
      ...getCompletedTransactionDateWhere(range),
    };

    const [transactions, total] = await Promise.all([
      mainPrisma.transactions.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          patientId: true,
          doctorId: true,
          paymentMethodId: true,
          serviceType: true,
          serviceId: true,
          planType: true,
          billingCycle: true,
          originalAmount: true,
          originalCurrency: true,
          usdAmount: true,
          paymentProvider: true,
          providerTransactionId: true,
          providerReference: true,
          description: true,
          status: true,
          createdAt: true,
          completedAt: true,
          users_transactions_patientIdTousers: {
            select: {
              id: true,
              fullName: true,
              profileImageUrl: true,
            },
          },
          users_transactions_doctorIdTousers: {
            select: {
              id: true,
              fullName: true,
              profileImageUrl: true,
            },
          },
          user_payment_methods: {
            select: {
              cardLast4: true,
              cardType: true,
              cardBrand: true,
              bankName: true,
              lastSuccessfulProvider: true,
            },
          },
        },
      }),
      mainPrisma.transactions.count({ where }),
    ]);

    const subscriptionIds = [
      ...new Set(
        transactions.map((transaction) => transaction.serviceId).filter(Boolean),
      ),
    ];
    const subscriptions = subscriptionIds.length
      ? await mainPrisma.subscriptions.findMany({
          where: {
            id: {
              in: subscriptionIds,
            },
          },
          select: {
            id: true,
            users: {
              select: {
                id: true,
                fullName: true,
                profileImageUrl: true,
              },
            },
          },
        })
      : [];
    const subscriptionsById = Object.fromEntries(
      subscriptions.map((subscription) => [subscription.id, subscription]),
    );

    return {
      total,
      page,
      limit,
      transactions: transactions.map((transaction) =>
        mapSubscriptionFinanceTransaction(transaction, subscriptionsById),
      ),
    };
  }

  async getFinanceSalesHistory(query = {}) {
    const page = parsePositiveInteger(query.page, "page", {
      defaultValue: 1,
    });
    const limit = parsePositiveInteger(query.limit, "limit", {
      defaultValue: 20,
      max: 100,
    });
    const skip = (page - 1) * limit;

    const where = {
      serviceType: "pharmacy",
    };

    const [transactions, total] = await Promise.all([
      mainPrisma.transactions.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          serviceId: true,
          providerReference: true,
          providerTransactionId: true,
          originalAmount: true,
          originalCurrency: true,
          usdAmount: true,
          status: true,
          createdAt: true,
          completedAt: true,
          users_transactions_patientIdTousers: {
            select: {
              id: true,
              fullName: true,
              email: true,
              profileImageUrl: true,
            },
          },
        },
      }),
      mainPrisma.transactions.count({ where }),
    ]);

    return {
      total,
      page,
      limit,
      sales: transactions.map(mapSaleTransaction),
    };
  }

  async getAnalyticsRevenueTracking(query = {}) {
    const { year, range } = getFinanceYearRange(query.year);

    const format = String(query.format || "json").toLowerCase();
    if (!FINANCE_REVENUE_FORMATS.includes(format)) {
      throw new ApiError(400, "Invalid format. Use json or csv.");
    }

    const transactions = await mainPrisma.transactions.findMany({
      where: {
        status: "completed",
        serviceType: { in: ["appointment", "pharmacy"] },
        ...getCompletedTransactionDateWhere(range),
      },
      select: {
        serviceType: true,
        usdAmount: true,
        originalAmount: true,
        completedAt: true,
        createdAt: true,
      },
      orderBy: [{ completedAt: "asc" }, { createdAt: "asc" }],
    });

    const data = {
      year,
      months: buildMonthlyRevenueRows(transactions, "sales"),
    };

    if (format === "csv") {
      return {
        format,
        filename: `healthnet-analytics-revenue-tracking-${year}.csv`,
        csv: buildFinanceRevenueCsv({ ...data, type: "sales" }),
        data,
      };
    }

    return { format, data };
  }

  async getAnalyticsDeliveryOverview(query = {}) {
    const { year, range } = getFinanceYearRange(query.year);

    const prescriptions = await mainPrisma.prescriptions.findMany({
      where: {
        actualDeliveryDate: range,
      },
      select: {
        actualDeliveryDate: true,
      },
    });

    const monthCounts = new Array(12).fill(0);
    for (const prescription of prescriptions) {
      monthCounts[prescription.actualDeliveryDate.getUTCMonth()] += 1;
    }

    const months = MONTH_LABELS.map((monthItem, i) => ({
      month: monthItem.short,
      value: monthCounts[i],
    }));

    return { year, months };
  }

  async getAnalyticsSalesAnalytics(query = {}) {
    const { year, range } = getFinanceYearRange(query.year);

    const transactions = await mainPrisma.transactions.findMany({
      where: {
        status: "completed",
        serviceType: "pharmacy",
        ...getCompletedTransactionDateWhere(range),
      },
      select: {
        serviceType: true,
        usdAmount: true,
        originalAmount: true,
        completedAt: true,
        createdAt: true,
      },
      orderBy: [{ completedAt: "asc" }, { createdAt: "asc" }],
    });

    const rows = buildMonthlyRevenueRows(transactions, "sales");

    return {
      year,
      months: rows.map(({ month, sales }) => ({ month, value: sales })),
    };
  }

  async getAnalyticsBillingMemberships(query = {}) {
    const selectedMonth = getSelectedMonth(query.month);
    const year = new Date().getUTCFullYear();
    const range = {
      gte: new Date(Date.UTC(year, 0, 1)),
      lt: new Date(Date.UTC(year + 1, 0, 1)),
    };

    const transactions = await mainPrisma.transactions.findMany({
      where: {
        status: "completed",
        serviceType: "subscription",
        ...getCompletedTransactionDateWhere(range),
      },
      select: {
        serviceType: true,
        usdAmount: true,
        originalAmount: true,
        completedAt: true,
        createdAt: true,
      },
      orderBy: [{ completedAt: "asc" }, { createdAt: "asc" }],
    });

    const rows = buildMonthlyRevenueRows(transactions, "subscriptions");

    return {
      month: selectedMonth,
      data: rows.map(({ month, subscriptions }) => ({ month, value: subscriptions })),
    };
  }

  async getAnalyticsPatientsStatistics(query = {}) {
    const selectedMonth = getSelectedMonth(query.month);
    const year = new Date().getUTCFullYear();

    const data = await Promise.all(
      MONTH_LABELS.map(async (monthItem, monthIndex) => {
        const monthStart = new Date(Date.UTC(year, monthIndex, 1));
        const nextMonthStart = new Date(Date.UTC(year, monthIndex + 1, 1));

        const value = await mainPrisma.users.count({
          where: {
            role: "patient",
            createdAt: { gte: monthStart, lt: nextMonthStart },
          },
        });

        return { month: monthItem.short, value };
      }),
    );

    return { month: selectedMonth, data };
  }

  async getAnalyticsDoctorsPercentage(query = {}) {
    const { monthName, monthStart, nextMonthStart } = getMonthRange(query.month);
    const monthFilter = { gte: monthStart, lt: nextMonthStart };

    const [
      totalDoctors,
      newDoctorsCount,
      doctorsWithAppointments,
      doctorsWithProductPurchases,
    ] = await Promise.all([
      mainPrisma.users.count({ where: { role: "doctor" } }),
      mainPrisma.users.count({ where: { role: "doctor", createdAt: monthFilter } }),
      mainPrisma.appointments.groupBy({
        by: ["doctorId"],
        where: { appointmentDate: monthFilter },
      }),
      mainPrisma.transactions.groupBy({
        by: ["doctorId"],
        where: {
          serviceType: "pharmacy",
          status: "completed",
          createdAt: monthFilter,
          doctorId: { not: null },
        },
      }),
    ]);

    const toPercent = (count) => {
      if (totalDoctors === 0) return 0;
      return Math.min(100, Math.round((count / totalDoctors) * 100));
    };

    return {
      month: monthName,
      totalDoctors,
      newDoctors: toPercent(newDoctorsCount),
      appointments: toPercent(doctorsWithAppointments.length),
      productPurchase: toPercent(doctorsWithProductPurchases.length),
    };
  }

  async getAnalyticsAppointmentsOverview(query = {}) {
    const { year, range } = getFinanceYearRange(query.year);
    const format = String(query.format || "json").toLowerCase();

    if (!FINANCE_REVENUE_FORMATS.includes(format)) {
      throw new ApiError(400, "Invalid format. Use json or csv.");
    }

    const appointments = await mainPrisma.appointments.findMany({
      where: {
        appointmentDate: range,
      },
      select: {
        appointmentDate: true,
      },
    });

    const monthCounts = new Array(12).fill(0);
    for (const apt of appointments) {
      monthCounts[apt.appointmentDate.getUTCMonth()] += 1;
    }

    const months = MONTH_LABELS.map((monthItem, i) => ({
      month: monthItem.short,
      appointments: monthCounts[i],
    }));

    const data = { year, months };

    if (format === "csv") {
      return {
        format,
        filename: `healthnet-analytics-appointments-overview-${year}.csv`,
        csv: buildAppointmentsOverviewCsv(data),
        data,
      };
    }

    return { format, data };
  }

  async getAnalyticsStats() {
    const [
      appointments,
      doctors,
      patients,
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
      appointments,
      doctors,
      patients,
      balance: Number(balanceAggregate._sum.usdAmount || 0),
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
