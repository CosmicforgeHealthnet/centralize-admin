const ApiError = require("../utils/ApiError");

// Tier hierarchy — higher index = more access
const TIER_HIERARCHY = ["EMPLOYEE", "ADMIN", "EXECUTIVE", "SUPER"];

// requireTier('ADMIN') — user must be ADMIN or above
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

// requireExactTier('SUPER') — must be exactly this tier
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

module.exports = { requireTier, requireExactTier, readOnly };
