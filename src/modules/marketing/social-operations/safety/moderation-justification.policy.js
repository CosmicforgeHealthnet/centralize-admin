const ApiError = require("../../../../shared/utils/ApiError");
const {
  SOCIAL_OPERATION_SECTIONS,
} = require("../governance/social-operations.sections");
const { hasSocialSectionGrant } = require("../services/social-authorization.service");
const { writeSocialAudit } = require("../security/social-audit.service");

const MAX_REASON_LENGTH = 500;

function sectionForModerationAction(action) {
  return action === "delete"
    ? SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_DELETE
    : SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_HIDE;
}

async function assertModerationJustification({
  action,
  reason,
  adminUser,
  entityId,
  db,
  auditWriter,
} = {}) {
  const normalizedReason = String(reason || "").trim();
  if (!normalizedReason || normalizedReason.length > MAX_REASON_LENGTH) {
    throw new ApiError(400, "Moderation reason is required");
  }
  const allowed = await hasSocialSectionGrant({
    adminUser,
    section: sectionForModerationAction(action),
    mode: "EDIT",
    db,
  });
  if (!allowed) throw new ApiError(403, "Forbidden");

  await writeSocialAudit({
    actorId: adminUser?.id,
    operation: "SOCIAL_MODERATION_INTENT_AUDITED",
    targetId: entityId,
    targetType: "SOCIAL_COMMENT",
    metadata: {
      action,
      reason: normalizedReason,
    },
    auditWriter,
  });
  return { action, reason: normalizedReason };
}

module.exports = {
  MAX_REASON_LENGTH,
  assertModerationJustification,
};
