const { mainPrisma } = require("../../shared/config/mainDatabase");
const logger = require("../../shared/utils/logger");
const eventBus = require("../../shared/events/eventBus");
const EVENTS = require("../../shared/events/events");
const crypto = require("crypto");

// Valid prod status values
const VALID_STATUSES = [
  "active",
  "doctor_active",
  "pharmacy_active",
  "locked",
  "pending_email_verification",
  "pending_doctor_verification",
  "pending_pharmacy_verification",
];

const ACTIVE_STATUSES = ["active", "doctor_active", "pharmacy_active"];

function deterministicUserEventId(type, userId, scope) {
  const digest = crypto
    .createHash("sha256")
    .update([type, userId, scope].filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 32);
  return `${type.toLowerCase()}:${digest}`;
}

// Helpers

const calcGrowthRate = (current, previous) => {
  if (current === 0 && previous === 0) return 0;
  if (previous === 0) return 100;
  return Number(((current - previous) / previous) * 100).toFixed(1);
};

// Safely run a query that may reference lastLoginAt
const withLastLoginAt = async (queryFn, fallbackFn) => {
  try {
    return await queryFn();
  } catch (err) {
    if (err.message.includes("lastLoginAt")) {
      logger.warn("lastLoginAt column not available, using fallback");
      return await fallbackFn();
    }
    throw err;
  }
};

// Service

class UsersService {
  // Stats

  async getStats() {
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - 7);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [
      total,
      totalDoctors,
      totalPatients,
      totalPharmacies,
      totalLabs,
      activeUsers,
      lockedUsers,
      pendingVerification,
      newToday,
      newThisWeek,
      newThisMonth,
      newLastMonth,
    ] = await Promise.all([
      mainPrisma.users.count(),
      mainPrisma.users.count({ where: { role: "doctor" } }),
      mainPrisma.users.count({ where: { role: "patient" } }),
      mainPrisma.users.count({ where: { role: "pharmacy" } }),
      mainPrisma.users.count({ where: { role: "lab_admin" } }),
      mainPrisma.users.count({ where: { status: { in: ACTIVE_STATUSES } } }),
      mainPrisma.users.count({ where: { status: "locked" } }),
      mainPrisma.users.count({
        where: {
          status: {
            in: [
              "pending_email_verification",
              "pending_doctor_verification",
              "pending_pharmacy_verification",
            ],
          },
        },
      }),
      mainPrisma.users.count({ where: { createdAt: { gte: startOfToday } } }),
      mainPrisma.users.count({ where: { createdAt: { gte: startOfWeek } } }),
      mainPrisma.users.count({ where: { createdAt: { gte: startOfMonth } } }),
      mainPrisma.users.count({
        where: { createdAt: { gte: startOfLastMonth, lt: startOfMonth } },
      }),
    ]);

    return {
      total,
      totalDoctors,
      totalPatients,
      totalPharmacies,
      totalLabs,
      activeUsers,
      inactiveUsers: total - activeUsers,
      lockedUsers,
      pendingVerification,
      newToday,
      newThisWeek,
      newThisMonth,
      growthRate: Number(calcGrowthRate(newThisMonth, newLastMonth)),
    };
  }

  // Charts

  async getGrowthChart() {
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const users = await mainPrisma.users.findMany({
      where: { createdAt: { gte: twelveMonthsAgo } },
      select: { createdAt: true, role: true },
    });

    const monthMap = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      monthMap[key] = {
        month: d.toLocaleString("default", { month: "short" }),
        total: 0,
        doctors: 0,
        patients: 0,
        others: 0,
      };
    }

    for (const user of users) {
      const d = new Date(user.createdAt);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!monthMap[key]) continue;
      monthMap[key].total++;
      if (user.role === "doctor") monthMap[key].doctors++;
      else if (user.role === "patient") monthMap[key].patients++;
      else monthMap[key].others++;
    }

    return Object.values(monthMap);
  }

  async getSignUpTrends() {
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const users = await mainPrisma.users.findMany({
      where: { createdAt: { gte: twelveMonthsAgo } },
      select: { createdAt: true, role: true },
    });

    const monthMap = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      monthMap[key] = {
        month: d.toLocaleString("default", { month: "short" }),
        Doctors: 0,
        Patients: 0,
        Pharmacies: 0,
        Labs: 0,
      };
    }

    for (const user of users) {
      const d = new Date(user.createdAt);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!monthMap[key]) continue;
      if (user.role === "doctor") monthMap[key].Doctors++;
      else if (user.role === "patient") monthMap[key].Patients++;
      else if (user.role === "pharmacy") monthMap[key].Pharmacies++;
      else if (user.role === "lab_admin") monthMap[key].Labs++;
    }

    return Object.values(monthMap);
  }

  // List users

  async listUsers({
    role,
    status,
    search,
    tier,
    dateFrom,
    dateTo,
    sortBy = "createdAt",
    sortOrder = "desc",
    page = 1,
    limit = 20,
  }) {
    const where = {};

    if (role) where.role = role;
    if (status) where.status = status;
    if (tier) where.tier = tier;

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phoneNumber: { contains: search, mode: "insensitive" } },
      ];
    }

    const validSortFields = [
      "createdAt",
      "fullName",
      "email",
      "role",
      "status",
    ];
    const orderBy = validSortFields.includes(sortBy)
      ? { [sortBy]: sortOrder === "asc" ? "asc" : "desc" }
      : { createdAt: "desc" };

    const skip = (page - 1) * limit;

    const baseSelect = {
      id: true,
      fullName: true,
      email: true,
      role: true,
      status: true,
      tier: true,
      phoneNumber: true,
      createdAt: true,
    };

    const [data, total] = await withLastLoginAt(
      async () =>
        Promise.all([
          mainPrisma.users.findMany({
            where,
            skip,
            take: limit,
            orderBy,
            select: { ...baseSelect, lastLoginAt: true },
          }),
          mainPrisma.users.count({ where }),
        ]),
      async () => {
        const [rows, count] = await Promise.all([
          mainPrisma.users.findMany({
            where,
            skip,
            take: limit,
            orderBy,
            select: baseSelect,
          }),
          mainPrisma.users.count({ where }),
        ]);
        return [rows.map((u) => ({ ...u, lastLoginAt: null })), count];
      },
    );

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // Single user

  async getUser(id) {
    const baseSelect = {
      id: true,
      fullName: true,
      email: true,
      role: true,
      status: true,
      tier: true,
      phoneNumber: true,
      profileImageUrl: true,
      createdAt: true,
      updatedAt: true,
      subscriptions: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          tier: true,
          planType: true,
          status: true,
          startDate: true,
          endDate: true,
          price: true,
          currency: true,
          billingCycle: true,
          createdAt: true,
        },
      },
      doctor_profiles: {
        select: {
          gender: true,
          dateOfBirth: true,
          nationality: true,
          contactNumber: true,
          professional_licenses: {
            select: {
              medicalLicenseNumber: true,
              countryOfLicense: true,
              licenseAuthority: true,
              licenseExpiryDate: true,
              yearsOfExperience: true,
              areasOfSpecialization: true,
            },
          },
        },
      },
      patient_profiles: {
        select: {
          gender: true,
          dateOfBirth: true,
          bloodGroup: true,
          genotype: true,
          nationality: true,
        },
      },
      pharmacy_profiles: {
        select: {
          pharmacyName: true,
          registrationNumber: true,
          address: true,
          phone: true,
          verificationStatus: true,
          isActive: true,
        },
      },
    };

    const user = await withLastLoginAt(
      () =>
        mainPrisma.users.findUnique({
          where: { id },
          select: { ...baseSelect, lastLoginAt: true },
        }),
      async () => {
        const row = await mainPrisma.users.findUnique({
          where: { id },
          select: baseSelect,
        });
        return row ? { ...row, lastLoginAt: null } : null;
      },
    );

    if (!user) throw new Error("User not found");
    return user;
  }

  // Get user activity

  async getUserActivity(id) {
    const user = await mainPrisma.users.findUnique({
      where: { id },
      select: { id: true, role: true },
    });
    if (!user) throw new Error("User not found");

    const [appointments, transactions, prescriptions] = await Promise.all([
      mainPrisma.appointments.count({
        where: {
          OR: [{ patientId: id }, { doctorId: id }],
        },
      }),
      mainPrisma.transactions.count({
        where: {
          OR: [{ patientId: id }, { doctorId: id }],
        },
      }),
      mainPrisma.prescriptions.count({
        where: {
          OR: [{ patientId: id }, { doctorId: id }],
        },
      }),
    ]);

    // lab_orders - graceful fallback if table not migrated yet
    let labOrders = 0;
    try {
      labOrders = await mainPrisma.lab_orders.count({
        where: { patientId: id },
      });
    } catch (err) {
      logger.warn("lab_orders table not available:", err.message);
    }

    return { appointments, transactions, prescriptions, labOrders };
  }

  // Get user transactions

  async getUserTransactions(id, { page = 1, limit = 20 } = {}) {
    const user = await mainPrisma.users.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!user) throw new Error("User not found");

    const where = {
      OR: [{ patientId: id }, { doctorId: id }],
    };

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      mainPrisma.transactions.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          serviceType: true,
          originalAmount: true,
          originalCurrency: true,
          status: true,
          paymentProvider: true,
          createdAt: true,
          completedAt: true,
        },
      }),
      mainPrisma.transactions.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // Get user appointments

  async getUserAppointments(id, { page = 1, limit = 20 } = {}) {
    const user = await mainPrisma.users.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!user) throw new Error("User not found");

    const where = {
      OR: [{ patientId: id }, { doctorId: id }],
    };

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      mainPrisma.appointments.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          appointmentDate: true,
          appointmentTime: true,
          status: true,
          type: true,
          reason: true,
          consultationFee: true,
          paymentStatus: true,
          createdAt: true,
        },
      }),
      mainPrisma.appointments.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // Get user subscriptions

  async getUserSubscriptions(id) {
    const user = await mainPrisma.users.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!user) throw new Error("User not found");

    return mainPrisma.subscriptions.findMany({
      where: { userId: id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        tier: true,
        planType: true,
        status: true,
        startDate: true,
        endDate: true,
        price: true,
        currency: true,
        billingCycle: true,
        autoRenew: true,
        canceledAt: true,
        createdAt: true,
      },
    });
  }

  // Update status

  async updateUserStatus(id, status, adminUser) {
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(
        `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
      );
    }

    const user = await mainPrisma.users.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!user) throw new Error("User not found");

    const updated = await mainPrisma.users.update({
      where: { id },
      data: { status },
    });

    logger.info("[Users] User status changed", {
      hasUserId: Boolean(id),
      status,
      hasAdminUser: Boolean(adminUser?.id),
    });
    if (
      !ACTIVE_STATUSES.includes(user.status) &&
      ACTIVE_STATUSES.includes(status)
    ) {
      eventBus.publish(EVENTS.USER_BECAME_ACTIVE, {
        eventId: deterministicUserEventId("active", id, `status:${status}`),
        userId: id,
        activationType: `status:${status}`,
        occurredAt: new Date(),
      });
    }

    return updated;
  }

  // Bulk update status

  async bulkUpdateStatus(ids, status, adminUser) {
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(
        `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
      );
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error("ids must be a non-empty array");
    }

    if (ids.length > 100) {
      throw new Error("Cannot bulk update more than 100 users at once");
    }

    const result = await mainPrisma.users.updateMany({
      where: { id: { in: ids } },
      data: { status },
    });

    logger.info(
      `[Users] Bulk status update -> ${status} for ${result.count} users by admin ${adminUser.id}`,
    );

    return { updated: result.count };
  }

  // Delete user

  async deleteUser(id, adminUser) {
    const user = await mainPrisma.users.findUnique({
      where: { id },
      select: { id: true, email: true, role: true },
    });
    if (!user) throw new Error("User not found");

    await mainPrisma.users.delete({ where: { id } });

    logger.info(
      `[Users] User ${id} (${user.email}) deleted by admin ${adminUser.id}`,
    );

    return { deleted: true };
  }

  // Force password reset

  async forcePasswordReset(id, adminUser) {
    const user = await mainPrisma.users.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!user) throw new Error("User not found");

    await mainPrisma.users.update({
      where: { id },
      data: { mustChangePassword: true },
    });

    logger.info(
      `[Users] Force password reset set for user ${id} by admin ${adminUser.id}`,
    );

    return { success: true };
  }
}

module.exports = new UsersService();
