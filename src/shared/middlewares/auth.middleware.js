const { verifyAccessToken } = require("../utils/jwt.util");
const { prisma } = require("../config/database");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

// FIX #11: Centralise the change-password path so it doesn't silently break
// if the route prefix changes. Update this constant if the route moves.
const CHANGE_PASSWORD_PATH = "/change-password";

const authenticate = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new ApiError(401, "No token provided");
  }

  const token = authHeader.split(" ")[1];

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (err) {
    if (err.name === "TokenExpiredError")
      throw new ApiError(401, "Token expired");
    throw new ApiError(401, "Invalid token");
  }

  // Verify user still exists and is active
  const adminUser = await prisma.adminUser.findUnique({
    where: { id: decoded.sub },
    select: {
      id: true,
      email: true,
      name: true,
      tier: true,
      status: true,
      isTeamLead: true,
      department: true,
      mustChangePassword: true,
      passwordChangedAt: true, // FIX #2: needed for post-password-change token check
    },
  });

  if (!adminUser) throw new ApiError(401, "User no longer exists");
  if (adminUser.status === "INACTIVE")
    throw new ApiError(403, "Account deactivated");
  if (adminUser.status === "LOCKED") throw new ApiError(403, "Account locked");

  // FIX #2: Reject access tokens issued before the last password change.
  // decoded.iat is in seconds; passwordChangedAt is a Date — align units.
  if (adminUser.passwordChangedAt) {
    const passwordChangedAtSeconds = Math.floor(
      adminUser.passwordChangedAt.getTime() / 1000,
    );
    if (decoded.iat < passwordChangedAtSeconds) {
      throw new ApiError(
        401,
        "Token invalidated due to password change. Please log in again",
      );
    }
  }

  // FIX #11: Use the constant instead of a hardcoded string
  if (
    adminUser.mustChangePassword &&
    !req.path.endsWith(CHANGE_PASSWORD_PATH)
  ) {
    throw new ApiError(403, "You must change your password before continuing");
  }

  req.adminUser = adminUser;
  next();
});

module.exports = { authenticate };
