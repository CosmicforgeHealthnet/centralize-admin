const { mainPrisma } = require("../../shared/config/mainDatabase");
const eventBus = require("../../shared/events/eventBus");
const EVENTS = require("../../shared/events/events");
const {
  RTC_STATES,
  validateRTCTransition,
} = require("../../shared/states/rtc.states");
const ApiError = require("../../shared/utils/ApiError");
const logger = require("../../shared/utils/logger");

class RTCService {
  constructor() {
    this._registerListeners();
  }

  _registerListeners() {
    eventBus.subscribe(
      EVENTS.CONSULTATION_STARTED,
      async ({ consultationId }) => {
        await this._activateSession(consultationId);
      },
    );

    eventBus.subscribe(
      EVENTS.CONSULTATION_COMPLETED,
      async ({ consultationId }) => {
        await this._endSession(consultationId);
      },
    );
  }

  async _activateSession(consultationId) {
    const session = await mainPrisma.appointment_chats.findFirst({
      where: { appointmentId: consultationId },
    });

    if (!session) {
      logger.warn(`[RTC] No session found for consultation: ${consultationId}`);
      return;
    }

    try {
      validateRTCTransition(session.status, RTC_STATES.ACTIVE);
      await mainPrisma.appointment_chats.update({
        where: { id: session.id },
        data: { status: RTC_STATES.ACTIVE, actualStartTime: new Date() },
      });

      eventBus.publish(EVENTS.RTC_SESSION_STARTED, {
        sessionId: session.id,
        consultationId,
      });
      logger.info(`[RTC] Session ${session.id} activated`);
    } catch (err) {
      logger.error(`[RTC] Failed to activate session: ${err.message}`);
      await this._handleSessionFailure(session.id, consultationId);
    }
  }

  async _endSession(consultationId) {
    const session = await mainPrisma.appointment_chats.findFirst({
      where: { appointmentId: consultationId },
    });

    if (!session) return;

    try {
      validateRTCTransition(session.status, RTC_STATES.ENDED);
      await mainPrisma.appointment_chats.update({
        where: { id: session.id },
        data: { status: RTC_STATES.ENDED, actualEndTime: new Date() },
      });

      eventBus.publish(EVENTS.RTC_SESSION_ENDED, { sessionId: session.id });
      logger.info(`[RTC] Session ${session.id} ended`);
    } catch (err) {
      logger.error(`[RTC] Failed to end session: ${err.message}`);
    }
  }

  async _handleSessionFailure(sessionId, consultationId) {
    try {
      await mainPrisma.appointment_chats.update({
        where: { id: sessionId },
        data: { status: RTC_STATES.CANCELLED },
      });

      eventBus.publish(EVENTS.RTC_SESSION_FAILED, {
        sessionId,
        consultationId,
      });
      logger.warn(`[RTC] Session ${sessionId} marked as cancelled`);
    } catch (err) {
      logger.error(`[RTC] Could not mark session as cancelled: ${err.message}`);
    }
  }

  async getSession(id) {
    const session = await mainPrisma.appointment_chats.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        roomId: true,
        doctorId: true,
        patientId: true,
        scheduledStartTime: true,
        scheduledEndTime: true,
        actualStartTime: true,
        actualEndTime: true,
        appointmentId: true,
      },
    });

    if (!session) throw new ApiError(404, "RTC session not found");
    return session;
  }

  async listSessions({ status, page = 1, limit = 20 }) {
    const where = {};
    if (status) where.status = status;

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      mainPrisma.appointment_chats.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          doctorId: true,
          patientId: true,
          scheduledStartTime: true,
          actualStartTime: true,
          actualEndTime: true,
          appointmentId: true,
        },
      }),
      mainPrisma.appointment_chats.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async transitionSession(id, toStatus) {
    const session = await mainPrisma.appointment_chats.findUnique({
      where: { id },
      select: { id: true, status: true, appointmentId: true },
    });

    if (!session) throw new ApiError(404, "RTC session not found");

    validateRTCTransition(session.status, toStatus);

    const updated = await mainPrisma.appointment_chats.update({
      where: { id },
      data: {
        status: toStatus,
        ...(toStatus === RTC_STATES.ACTIVE && { actualStartTime: new Date() }),
        ...(toStatus === RTC_STATES.ENDED && { actualEndTime: new Date() }),
      },
    });

    logger.info(`[RTC] Session ${id} manually transitioned → ${toStatus}`);
    return updated;
  }

  async getSessionStats() {
    try {
      const [total, scheduled, active, completed, cancelled] =
        await Promise.all([
          mainPrisma.appointment_chats.count(),
          mainPrisma.appointment_chats.count({
            where: { status: "scheduled" },
          }),
          mainPrisma.appointment_chats.count({ where: { status: "active" } }),
          mainPrisma.appointment_chats.count({
            where: { status: "completed" },
          }),
          mainPrisma.appointment_chats.count({
            where: { status: "cancelled" },
          }),
        ]);

      return { total, scheduled, active, completed, cancelled };
    } catch (err) {
      logger.warn("[RTCService] getSessionStats unavailable:", err.message);
      return { total: 0, scheduled: 0, active: 0, completed: 0, cancelled: 0 };
    }
  }
}

module.exports = new RTCService();
