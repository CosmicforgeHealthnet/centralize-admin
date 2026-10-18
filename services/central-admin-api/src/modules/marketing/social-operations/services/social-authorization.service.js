const { prisma } = require("../../../../shared/config/database");
const {
  SOCIAL_OPERATION_SECTIONS,
} = require("../governance/social-operations.sections");

const SECTION_MODE_RANK = Object.freeze({ VIEW: 1, EDIT: 2 });

async function hasSocialSectionGrant({
  adminUser,
  section,
  mode = "VIEW",
  db = prisma,
}) {
  if (!adminUser) return false;
  if (adminUser.tier === "SUPER") return true;

  const now = new Date();
  const grants = await db.adminSectionGrant.findMany({
    where: {
      adminUserId: adminUser.id,
      module: "marketing",
      section: { in: [section, "*"] },
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });

  return grants.some(
    (grant) => SECTION_MODE_RANK[grant.mode] >= SECTION_MODE_RANK[mode],
  );
}

async function canViewRestricted({ adminUser, db = prisma }) {
  return hasSocialSectionGrant({
    adminUser,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_RESTRICTED,
    mode: "VIEW",
    db,
  });
}

async function canEditRestricted({ adminUser, db = prisma }) {
  return hasSocialSectionGrant({
    adminUser,
    section: SOCIAL_OPERATION_SECTIONS.SOCIAL_MODERATION_RESTRICTED,
    mode: "EDIT",
    db,
  });
}

module.exports = {
  hasSocialSectionGrant,
  canViewRestricted,
  canEditRestricted,
};
