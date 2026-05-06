const { mainPrisma } = require("../../shared/config/mainDatabase");
const logger = require("../../shared/utils/logger");

class UsersService {
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
      mainPrisma.users.count({ where: { createdAt: { gte: startOfToday } } }),
      mainPrisma.users.count({ where: { createdAt: { gte: startOfWeek } } }),
      mainPrisma.users.count({ where: { createdAt: { gte: startOfMonth } } }),
      mainPrisma.users.count({
        where: { createdAt: { gte: startOfLastMonth, lt: startOfMonth } },
      }),
    ]);

    // Graceful fallback for status-based counts — enum values may differ per environment
    let activeUsers = 0;
    try {
      activeUsers = await mainPrisma.users.count({
        where: { status: "active" },
      });
    } catch (err) {
      logger.warn(
        "Could not count active users (enum mismatch?):",
        err.message,
      );
    }

    let inactiveUsers = 0;
    try {
      inactiveUsers = await mainPrisma.users.count({
        where: { status: "inactive" },
      });
    } catch (err) {
      logger.warn(
        "Could not count inactive users (enum mismatch?):",
        err.message,
      );
    }

const growthRate =
  newLastMonth === 0 && newThisMonth === 0
    ? 0 // no activity at all → 0%
    : newLastMonth === 0
      ? 100 // new activity where there was none → 100%
      : (((newThisMonth - newLastMonth) / newLastMonth) * 100).toFixed(1);

    return {
      total,
      totalDoctors,
      totalPatients,
      totalPharmacies,
      totalLabs,
      activeUsers,
      inactiveUsers,
      newToday,
      newThisWeek,
      newThisMonth,
      growthRate: Number(growthRate),
    };
  }

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

  async listUsers({ role, status, search, page = 1, limit = 20 }) {
    const where = {};
    if (role) where.role = role;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      mainPrisma.users.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          status: true,
          tier: true,
          phoneNumber: true,
          lastLoginAt: true,
          createdAt: true,
        },
      }),
      mainPrisma.users.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async getUser(id) {
    const user = await mainPrisma.users.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        status: true,
        tier: true,
        phoneNumber: true,
        profileImageUrl: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        subscriptions: {
          where: { status: "active" },
          select: {
            tier: true,
            planType: true,
            status: true,
            startDate: true,
            endDate: true,
          },
          take: 1,
        },
      },
    });

    if (!user) throw new Error("User not found");
    return user;
  }

  async updateUserStatus(id, status, adminUser) {
    const user = await mainPrisma.users.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!user) throw new Error("User not found");

    const updated = await mainPrisma.users.update({
      where: { id },
      data: { status },
    });

    logger.info(
      `[Users] User ${id} status → ${status} by admin ${adminUser.id}`,
    );
    return updated;
  }
}

module.exports = new UsersService();
