const { mainPrisma } = require("../../shared/config/mainDatabase");

class DashboardService {
  async getOverview() {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - 7);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastWeek = new Date(startOfWeek);
    startOfLastWeek.setDate(startOfWeek.getDate() - 7);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [
      totalUsers,
      activeUsersThisWeek,
      activeDoctors,
      activePatients,
      totalUsersLastWeek,
      activeUsersLastWeek,
      activeDoctorsLastWeek,
      activePatientsLastWeek,
      totalRevenue,
      lastMonthRevenue,
      doctorMemberships,
      patientMemberships,
      newDoctorsThisMonth,
      newPatientsThisMonth,
      appointmentsThisMonth,
      newDoctorsLastMonth,
      newPatientsLastMonth,
      appointmentsLastMonth,
    ] = await Promise.all([
      mainPrisma.users.count(),
      mainPrisma.users.count({
        where: { lastLoginAt: { gte: startOfWeek } },
      }),

      mainPrisma.users.count({
        where: { role: "doctor", status: "doctor_active" },
      }),
      mainPrisma.users.count({ where: { role: "patient", status: "active" } }),
      mainPrisma.users.count({ where: { createdAt: { lt: startOfWeek } } }),
      mainPrisma.users.count({
        where: { lastLoginAt: { gte: startOfLastWeek, lt: startOfWeek } },
      }),
      mainPrisma.users.count({
        where: {
          role: "doctor",
          status: "doctor_active",
          updatedAt: { gte: startOfLastWeek, lt: startOfWeek },
        },
      }),
      mainPrisma.users.count({
        where: {
          role: "patient",
          status: "active",
          updatedAt: { gte: startOfLastWeek, lt: startOfWeek },
        },
      }),
      mainPrisma.transactions.aggregate({
        _sum: { usdAmount: true },
        where: { status: "completed", createdAt: { gte: startOfMonth } },
      }),
      mainPrisma.transactions.aggregate({
        _sum: { usdAmount: true },
        where: {
          status: "completed",
          createdAt: { gte: startOfLastMonth, lt: startOfMonth },
        },
      }),
      mainPrisma.subscriptions.count({
        where: { planType: "doctor", status: "active" },
      }),
      mainPrisma.subscriptions.count({
        where: { planType: "patient", status: "active" },
      }),
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

    const currentRevenue = Number(totalRevenue._sum.usdAmount || 0);
    const previousRevenue = Number(lastMonthRevenue._sum.usdAmount || 0);
    const totalMemberships = doctorMemberships + patientMemberships;

    return {
      statCards: {
        totalUsers: {
          value: totalUsers,
          ...calcChange(totalUsers, totalUsersLastWeek),
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
          ...calcChange(activeDoctors, activeDoctorsLastWeek),
          period: "from last week",
        },
        activePatients: {
          value: activePatients,
          ...calcChange(activePatients, activePatientsLastWeek),
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
      },
      select: { serviceType: true, usdAmount: true, createdAt: true },
    });

    // Build month map
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

    // Aggregate in memory — much faster than 24 DB round trips
    for (const tx of transactions) {
      const d = new Date(tx.createdAt);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!monthMap[key]) continue;
      if (tx.serviceType === "appointment") {
        monthMap[key].Appointments += Number(tx.usdAmount || 0);
      } else if (tx.serviceType === "subscription") {
        monthMap[key].Membership += Number(tx.usdAmount || 0);
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

    // 4 queries instead of 48
    const [appointments, labOrders, prescriptions, aiSessions] =
      await Promise.all([
        mainPrisma.appointments.findMany({
          where: { createdAt: { gte: twelveMonthsAgo } },
          select: { createdAt: true },
        }),
        mainPrisma.lab_orders.findMany({
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

    // Build month map
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

    // Aggregate in memory
    const bucket = (records, field) => {
      for (const r of records) {
        const d = new Date(r.createdAt);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        if (monthMap[key]) monthMap[key][field]++;
      }
    };

    bucket(appointments, "Consultation");
    bucket(labOrders, "Lab");
    bucket(prescriptions, "Pharmacy");
    bucket(aiSessions, "AI");

    return Object.values(monthMap);
  }
}

module.exports = new DashboardService();
