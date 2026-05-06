const { mainPrisma } = require("../../shared/config/mainDatabase");
const eventBus = require("../../shared/events/eventBus");
const EVENTS = require("../../shared/events/events");
const logger = require("../../shared/utils/logger");

class AuditServiceService {
  constructor() {
    this._registerListeners();
  }

  _registerListeners() {
    const eventMap = {
      [EVENTS.CONSULTATION_CREATED]: (p) =>
        this._log("appointments", p.consultationId, "CONSULTATION_CREATED", p),
      [EVENTS.CONSULTATION_STARTED]: (p) =>
        this._log("appointments", p.consultationId, "CONSULTATION_STARTED", p),
      [EVENTS.CONSULTATION_COMPLETED]: (p) =>
        this._log(
          "appointments",
          p.consultationId,
          "CONSULTATION_COMPLETED",
          p,
        ),
      [EVENTS.CONSULTATION_CANCELLED]: (p) =>
        this._log(
          "appointments",
          p.consultationId,
          "CONSULTATION_CANCELLED",
          p,
        ),
      [EVENTS.RTC_SESSION_CREATED]: (p) =>
        this._log("appointment_chats", p.sessionId, "RTC_SESSION_CREATED", p),
      [EVENTS.RTC_SESSION_STARTED]: (p) =>
        this._log("appointment_chats", p.sessionId, "RTC_SESSION_STARTED", p),
      [EVENTS.RTC_SESSION_ENDED]: (p) =>
        this._log("appointment_chats", p.sessionId, "RTC_SESSION_ENDED", p),
      [EVENTS.RTC_SESSION_FAILED]: (p) =>
        this._log("appointment_chats", p.sessionId, "RTC_SESSION_FAILED", p),
      [EVENTS.PRESCRIPTION_CREATED]: (p) =>
        this._log("prescriptions", p.prescriptionId, "PRESCRIPTION_CREATED", p),
      [EVENTS.PRESCRIPTION_READY_FOR_DELIVERY]: (p) =>
        this._log(
          "prescriptions",
          p.prescriptionId,
          "PRESCRIPTION_READY_FOR_DELIVERY",
          p,
        ),
      [EVENTS.DELIVERY_ASSIGNED]: (p) =>
        this._log("prescriptions", p.prescriptionId, "DELIVERY_ASSIGNED", p),
      [EVENTS.DELIVERY_COMPLETED]: (p) =>
        this._log("prescriptions", p.prescriptionId, "DELIVERY_COMPLETED", p),
      [EVENTS.DELIVERY_FAILED]: (p) =>
        this._log("prescriptions", p.prescriptionId, "DELIVERY_FAILED", p),
      [EVENTS.PAYMENT_INITIATED]: (p) =>
        this._log("transactions", p.transactionId, "PAYMENT_INITIATED", p),
      [EVENTS.PAYMENT_SUCCESS]: (p) =>
        this._log("transactions", p.transactionId, "PAYMENT_SUCCESS", p),
      [EVENTS.PAYMENT_FAILED]: (p) =>
        this._log("transactions", p.transactionId, "PAYMENT_FAILED", p),
    };

    Object.entries(eventMap).forEach(([event, handler]) => {
      eventBus.subscribe(event, handler);
    });
  }

  async _log(resourceType, resourceId, action, metadata = {}) {
    if (!resourceId) {
      logger.warn(`[AuditService] Missing resourceId for action: ${action}`);
      return;
    }

    try {
      await mainPrisma.audit_logs.create({
        data: {
          resourceType,
          resourceId,
          action,
          actorUserId: metadata.actorUserId || null,
          actorRole: metadata.actorRole || "system",
          metadata,
        },
      });

      logger.info(
        `[AuditService] Logged — action: ${action}, resource: ${resourceType}:${resourceId}`,
      );
    } catch (err) {
      logger.error(
        `[AuditService] Failed to write audit log — action: ${action}`,
        { error: err.message },
      );
    }
  }

  async logManualAction({
    resourceType,
    resourceId,
    action,
    adminUser,
    metadata = {},
  }) {
    await this._log(resourceType, resourceId, action, {
      ...metadata,
      actorUserId: adminUser.id,
      actorRole: adminUser.tier,
    });
  }

  async getAuditLogs({
    resourceType,
    resourceId,
    action,
    page = 1,
    limit = 20,
  } = {}) {
    try {
      const where = {};
      if (resourceType) where.resourceType = resourceType;
      if (resourceId) where.resourceId = resourceId;
      if (action) where.action = action;

      const skip = (page - 1) * limit;

      const [data, total] = await Promise.all([
        mainPrisma.audit_logs.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            resourceType: true,
            resourceId: true,
            action: true,
            actorUserId: true,
            actorRole: true,
            metadata: true,
            createdAt: true,
          },
        }),
        mainPrisma.audit_logs.count({ where }),
      ]);

      return { data, total, page, limit };
    } catch (err) {
      logger.warn("[AuditService] getAuditLogs unavailable:", err.message);
      return { data: [], total: 0, page, limit };
    }
  }

  async getAuditStats() {
    try {
      const now = new Date();
      const startOfDay = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );

      const [total, today] = await Promise.all([
        mainPrisma.audit_logs.count(),
        mainPrisma.audit_logs.count({
          where: { createdAt: { gte: startOfDay } },
        }),
      ]);

      return { total, today };
    } catch (err) {
      logger.warn("[AuditService] getAuditStats unavailable:", err.message);
      return { total: 0, today: 0 };
    }
  }
}

module.exports = new AuditServiceService();
