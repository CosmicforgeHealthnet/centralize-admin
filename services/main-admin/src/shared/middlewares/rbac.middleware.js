const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { prisma } = require("../config/database");


const TIER_HIERARCHY = ["EMPLOYEE", "ADMIN", "EXECUTIVE", "SUPER"];


const requireTier = (...allowedTiers) => {
  return (req, res, next) => {
    const userTier = req.adminUser?.tier;
    if (!userTier) throw new ApiError(401, "Unauthorized");

    const hasAccess = allowedTiers.some((tier) => {
      const userLevel = TIER_HIERARCHY.indexOf(userTier);
      const requiredLevel = TIER_HIERARCHY.indexOf(tier);
      return userLevel >= requiredLevel;
    });

    if (!hasAccess) {
      throw new ApiError(
        403,
        "You do not have permission to perform this action",
      );
    }

    next();
  };
};


const requireExactTier = (...tiers) => {
  return (req, res, next) => {
    if (!tiers.includes(req.adminUser?.tier)) {
      throw new ApiError(
        403,
        "You do not have permission to perform this action",
      );
    }
    next();
  };
};

// EXECUTIVE can only read — block write operations
const readOnly = (req, res, next) => {
  const tier = req.adminUser?.tier;
  if (tier === "EXECUTIVE") {
    const writeMethods = ["POST", "PUT", "PATCH", "DELETE"];
    if (writeMethods.includes(req.method)) {
      throw new ApiError(403, "Executive accounts have read-only access");
    }
  }
  next();
};


const SECTION_MODE_RANK = { VIEW: 1, EDIT: 2 };

const hasSectionAccess = async (adminUserId, module, section, requiredMode) => {
  const now = new Date();

  const grants = await prisma.adminSectionGrant.findMany({
    where: {
      adminUserId,
      module,
      section: { in: [section, "*"] },
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });

  return grants.some(
    (grant) => SECTION_MODE_RANK[grant.mode] >= SECTION_MODE_RANK[requiredMode],
  );
};


const requireSection = (module, section, mode = "VIEW") => {
  return asyncHandler(async (req, res, next) => {
    const user = req.adminUser;
    if (!user) throw new ApiError(401, "Unauthorized");

    if (user.tier === "SUPER") return next();

    const allowed = await hasSectionAccess(user.id, module, section, mode);
    if (!allowed) {
      throw new ApiError(403, "You do not have access to this section");
    }

    next();
  });
};


const requireDifferentReviewer = (getPriorReviewerId) => {
  return asyncHandler(async (req, res, next) => {
    const priorReviewerId = await getPriorReviewerId(req);

    if (priorReviewerId && priorReviewerId === req.adminUser?.id) {
      throw new ApiError(
        403,
        "The same account cannot both review and approve this submission",
      );
    }

    next();
  });
};

const require2FA = () => {
  return (req, res, next) => {
    if (!req.adminUser?.twoFactorEnabled) {
      throw new ApiError(
        403,
        "Two-factor authentication must be enabled to perform this action",
      );
    }
    next();
  };
};

module.exports = {
  requireTier,
  requireExactTier,
  readOnly,
  requireSection,
  requireDifferentReviewer,
  require2FA,
};
