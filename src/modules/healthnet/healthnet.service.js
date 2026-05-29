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

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
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

class HealthnetService {
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
