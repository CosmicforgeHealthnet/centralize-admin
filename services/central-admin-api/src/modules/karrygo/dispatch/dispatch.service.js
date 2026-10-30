const { dispatchPrisma } = require("../../../shared/config/dispatchDatabase");
const { prisma } = require("../../../shared/config/database");
const ApiError = require("../../../shared/utils/ApiError");
const logger = require("../../../shared/utils/logger");

const REQUIRED_STEPS = ["identity", "vehicle", "face"];

const resolveAdminDetails = async (uuids) => {
  if (!uuids || uuids.length === 0) return {};
  const admins = await prisma.adminUsers.findMany({
    where: { id: { in: uuids } },
    select: { id: true, fullName: true, email: true },
  });
  return Object.fromEntries(admins.map((a) => [a.id, a]));
};

const enrichAuditLogs = async (logs) => {
  const ids = [...new Set(logs.map((l) => l.performedBy).filter(Boolean))];
  const adminMap = await resolveAdminDetails(ids);
  return logs.map((log) => ({
    ...log,
    performedByAdmin: adminMap[log.performedBy] ?? null,
  }));
};

class DispatchService {
  async listProviders({ status, page = 1, limit = 20 }) {
    const where = {};
    if (status) where.verification_status = status;

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      dispatchPrisma.providers.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        select: {
          id: true,
          phone: true,
          full_name: true,
          email: true,
          state: true,
          city: true,
          operation_type: true,
          verification_status: true,
          avg_rating: true,
          total_trips: true,
          is_active: true,
          onboarding_complete: true,
          created_at: true,
          updated_at: true,
        },
      }),
      dispatchPrisma.providers.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async getProvider(id) {
    const provider = await dispatchPrisma.providers.findUnique({
      where: { id },
      include: {
        verification_steps: true,
        bikes: {
          include: { bike_documents: true },
        },
        guarantors: true,
        emergency_contacts: true,
      },
    });

    if (!provider) throw new ApiError(404, "Provider not found");

    const auditLogs = await dispatchPrisma.verification_audit.findMany({
      where: { provider_id: id },
      orderBy: { created_at: "desc" },
    });

    const enrichedLogs = await enrichAuditLogs(auditLogs);

    return { ...provider, verificationAudit: enrichedLogs };
  }

  async approveVerificationStep(providerId, step, adminId, notes) {
    const provider = await dispatchPrisma.providers.findUnique({
      where: { id: providerId },
      select: { id: true, verification_status: true },
    });

    if (!provider) throw new ApiError(404, "Provider not found");

    const verificationStep = await dispatchPrisma.verification_steps.findUnique(
      {
        where: { provider_id_step: { provider_id: providerId, step } },
      },
    );

    if (!verificationStep)
      throw new ApiError(404, "Verification step not found");

    if (verificationStep.status === "approved") {
      throw new ApiError(400, "Step is already approved");
    }

    const fromStatus = verificationStep.status;

    await dispatchPrisma.$transaction(async (tx) => {
      await tx.verification_steps.update({
        where: { provider_id_step: { provider_id: providerId, step } },
        data: {
          status: "approved",
          reviewed_at: new Date(),
          reviewer_id: adminId,
          rejection_reason: null,
          updated_at: new Date(),
        },
      });

      await tx.verification_audit.create({
        data: {
          provider_id: providerId,
          step,
          action: "approved",
          from_status: fromStatus,
          to_status: "approved",
          performed_by: adminId,
          notes: notes ?? null,
        },
      });

      const allSteps = await tx.verification_steps.findMany({
        where: { provider_id: providerId },
        select: { step: true, status: true, is_optional: true },
      });

      const requiredSteps = allSteps.filter((s) =>
        REQUIRED_STEPS.includes(s.step),
      );
      const allRequiredApproved = requiredSteps.every(
        (s) => s.status === "approved",
      );

      if (allRequiredApproved) {
        await tx.providers.update({
          where: { id: providerId },
          data: { verification_status: "verified", updated_at: new Date() },
        });

        await tx.verification_audit.create({
          data: {
            provider_id: providerId,
            step: "all",
            action: "fully_approved",
            from_status: "pending",
            to_status: "approved",
            performed_by: adminId,
            notes: "All required verification steps approved.",
          },
        });

        logger.info(`[Dispatch] Provider ${providerId} fully verified`);
      }
    });

    logger.info(
      `[Dispatch] Step '${step}' approved for provider ${providerId} by admin ${adminId}`,
    );
  }

  async rejectVerificationStep(providerId, step, adminId, reason) {
    if (!reason || !reason.trim()) {
      throw new ApiError(400, "Rejection reason is required");
    }

    const provider = await dispatchPrisma.providers.findUnique({
      where: { id: providerId },
      select: { id: true, verification_status: true },
    });

    if (!provider) throw new ApiError(404, "Provider not found");

    const verificationStep = await dispatchPrisma.verification_steps.findUnique(
      {
        where: { provider_id_step: { provider_id: providerId, step } },
      },
    );

    if (!verificationStep)
      throw new ApiError(404, "Verification step not found");

    if (verificationStep.status === "rejected") {
      throw new ApiError(400, "Step is already rejected");
    }

    const fromStatus = verificationStep.status;

    await dispatchPrisma.$transaction(async (tx) => {
      await tx.verification_steps.update({
        where: { provider_id_step: { provider_id: providerId, step } },
        data: {
          status: "rejected",
          reviewed_at: new Date(),
          reviewer_id: adminId,
          rejection_reason: reason,
          updated_at: new Date(),
        },
      });

      await tx.verification_audit.create({
        data: {
          provider_id: providerId,
          step,
          action: "rejected",
          from_status: fromStatus,
          to_status: "rejected",
          performed_by: adminId,
          notes: reason,
        },
      });

      await tx.providers.update({
        where: { id: providerId },
        data: { verification_status: "pending_review", updated_at: new Date() },
      });
    });

    logger.info(
      `[Dispatch] Step '${step}' rejected for provider ${providerId} by admin ${adminId}`,
    );
  }

  async suspendProvider(providerId, adminId, reason) {
    if (!reason || !reason.trim()) {
      throw new ApiError(400, "Suspension reason is required");
    }

    const provider = await dispatchPrisma.providers.findUnique({
      where: { id: providerId },
      select: { id: true, verification_status: true, is_active: true },
    });

    if (!provider) throw new ApiError(404, "Provider not found");
    if (provider.verification_status === "suspended") {
      throw new ApiError(400, "Provider is already suspended");
    }

    await dispatchPrisma.$transaction(async (tx) => {
      await tx.providers.update({
        where: { id: providerId },
        data: {
          verification_status: "suspended",
          is_active: false,
          updated_at: new Date(),
        },
      });

      await tx.verification_audit.create({
        data: {
          provider_id: providerId,
          step: "all",
          action: "suspended",
          from_status: provider.verification_status,
          to_status: "approved",
          performed_by: adminId,
          notes: reason,
        },
      });

      await tx.bikes.updateMany({
        where: { provider_id: providerId },
        data: {
          verification_status: "suspended",
          is_active: false,
          updated_at: new Date(),
        },
      });

      await tx.bike_audit.createMany({
        data: (
          await tx.bikes.findMany({
            where: { provider_id: providerId },
            select: { id: true },
          })
        ).map((bike) => ({
          bike_id: bike.id,
          provider_id: providerId,
          action: "suspended",
          from_status: "verified",
          to_status: "suspended",
          performed_by: adminId,
          notes: "Entire provider account suspended",
        })),
      });
    });

    logger.info(
      `[Dispatch] Provider ${providerId} suspended by admin ${adminId}`,
    );
  }

  async unsuspendProvider(providerId, adminId) {
    const provider = await dispatchPrisma.providers.findUnique({
      where: { id: providerId },
      select: { id: true, verification_status: true },
    });

    if (!provider) throw new ApiError(404, "Provider not found");
    if (provider.verification_status !== "suspended") {
      throw new ApiError(400, "Provider is not suspended");
    }

    await dispatchPrisma.$transaction(async (tx) => {
      await tx.providers.update({
        where: { id: providerId },
        data: {
          verification_status: "verified",
          is_active: true,
          updated_at: new Date(),
        },
      });

      await tx.verification_audit.create({
        data: {
          provider_id: providerId,
          step: "all",
          action: "approved",
          from_status: "approved",
          to_status: "approved",
          performed_by: adminId,
          notes: "Provider account unsuspended.",
        },
      });
    });

    logger.info(
      `[Dispatch] Provider ${providerId} unsuspended by admin ${adminId}`,
    );
  }

  async listTrips({ status, providerId, page = 1, limit = 20 }) {
    const where = {};
    if (status) where.status = status;
    if (providerId) where.provider_id = providerId;

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      dispatchPrisma.trips.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        select: {
          id: true,
          booking_id: true,
          provider_id: true,
          customer_id: true,
          status: true,
          pickup_address: true,
          dropoff_address: true,
          distance_km: true,
          fare_amount: true,
          currency: true,
          receiver_name: true,
          receiver_phone: true,
          package_desc: true,
          started_at: true,
          completed_at: true,
          cancelled_at: true,
          created_at: true,
        },
      }),
      dispatchPrisma.trips.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async getTrip(id) {
    const trip = await dispatchPrisma.trips.findUnique({
      where: { id },
      include: {
        trip_state_log: { orderBy: { changed_at: "asc" } },
        cancellations: true,
        delivery_proofs: true,
      },
    });

    if (!trip) throw new ApiError(404, "Trip not found");
    return trip;
  }

  async listBikes({ status, providerId, page = 1, limit = 20 }) {
    const where = {};
    if (status) where.verification_status = status;
    if (providerId) where.provider_id = providerId;

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      dispatchPrisma.bikes.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        select: {
          id: true,
          provider_id: true,
          bike_type: true,
          brand: true,
          model: true,
          year: true,
          color: true,
          plate_number: true,
          verification_status: true,
          is_active: true,
          is_primary: true,
          created_at: true,
        },
      }),
      dispatchPrisma.bikes.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async getBike(id) {
    const bike = await dispatchPrisma.bikes.findUnique({
      where: { id },
      include: {
        bike_documents: true,
        bike_audit: { orderBy: { created_at: "desc" } },
      },
    });

    if (!bike) throw new ApiError(404, "Bike not found");
    return bike;
  }

  async approveBike(bikeId, adminId) {
    const bike = await dispatchPrisma.bikes.findUnique({
      where: { id: bikeId },
      select: { id: true, provider_id: true, verification_status: true },
    });

    if (!bike) throw new ApiError(404, "Bike not found");
    if (bike.verification_status === "verified") {
      throw new ApiError(400, "Bike is already verified");
    }

    const fromStatus = bike.verification_status;

    await dispatchPrisma.$transaction(async (tx) => {
      await tx.bikes.update({
        where: { id: bikeId },
        data: { verification_status: "verified", updated_at: new Date() },
      });

      await tx.bike_audit.create({
        data: {
          bike_id: bikeId,
          provider_id: bike.provider_id,
          action: "approved",
          from_status: fromStatus,
          to_status: "verified",
          performed_by: adminId,
        },
      });

      await tx.verification_steps.updateMany({
        where: { provider_id: bike.provider_id, step: "vehicle" },
        data: {
          status: "approved",
          reviewed_at: new Date(),
          reviewer_id: adminId,
          updated_at: new Date(),
        },
      });

      await tx.verification_audit.create({
        data: {
          provider_id: bike.provider_id,
          step: "vehicle",
          action: "approved",
          from_status: "pending",
          to_status: "approved",
          performed_by: adminId,
          notes: "Vehicle approved from bike approval.",
        },
      });
    });

    logger.info(`[Dispatch] Bike ${bikeId} approved by admin ${adminId}`);
  }

  async rejectBike(bikeId, adminId, reason) {
    if (!reason || !reason.trim()) {
      throw new ApiError(400, "Rejection reason is required");
    }

    const bike = await dispatchPrisma.bikes.findUnique({
      where: { id: bikeId },
      select: { id: true, provider_id: true, verification_status: true },
    });

    if (!bike) throw new ApiError(404, "Bike not found");
    if (bike.verification_status === "rejected") {
      throw new ApiError(400, "Bike is already rejected");
    }

    const fromStatus = bike.verification_status;

    await dispatchPrisma.$transaction(async (tx) => {
      await tx.bikes.update({
        where: { id: bikeId },
        data: { verification_status: "rejected", updated_at: new Date() },
      });

      await tx.bike_audit.create({
        data: {
          bike_id: bikeId,
          provider_id: bike.provider_id,
          action: "rejected",
          from_status: fromStatus,
          to_status: "rejected",
          performed_by: adminId,
          notes: reason,
        },
      });

      await tx.verification_steps.updateMany({
        where: { provider_id: bike.provider_id, step: "vehicle" },
        data: {
          status: "rejected",
          reviewed_at: new Date(),
          reviewer_id: adminId,
          rejection_reason: reason,
          updated_at: new Date(),
        },
      });

      await tx.verification_audit.create({
        data: {
          provider_id: bike.provider_id,
          step: "vehicle",
          action: "rejected",
          from_status: "pending",
          to_status: "rejected",
          performed_by: adminId,
          notes: reason,
        },
      });
    });

    logger.info(`[Dispatch] Bike ${bikeId} rejected by admin ${adminId}`);
  }
}

module.exports = new DispatchService();
