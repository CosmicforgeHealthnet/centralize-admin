const { executionError } = require("../execution.errors");
const { sanitizeExecutionJson } = require("../execution-json.validator");

function createStatusOperation({ type, resourceType, resourceId, beforeState, exposure, approvalFingerprint, now = new Date(), freshnessMinutes = 15 }) {
  if (!['PAUSE', 'RESUME'].includes(type)) throw executionError("INVALID_EXECUTION_PLAN", { field: "type", reasonCode: "STATUS_OPERATION_REQUIRED" });
  if (!resourceId || !beforeState?.status) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "CURRENT_STATUS_REQUIRED" });
  const capturedAt = beforeState.capturedAt || beforeState.snapshotAt;
  if (capturedAt) {
    const timestamp = new Date(capturedAt).getTime();
    if (!Number.isFinite(timestamp) || timestamp > now.getTime() || now.getTime() - timestamp > freshnessMinutes * 60 * 1000) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "STALE_STATUS_SNAPSHOT" });
  }
  if (type === "RESUME" && (!approvalFingerprint || !exposure || exposure.blockingViolations?.length)) {
    throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "ACTIVATION_EXPOSURE_AND_APPROVAL_REQUIRED" });
  }
  return sanitizeExecutionJson({
    operationType: type,
    resourceType,
    resourceId,
    beforeStatus: beforeState.status,
    beforeStateCapturedAt: capturedAt || null,
    desiredStatus: type === "PAUSE" ? "PAUSED" : "ACTIVE",
    exposure: exposure || null,
    approvalFingerprint: approvalFingerprint || null,
    readBackRequired: true,
  }, "desiredState");
}

module.exports = { createStatusOperation };
