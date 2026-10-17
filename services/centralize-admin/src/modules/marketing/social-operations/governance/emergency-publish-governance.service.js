const { SOCIAL_OPERATION_ACTIONS } = require("./social-operations.rbac");

function validateEmergencyReason(reason) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return {
      valid: false,
      reasonCode: "EMERGENCY_REASON_REQUIRED",
      message: "Emergency publishing requires a non-empty reason.",
    };
  }

  return {
    valid: true,
    reasonCode: null,
    message: null,
    normalizedReason: reason.trim(),
  };
}

async function auditBeforeEmergencyEnqueue({
  reason,
  audit,
  enqueue,
  auditPayload = {},
  enqueuePayload = {},
}) {
  const validation = validateEmergencyReason(reason);
  if (!validation.valid) return { enqueued: false, ...validation };

  await audit({
    ...auditPayload,
    reason: validation.normalizedReason,
    requiredGrant: SOCIAL_OPERATION_ACTIONS.PUBLISH_EMERGENCY_OVERRIDE,
  });

  const enqueueResult = await enqueue({
    ...enqueuePayload,
    reason: validation.normalizedReason,
  });

  return {
    enqueued: true,
    reasonCode: null,
    message: null,
    enqueueResult,
  };
}

module.exports = {
  validateEmergencyReason,
  auditBeforeEmergencyEnqueue,
};
