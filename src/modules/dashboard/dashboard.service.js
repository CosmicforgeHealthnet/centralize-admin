const { mainPrisma } = require("../../shared/config/mainDatabase");

class DashboardService {
  async getOverview() {
    const now = new Date();

    const startOfThisWeek = new Date(now);
    startOfThisWeek.setDate(now.getDate() - 7);

    const startOfLastWeek = new Date(startOfThisWeek);
    startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    // ── Graceful fallback for missing lastLoginAt column ──────────────────
    let activeUsersThisWeek = 0;
    let activeUsersLastWeek = 0;
    try {
      [activeUsersThisWeek, activeUsersLastWeek] = await Promise.all([
        mainPrisma.users.count({
          where: { lastLoginAt: { gte: startOfThisWeek } },
        }),
        mainPrisma.users.count({
          where: { lastLoginAt: { gte: startOfLastWeek, lt: startOfThisWeek } },
        }),
      ]);
    } catch (err) {
      console.warn(
        "lastLoginAt column not available, defaulting to 0:",
        err.message,
      );
    }

    const [
      // ── Total users ───────────────────────────────────
      totalUsers,
      newUsersThisWeek,
      newUsersLastWeek,

      // ── Doctors ───────────────────────────────────────
      activeDoctors,
      newDoctorsThisWeek,
      newDoctorsLastWeek,

      // ── Patients ─────────────────────────────────────
      activePatients,
      newPatientsThisWeek,
      newPatientsLastWeek,

      // ── Revenue ───────────────────────────────────────
      totalRevenue,
      lastMonthRevenue,

      // ── Memberships ───────────────────────────────────
      doctorMemberships,
      patientMemberships,

      // ── User activity ─────────────────────────────────
      newDoctorsThisMonth,
      newPatientsThisMonth,
      appointmentsThisMonth,
      newDoctorsLastMonth,
      newPatientsLastMonth,
      appointmentsLastMonth,
    ] = await Promise.all([
      // Total users (all time)
      mainPrisma.users.count(),

      // New users this week
      mainPrisma.users.count({
        where: { createdAt: { gte: startOfThisWeek } },
      }),
      // New users last week
      mainPrisma.users.count({
        where: { createdAt: { gte: startOfLastWeek, lt: startOfThisWeek } },
      }),

      // All currently active doctors (display value)
      mainPrisma.users.count({
        where: { role: "doctor", status: "doctor_active" },
      }),
      // New doctors who joined this week (for change %)
      mainPrisma.users.count({
        where: { role: "doctor", createdAt: { gte: startOfThisWeek } },
      }),
      // New doctors who joined last week (for change %)
      mainPrisma.users.count({
        where: {
          role: "doctor",
          createdAt: { gte: startOfLastWeek, lt: startOfThisWeek },
        },
      }),

      // All currently active patients (display value)
      mainPrisma.users.count({
        where: { role: "patient", status: "active" },
      }),
      // New patients who joined this week (for change %)
      mainPrisma.users.count({
        where: { role: "patient", createdAt: { gte: startOfThisWeek } },
      }),
      // New patients who joined last week (for change %)
      mainPrisma.users.count({
        where: {
          role: "patient",
          createdAt: { gte: startOfLastWeek, lt: startOfThisWeek },
        },
      }),

      // Revenue this month
      mainPrisma.transactions.aggregate({
        _sum: { originalAmount: true },
        where: {
          status: "completed",
          createdAt: { gte: startOfMonth },
          originalCurrency: "NGN",
        },
      }),
      // Revenue last month
      mainPrisma.transactions.aggregate({
        _sum: { originalAmount: true },
        where: {
          status: "completed",
          createdAt: { gte: startOfLastMonth, lt: startOfMonth },
          originalCurrency: "NGN",
        },
      }),

      // Memberships
      mainPrisma.subscriptions.count({
        where: { planType: "doctor", status: "active" },
      }),
      mainPrisma.subscriptions.count({
        where: { planType: "patient", status: "active" },
      }),

      // User activity — this month vs last month
      mainPrisma.users.count({
        where: { role: "doctor", createdAt: { gte: startOfMonth } },
      }),
      mainPrisma.users.count({
        where: { role: "patient", createdAt: { gte: startOfMonth } },
      }),
      mainPrisma.appointments.count({
        where: { createdAt: { gte: startOfMonth } },
      }),
      mainPrisma.users.count({
        where: {
          role: "doctor",
          createdAt: { gte: startOfLastMonth, lt: startOfMonth },
        },
      }),
      mainPrisma.users.count({
        where: {
          role: "patient",
          createdAt: { gte: startOfLastMonth, lt: startOfMonth },
        },
      }),
      mainPrisma.appointments.count({
        where: { createdAt: { gte: startOfLastMonth, lt: startOfMonth } },
      }),
    ]);

    const calcChange = (current, previous) => {
      if (!previous || previous === 0) return { change: "0.0", positive: true };
      const diff = ((current - previous) / previous) * 100;
      return { change: Math.abs(diff).toFixed(1), positive: diff >= 0 };
    };

    const currentRevenue = Number(totalRevenue._sum.originalAmount || 0);
    const previousRevenue = Number(lastMonthRevenue._sum.originalAmount || 0);
    const totalMemberships = doctorMemberships + patientMemberships;

    return {
      statCards: {
        totalUsers: {
          value: totalUsers,
          ...calcChange(totalUsers, totalUsers - newUsersThisWeek),
          period: "from last week",
        },
        activeUsersThisWeek: {
          value: activeUsersThisWeek,
          ...calcChange(activeUsersThisWeek, activeUsersLastWeek),
          period: "from last week",
        },
        totalRevenue: {
          value: currentRevenue.toFixed(2),
          ...calcChange(currentRevenue, previousRevenue),
          period: "from last month",
        },
        activeDoctors: {
          value: activeDoctors,
          ...calcChange(activeDoctors, activeDoctors - newDoctorsThisWeek),
          period: "from last week",
        },
        activePatients: {
          value: activePatients,
          ...calcChange(activePatients, activePatients - newPatientsThisWeek),
          period: "from last week",
        },
      },
      membershipActivity: {
        total: totalMemberships,
        doctorPercentage:
          totalMemberships > 0
            ? ((doctorMemberships / totalMemberships) * 100).toFixed(1)
            : "0",
        patientPercentage:
          totalMemberships > 0
            ? ((patientMemberships / totalMemberships) * 100).toFixed(1)
            : "0",
        doctorCount: doctorMemberships,
        patientCount: patientMemberships,
      },
      userActivity: {
        newDoctors: {
          value: newDoctorsThisMonth,
          ...calcChange(newDoctorsThisMonth, newDoctorsLastMonth),
          period: "from last month",
        },
        newPatients: {
          value: newPatientsThisMonth,
          ...calcChange(newPatientsThisMonth, newPatientsLastMonth),
          period: "from last month",
        },
        appointments: {
          value: appointmentsThisMonth,
          ...calcChange(appointmentsThisMonth, appointmentsLastMonth),
          period: "from last month",
        },
      },
    };
  }

  // Single grouped query instead of 12 separate queries per service type
  async getRevenueChart() {
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const transactions = await mainPrisma.transactions.findMany({
      where: {
        status: "completed",
        createdAt: { gte: twelveMonthsAgo },
        serviceType: { in: ["appointment", "subscription"] },
        originalCurrency: "NGN",
      },
      select: { serviceType: true, originalAmount: true, createdAt: true },
    });

    const monthMap = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      monthMap[key] = {
        month: d.toLocaleString("default", { month: "short" }),
        Appointments: 0,
        Membership: 0,
      };
    }

    for (const tx of transactions) {
      const d = new Date(tx.createdAt);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!monthMap[key]) continue;
      if (tx.serviceType === "appointment") {
        monthMap[key].Appointments += Number(tx.originalAmount || 0);
      } else if (tx.serviceType === "subscription") {
        monthMap[key].Membership += Number(tx.originalAmount || 0);
      }
    }

    return Object.values(monthMap).map((m) => ({
      ...m,
      Appointments: m.Appointments.toFixed(2),
      Membership: m.Membership.toFixed(2),
    }));
  }

  async getPlatformUsageChart() {
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    // Stable tables — run together
    const [appointments, prescriptions, aiSessions] = await Promise.all([
      mainPrisma.appointments.findMany({
        where: { createdAt: { gte: twelveMonthsAgo } },
        select: { createdAt: true },
      }),
      mainPrisma.prescriptions.findMany({
        where: { createdAt: { gte: twelveMonthsAgo } },
        select: { createdAt: true },
      }),
      mainPrisma.chatbot_sessions.findMany({
        where: { createdAt: { gte: twelveMonthsAgo } },
        select: { createdAt: true },
      }),
    ]);

    // lab_orders — graceful fallback if table not migrated yet
    let labOrders = [];
    try {
      labOrders = await mainPrisma.lab_orders.findMany({
        where: { createdAt: { gte: twelveMonthsAgo } },
        select: { createdAt: true },
      });
    } catch (err) {
      console.warn("lab_orders table not available:", err.message);
    }

    const monthMap = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      monthMap[key] = {
        month: d.toLocaleString("default", { month: "short" }),
        Consultation: 0,
        Lab: 0,
        Pharmacy: 0,
        AI: 0,
      };
    }

    const bucket = (records, field) => {
      for (const r of records) {
        const d = new Date(r.createdAt);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        if (monthMap[key]) monthMap[key][field]++;
      }
    };

    bucket(appointments, "Consultation");
    bucket(labOrders, "Lab"); // empty array if table missing — no crash
    bucket(prescriptions, "Pharmacy");
    bucket(aiSessions, "AI");

    return Object.values(monthMap);
  }
}

module.exports = new DashboardService();
