const { mainPrisma } = require("../../shared/config/mainDatabase");
const eventBus = require("../../shared/events/eventBus");
const EVENTS = require("../../shared/events/events");
const {
  PAYMENT_STATES,
  validatePaymentTransition,
} = require("../../shared/states/payment.states");
const ApiError = require("../../shared/utils/ApiError");
const logger = require("../../shared/utils/logger");
const crypto = require("crypto");

function deterministicPaymentEventId(type, transactionId) {
  const digest = crypto
    .createHash("sha256")
    .update([type, transactionId].filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 32);
  return `${type.toLowerCase()}:${digest}`;
}

class PaymentsService {
  constructor() {
    this._registerListeners();
  }

  _registerListeners() {
    eventBus.subscribe(EVENTS.PAYMENT_SUCCESS, async ({ transactionId }) => {
      logger.info("[Payments] Payment success received", {
        hasTransactionId: Boolean(transactionId),
      });
    });

    eventBus.subscribe(EVENTS.PAYMENT_FAILED, async ({ transactionId }) => {
      logger.warn("[Payments] Payment failed", {
        hasTransactionId: Boolean(transactionId),
      });
    });
  }

  async getTransaction(id) {
    const transaction = await mainPrisma.transactions.findUnique({
      where: { id },
      select: {
        id: true,
        patientId: true,
        doctorId: true,
        serviceType: true,
        serviceId: true,
        status: true,
        originalAmount: true,
        originalCurrency: true,
        usdAmount: true,
        paymentProvider: true,
        fundsStatus: true,
        refundStatus: true,
        createdAt: true,
        completedAt: true,
        failedAt: true,
      },
    });

    if (!transaction) throw new ApiError(404, "Transaction not found");
    return transaction;
  }

  async listTransactions({
    status,
    serviceType,
    patientId,
    page = 1,
    limit = 20,
  }) {
    const where = {};
    if (status) where.status = status;
    if (serviceType) where.serviceType = serviceType;
    if (patientId) where.patientId = patientId;

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      mainPrisma.transactions.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          patientId: true,
          serviceType: true,
          status: true,
          originalAmount: true,
          originalCurrency: true,
          fundsStatus: true,
          createdAt: true,
        },
      }),
      mainPrisma.transactions.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async transitionPayment(id, toStatus, adminUser) {
    const transaction = await mainPrisma.transactions.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        serviceType: true,
        serviceId: true,
        patientId: true,
        originalAmount: true,
        originalCurrency: true,
        usdAmount: true,
      },
    });

    if (!transaction) throw new ApiError(404, "Transaction not found");

    validatePaymentTransition(transaction.status, toStatus);

    const updated = await mainPrisma.transactions.update({
      where: { id },
      data: {
        status: toStatus,
        ...(toStatus === PAYMENT_STATES.SUCCESS && { completedAt: new Date() }),
        ...(toStatus === PAYMENT_STATES.FAILED && { failedAt: new Date() }),
      },
    });

    logger.info("[Payments] Transaction status changed", {
      hasTransactionId: Boolean(id),
      status: toStatus,
    });

    if (toStatus === PAYMENT_STATES.SUCCESS) {
      eventBus.publish(EVENTS.PAYMENT_SUCCESS, {
        eventId: deterministicPaymentEventId("payment", id),
        transactionId: id,
        userId: transaction.patientId,
        serviceType: transaction.serviceType,
        serviceId: transaction.serviceId,
        amount:
          updated.usdAmount !== null && updated.usdAmount !== undefined
            ? String(updated.usdAmount)
            : String(updated.originalAmount),
        currency:
          updated.usdAmount !== null && updated.usdAmount !== undefined
            ? "USD"
            : transaction.originalCurrency,
        occurredAt: updated.completedAt || new Date(),
      });
    }

    if (toStatus === PAYMENT_STATES.REFUNDED) {
      eventBus.publish(EVENTS.PAYMENT_REFUNDED, {
        eventId: deterministicPaymentEventId("refund", id),
        transactionId: id,
        originalPaymentExternalEventId: deterministicPaymentEventId("payment", id),
        userId: transaction.patientId,
        serviceType: transaction.serviceType,
        serviceId: transaction.serviceId,
        amount:
          updated.usdAmount !== null && updated.usdAmount !== undefined
            ? String(updated.usdAmount)
            : String(updated.originalAmount),
        currency:
          updated.usdAmount !== null && updated.usdAmount !== undefined
            ? "USD"
            : transaction.originalCurrency,
        monetaryStatus: "FINALIZED",
        occurredAt: new Date(),
      });
    }

    if (toStatus === PAYMENT_STATES.FAILED) {
      eventBus.publish(EVENTS.PAYMENT_FAILED, {
        transactionId: id,
        userId: transaction.patientId,
      });
    }

    return updated;
  }

  async getPaymentStats() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [total, pending, completed, failed, refunded, monthlyRevenue] =
      await Promise.all([
        mainPrisma.transactions.count(),
        mainPrisma.transactions.count({ where: { status: "pending" } }),
        mainPrisma.transactions.count({ where: { status: "completed" } }),
        mainPrisma.transactions.count({ where: { status: "failed" } }),
        mainPrisma.transactions.count({ where: { status: "refunded" } }),
        mainPrisma.transactions.aggregate({
          _sum: { usdAmount: true },
          where: { status: "completed", createdAt: { gte: startOfMonth } },
        }),
      ]);

    return {
      total,
      pending,
      completed,
      failed,
      refunded,
      monthlyRevenueUsd: Number(monthlyRevenue._sum.usdAmount || 0).toFixed(2),
    };
  }

  async flagTransaction(id, reason, adminUser) {
    const transaction = await mainPrisma.transactions.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (!transaction) throw new ApiError(404, "Transaction not found");

    const updated = await mainPrisma.transactions.update({
      where: { id },
      data: {
        status: "disputed",
        metadata: { flaggedBy: adminUser.id, reason },
      },
    });

    logger.warn(
      `[Payments] Transaction ${id} flagged by ${adminUser.id}: ${reason}`,
    );
    return updated;
  }
}

module.exports = new PaymentsService();
