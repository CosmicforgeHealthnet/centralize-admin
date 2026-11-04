const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { prisma } = require("../config/database");
const { effectiveGrants, hasEffectiveSection } = require("../auth/effective-access");


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


// Effective access = department defaults + explicit grants (one resolver,
// src/shared/auth/effective-access.js).
const hasSectionAccess = (user, module, section, requiredMode) =>
  hasEffectiveSection(prisma, user, module, section, requiredMode);


const requireSection = (module, section, mode = "VIEW") => {
  return asyncHandler(async (req, res, next) => {
    const user = req.adminUser;
    if (!user) throw new ApiError(401, "Unauthorized");

    if (user.tier === "SUPER") return next();

    const allowed = await hasSectionAccess(user, module, section, mode);
    if (!allowed) {
      throw new ApiError(403, "You do not have access to this section");
    }

    next();
  });
};

// Router gate for department workspaces: the existing tier minimum, or any
// effective access to this module (department defaults or an explicit
// Module Permission). Route-level requireSection checks decide each action.
const requireTierOrDepartment = (minimumTier, module) => {
  return asyncHandler(async (req, res, next) => {
    const user = req.adminUser;
    if (!user?.tier) throw new ApiError(401, "Unauthorized");
    if (TIER_HIERARCHY.indexOf(user.tier) >= TIER_HIERARCHY.indexOf(minimumTier)) return next();
    if ((await effectiveGrants(prisma, user, { module })).length) return next();
    throw new ApiError(403, "You do not have permission to perform this action");
  });
};


// Tier minimum as before, or the exact section through effective access
// (department ownership or an explicit Module Permission) for callers below
// that tier. Never lets a department leader act as Platform Admin elsewhere.
const requireTierOrSection = (minimumTier, module, section, mode = "VIEW") => {
  return asyncHandler(async (req, res, next) => {
    const user = req.adminUser;
    if (!user?.tier) throw new ApiError(401, "Unauthorized");
    if (TIER_HIERARCHY.indexOf(user.tier) >= TIER_HIERARCHY.indexOf(minimumTier)) return next();
    if (await hasSectionAccess(user, module, section, mode)) return next();
    throw new ApiError(403, "You do not have permission to perform this action");
  });
};

// Step-up for sensitive transactions performed through department
// leadership: callers at or above the tier keep today's behaviour.
const requireRecentMfaBelowTier = (minimumTier, maxAgeMs = 5 * 60 * 1000) => {
  return (req, res, next) => {
    const user = req.adminUser;
    if (user?.tier && TIER_HIERARCHY.indexOf(user.tier) >= TIER_HIERARCHY.indexOf(minimumTier)) return next();
    return require("./auth.middleware").requireRecentMfa(maxAgeMs)(req, res, next);
  };
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
  requireTierOrDepartment,
  requireTierOrSection,
  requireRecentMfaBelowTier,
  hasSectionAccess,
  requireDifferentReviewer,
  require2FA,
};
