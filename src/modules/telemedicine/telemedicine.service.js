const { mainPrisma } = require("../../shared/config/mainDatabase");
const eventBus = require("../../shared/events/eventBus");
const EVENTS = require("../../shared/events/events");
const {
  CONSULTATION_STATES,
  validateConsultationTransition,
} = require("../../shared/states/consultation.states");
const ApiError = require("../../shared/utils/ApiError");
const logger = require("../../shared/utils/logger");

class TelemedicineService {
  async getConsultation(id) {
    const consultation = await mainPrisma.appointments.findUnique({
      where: { id },
      select: {
        id: true,
        patientId: true,
        doctorId: true,
        status: true,
        appointmentDate: true,
        appointmentTime: true,
        reason: true,
        paymentStatus: true,
        appointment_chats: {
          select: {
            id: true,
            status: true,
            roomId: true,
            scheduledStartTime: true,
            scheduledEndTime: true,
            actualStartTime: true,
            actualEndTime: true,
          },
        },
      },
    });

    if (!consultation) throw new ApiError(404, "Consultation not found");
    return consultation;
  }

  async listConsultations({
    status,
    doctorId,
    patientId,
    page = 1,
    limit = 20,
  }) {
    const where = {};
    if (status) where.status = status;
    if (doctorId) where.doctorId = doctorId;
    if (patientId) where.patientId = patientId;

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      mainPrisma.appointments.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          patientId: true,
          doctorId: true,
          status: true,
          appointmentDate: true,
          paymentStatus: true,
          createdAt: true,
        },
      }),
      mainPrisma.appointments.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async transitionConsultation(id, toStatus, adminUser) {
    const consultation = await mainPrisma.appointments.findUnique({
      where: { id },
      select: { id: true, status: true, patientId: true, doctorId: true },
    });

    if (!consultation) throw new ApiError(404, "Consultation not found");

    validateConsultationTransition(consultation.status, toStatus);

    const updated = await mainPrisma.appointments.update({
      where: { id },
      data: {
        status: toStatus,
        ...(toStatus === CONSULTATION_STATES.COMPLETED && {
          completedAt: new Date(),
        }),
        ...(toStatus === CONSULTATION_STATES.CANCELLED && {
          cancelledAt: new Date(),
          cancelledBy: adminUser.id,
          isCancelled: true,
        }),
      },
    });

    logger.info(`[Telemedicine] Consultation ${id} → ${toStatus}`);

    if (toStatus === CONSULTATION_STATES.COMPLETED) {
      eventBus.publish(EVENTS.CONSULTATION_COMPLETED, {
        consultationId: id,
        patientId: consultation.patientId,
        doctorId: consultation.doctorId,
      });
    }

    if (toStatus === CONSULTATION_STATES.SCHEDULED) {
      eventBus.publish(EVENTS.CONSULTATION_STARTED, {
        consultationId: id,
        patientId: consultation.patientId,
        doctorId: consultation.doctorId,
      });
    }

    if (toStatus === CONSULTATION_STATES.CANCELLED) {
      eventBus.publish(EVENTS.CONSULTATION_CANCELLED, {
        consultationId: id,
        patientId: consultation.patientId,
        doctorId: consultation.doctorId,
      });
    }

    return updated;
  }

  async getConsultationStats() {
    try {
      const [total, pending, scheduled, completed, cancelled] =
        await Promise.all([
          mainPrisma.appointments.count(),
          mainPrisma.appointments.count({ where: { status: "pending" } }),
          mainPrisma.appointments.count({ where: { status: "scheduled" } }),
          mainPrisma.appointments.count({ where: { status: "completed" } }),
          mainPrisma.appointments.count({ where: { status: "cancelled" } }),
        ]);

      return { total, pending, scheduled, completed, cancelled };
    } catch (err) {
      logger.warn(
        "[TelemedicineService] getConsultationStats unavailable:",
        err.message,
      );
      return { total: 0, pending: 0, scheduled: 0, completed: 0, cancelled: 0 };
    }
  }
}

module.exports = new TelemedicineService();
