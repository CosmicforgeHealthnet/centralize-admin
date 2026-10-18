const { mainPrisma } = require("../../shared/config/mainDatabase");
const eventBus = require("../../shared/events/eventBus");
const EVENTS = require("../../shared/events/events");
const {
  PRESCRIPTION_STATES,
  validatePrescriptionTransition,
} = require("../../shared/states/prescription.states");
const ApiError = require("../../shared/utils/ApiError");
const logger = require("../../shared/utils/logger");

const MAX_DELIVERY_RETRIES = 3;

class LogisticsService {
  constructor() {
    this._registerListeners();
  }

  _registerListeners() {
    eventBus.subscribe(EVENTS.PRESCRIPTION_CREATED, async (payload) => {
      await this._handlePrescriptionCreated(payload);
    });

    eventBus.subscribe(EVENTS.PAYMENT_SUCCESS, async (payload) => {
      await this._handlePaymentSuccess(payload);
    });
  }

  async _handlePrescriptionCreated({ prescriptionId }) {
    const prescription = await mainPrisma.prescriptions.findUnique({
      where: { id: prescriptionId },
      select: {
        id: true,
        status: true,
        deliveryAddress: true,
        pharmacyId: true,
      },
    });

    if (!prescription) {
      logger.warn(`[Logistics] Prescription not found: ${prescriptionId}`);
      return;
    }

    logger.info(`[Logistics] Prescription received: ${prescriptionId}`);
    eventBus.publish(EVENTS.DELIVERY_ASSIGNED, { prescriptionId });
  }

  async _handlePaymentSuccess({ serviceId, serviceType }) {
    if (serviceType !== "pharmacy") return;

    const prescription = await mainPrisma.prescriptions.findUnique({
      where: { id: serviceId },
      select: { id: true, status: true },
    });

    if (!prescription) return;

    try {
      validatePrescriptionTransition(
        prescription.status,
        PRESCRIPTION_STATES.PHARMACY_ASSIGNED,
      );

      await mainPrisma.prescriptions.update({
        where: { id: serviceId },
        data: { status: PRESCRIPTION_STATES.PHARMACY_ASSIGNED },
      });

      logger.info(
        `[Logistics] Prescription ${serviceId} activated after payment`,
      );
    } catch (err) {
      logger.error(`[Logistics] Payment activation failed: ${err.message}`);
    }
  }

  async getPrescription(id) {
    const prescription = await mainPrisma.prescriptions.findUnique({
      where: { id },
      select: {
        id: true,
        reference: true,
        status: true,
        patientId: true,
        doctorId: true,
        pharmacyId: true,
        medications: true,
        deliveryAddress: true,
        deliveryInstructions: true,
        expectedDeliveryDate: true,
        actualDeliveryDate: true,
        paymentStatus: true,
        availabilityStatus: true,
        createdAt: true,
      },
    });

    if (!prescription) throw new ApiError(404, "Prescription not found");
    return prescription;
  }

  async listPrescriptions({
    status,
    patientId,
    pharmacyId,
    page = 1,
    limit = 20,
  }) {
    const where = {};
    if (status) where.status = status;
    if (patientId) where.patientId = patientId;
    if (pharmacyId) where.pharmacyId = pharmacyId;

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      mainPrisma.prescriptions.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          reference: true,
          status: true,
          patientId: true,
          pharmacyId: true,
          paymentStatus: true,
          availabilityStatus: true,
          createdAt: true,
        },
      }),
      mainPrisma.prescriptions.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async transitionDelivery(id, toStatus, adminUser) {
    const prescription = await mainPrisma.prescriptions.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (!prescription) throw new ApiError(404, "Prescription not found");

    validatePrescriptionTransition(prescription.status, toStatus);

    const updated = await mainPrisma.prescriptions.update({
      where: { id },
      data: {
        status: toStatus,
        ...(toStatus === PRESCRIPTION_STATES.COMPLETED && {
          actualDeliveryDate: new Date(),
        }),
      },
    });

    logger.info(`[Logistics] Prescription ${id} → ${toStatus}`);

    if (toStatus === PRESCRIPTION_STATES.COMPLETED) {
      eventBus.publish(EVENTS.DELIVERY_COMPLETED, { prescriptionId: id });
    }

    if (toStatus === PRESCRIPTION_STATES.CANCELLED) {
      eventBus.publish(EVENTS.DELIVERY_FAILED, { prescriptionId: id });
    }

    return updated;
  }

  async retryDelivery(id) {
    const prescription = await mainPrisma.prescriptions.findUnique({
      where: { id },
      select: { id: true, status: true, pharmacyId: true },
    });

    if (!prescription) throw new ApiError(404, "Prescription not found");
    if (prescription.status !== PRESCRIPTION_STATES.CANCELLED) {
      throw new ApiError(400, "Only cancelled prescriptions can be retried");
    }

    const updated = await mainPrisma.prescriptions.update({
      where: { id },
      data: { status: PRESCRIPTION_STATES.PHARMACY_ASSIGNED },
    });

    logger.info(`[Logistics] Prescription ${id} retried`);
    return updated;
  }

  async getDeliveryStats() {
    try {
      const [total, pending, processing, completed, cancelled] =
        await Promise.all([
          mainPrisma.prescriptions.count(),
          mainPrisma.prescriptions.count({ where: { status: "pending" } }),
          mainPrisma.prescriptions.count({
            where: { status: "pharmacy_processing" },
          }),
          mainPrisma.prescriptions.count({ where: { status: "completed" } }),
          mainPrisma.prescriptions.count({ where: { status: "cancelled" } }),
        ]);

      return {
        total,
        pending,
        processing,
        readyForDelivery: 0,
        completed,
        cancelled,
      };
    } catch (err) {
      logger.warn(
        "[LogisticsService] getDeliveryStats unavailable:",
        err.message,
      );
      return {
        total: 0,
        pending: 0,
        processing: 0,
        readyForDelivery: 0,
        completed: 0,
        cancelled: 0,
      };
    }
  }
}

module.exports = new LogisticsService();
