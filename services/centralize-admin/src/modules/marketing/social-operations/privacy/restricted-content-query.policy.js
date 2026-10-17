const ApiError = require("../../../../shared/utils/ApiError");
const { prisma } = require("../../../../shared/config/database");
const {
  SOCIAL_OPERATION_SECTIONS,
} = require("../governance/social-operations.sections");
const { hasSocialSectionGrant } = require("../services/social-authorization.service");
const { writeSocialAudit } = require("../security/social-audit.service");

const GENERIC_RESTRICTED_FORBIDDEN = "Forbidden";

async function canViewRestrictedContent({ adminUser, safety = false, db = prisma } = {}) {
  if (!adminUser) return false;
  if (adminUser.tier === "SUPER") return true;
  if (
    await hasSocialSectionGrant({
      adminUser,
      section: SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_RESTRICTED,
      mode: "VIEW",
      db,
    })
  ) {
    return true;
  }
  if (safety) {
    return hasSocialSectionGrant({
      adminUser,
      section: SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_SAFETY,
      mode: "VIEW",
      db,
    });
  }
  return false;
}

async function assertRestrictedContentAccess({
  adminUser,
  entityType,
  entityId,
  safety = false,
  db = prisma,
  auditWriter,
  req,
} = {}) {
  const allowed = await canViewRestrictedContent({ adminUser, safety, db });
  if (!allowed) throw new ApiError(403, GENERIC_RESTRICTED_FORBIDDEN);
  await writeSocialAudit({
    actorId: adminUser?.id,
    operation: "SOCIAL_RESTRICTED_CONTENT_ACCESSED",
    targetId: entityId,
    targetType: entityType,
    metadata: {
      entityType,
      entityId,
      grantCategory: safety ? "social_moderation_safety" : "social_moderation_restricted",
    },
    req,
    auditWriter,
  });
  return true;
}

module.exports = {
  GENERIC_RESTRICTED_FORBIDDEN,
  canViewRestrictedContent,
  assertRestrictedContentAccess,
};
