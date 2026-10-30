const ApiError = require("../../../../shared/utils/ApiError");
const { prisma } = require("../../../../shared/config/database");
const {
  SOCIAL_OPERATION_SECTIONS,
} = require("../governance/social-operations.sections");
const { hasSocialSectionGrant } = require("../services/social-authorization.service");

const SAFETY_CLASSIFICATIONS = Object.freeze([
  "MEDICAL_EMERGENCY",
  "SELF_HARM_RISK",
]);

function requiredSectionsForClassification(classification) {
  if (SAFETY_CLASSIFICATIONS.includes(classification)) {
    return [SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_SAFETY];
  }
  return [
    SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_RESTRICTED,
    SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_SAFETY,
  ];
}

async function adminHasAnySection({ adminUser, sections, db, mode = "EDIT" }) {
  if (!adminUser) return false;
  if (adminUser.tier === "SUPER") return true;
  for (const section of sections) {
    if (await hasSocialSectionGrant({ adminUser, section, mode, db })) {
      return true;
    }
  }
  return false;
}

async function validateSafetyAssignee({
  adminUserId,
  classification,
  db = prisma,
} = {}) {
  if (adminUserId === null || adminUserId === undefined) return null;
  if (typeof adminUserId === "string" && adminUserId.trim() === "") {
    throw new ApiError(400, "Social escalation assignee is not eligible");
  }
  const adminUser = await db.adminUser.findUnique({ where: { id: adminUserId } });
  if (!adminUser || adminUser.status !== "ACTIVE") {
    throw new ApiError(400, "Social escalation assignee is not eligible");
  }
  const sections = requiredSectionsForClassification(classification);
  const allowed = await adminHasAnySection({ adminUser, sections, db });
  if (!allowed) throw new ApiError(403, "Social escalation assignee is not eligible");
  return adminUser;
}

async function findEligibleAssignee({ classification, db = prisma } = {}) {
  const admins = await db.adminUser.findMany({
    where: { status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
  });
  for (const adminUser of admins) {
    if (
      await adminHasAnySection({
        adminUser,
        sections: requiredSectionsForClassification(classification),
        db,
        mode: "EDIT",
      })
    ) {
      return adminUser;
    }
  }
  return null;
}

module.exports = {
  SAFETY_CLASSIFICATIONS,
  requiredSectionsForClassification,
  adminHasAnySection,
  validateSafetyAssignee,
  findEligibleAssignee,
};
