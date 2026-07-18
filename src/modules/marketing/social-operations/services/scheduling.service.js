const ApiError = require("../../../../shared/utils/ApiError");
const { prisma } = require("../../../../shared/config/database");

function assertIanaTimezone(timezone) {
  if (typeof timezone !== "string" || timezone.trim() === "") {
    throw new ApiError(400, "timezone is required");
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new ApiError(400, "timezone must be a valid IANA timezone");
  }
  return timezone;
}

function workerShouldRunScheduledJob({ scheduledForUtc, now = new Date() }) {
  return new Date(scheduledForUtc).getTime() <= now.getTime();
}

async function cancelPendingPublishingJobsForPostEdit({ postId, db = prisma } = {}) {
  const jobs = await db.socialPublishingJob.findMany({
    where: {
      status: { in: ["PENDING", "RETRY_SCHEDULED"] },
      publication: { target: { postId } },
    },
    select: { id: true },
  });
  const ids = jobs.map((job) => job.id);
  if (ids.length === 0) return { cancelled: 0, ids: [] };

  const result = await db.socialPublishingJob.updateMany({
    where: { id: { in: ids } },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      lastErrorCategory: "PERMANENT",
      lastError: "Cancelled because approved content was edited.",
    },
  });
  return { cancelled: result.count || ids.length, ids };
}

function assertJobCancellable(job) {
  if (!job) throw new ApiError(404, "Social operation not found");
  if (!["PENDING", "RETRY_SCHEDULED"].includes(job.status)) {
    throw new ApiError(
      409,
      "Claimed or running jobs cannot be cancelled directly; use provider delete flow when supported.",
    );
  }
  return true;
}

module.exports = {
  assertIanaTimezone,
  workerShouldRunScheduledJob,
  cancelPendingPublishingJobsForPostEdit,
  assertJobCancellable,
};
