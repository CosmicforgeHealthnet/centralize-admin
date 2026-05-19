const authService = require("./auth.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const REFRESH_TOKEN_COOKIE = "refreshToken";

const refreshTokenCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

const isLoggedInCookieOptions = {
  httpOnly: false,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const result = await authService.login({
    email,
    password,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.cookie(REFRESH_TOKEN_COOKIE, result.refreshToken, refreshTokenCookieOptions);
  res.cookie("isLoggedIn", "true", isLoggedInCookieOptions);

  return ApiResponse.success(res, 200, "Login successful", {
    accessToken: result.accessToken,
    mustChangePassword: result.mustChangePassword,
    user: result.user,
  });
});

const googleCallback = asyncHandler(async (req, res) => {
  const user = req.user;

  const result = await authService.googleLogin({
    user,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.cookie(REFRESH_TOKEN_COOKIE, result.refreshToken, refreshTokenCookieOptions);
  res.cookie("isLoggedIn", "true", isLoggedInCookieOptions);

  const frontendURL = process.env.CORS_ORIGINS.split(",")[0].trim();
  return res.redirect(
    `${frontendURL}/auth/google/callback?token=${result.accessToken}`,
  );
});

const refreshToken = asyncHandler(async (req, res) => {
  const token = req.cookies?.[REFRESH_TOKEN_COOKIE];

  if (!token) {
    return ApiResponse.error(res, 401, "No refresh token provided");
  }

  const result = await authService.refreshToken({
    token,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.cookie(REFRESH_TOKEN_COOKIE, result.refreshToken, refreshTokenCookieOptions);
  res.cookie("isLoggedIn", "true", isLoggedInCookieOptions);

  return ApiResponse.success(res, 200, "Token refreshed", {
    accessToken: result.accessToken,
  });
});

const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.[REFRESH_TOKEN_COOKIE];

  if (token) {
    await authService.logout({ refreshToken: token, req });
  }

  res.clearCookie(REFRESH_TOKEN_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
  });
  res.clearCookie("isLoggedIn", {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
  });

  return ApiResponse.success(res, 200, "Logged out successfully");
});

const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  await authService.changePassword({
    adminUserId: req.adminUser.id,
    currentPassword,
    newPassword,
    req,
  });

  res.clearCookie(REFRESH_TOKEN_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
  });
  res.clearCookie("isLoggedIn", {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
  });

  return ApiResponse.success(
    res,
    200,
    "Password changed successfully. Please log in again",
  );
});

const getMe = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, 200, "User profile", req.adminUser);
});

// ─────────────────────────────────────────────────────────────
// PASSWORD RESET
// ─────────────────────────────────────────────────────────────

const requestPasswordReset = asyncHandler(async (req, res) => {
  const { name, email, position } = req.body;

  await authService.requestPasswordReset({ name, email, position, req });

  // Always return success — don't reveal if email exists
  return ApiResponse.success(
    res,
    200,
    "If your details match our records, your request has been sent to HR for approval. You will receive an email once approved.",
  );
});

const approvePasswordReset = asyncHandler(async (req, res) => {
  const { targetUserId } = req.body;

  await authService.approvePasswordReset({
    targetUserId,
    approvedBy: req.adminUser.id,
    req,
  });

  return ApiResponse.success(
    res,
    200,
    "Password reset approved. Temporary password sent to user's email.",
  );
});

const rejectPasswordReset = asyncHandler(async (req, res) => {
  const { targetUserId, reason } = req.body;

  await authService.rejectPasswordReset({
    targetUserId,
    approvedBy: req.adminUser.id,
    reason,
    req,
  });

  return ApiResponse.success(res, 200, "Password reset request rejected.");
});

const getPendingResetRequests = asyncHandler(async (req, res) => {
  const requests = await authService.getPendingResetRequests();

  return ApiResponse.success(
    res,
    200,
    "Pending password reset requests",
    requests,
  );
});

module.exports = {
  login,
  googleCallback,
  refreshToken,
  logout,
  changePassword,
  getMe,
  requestPasswordReset,
  approvePasswordReset,
  rejectPasswordReset,
  getPendingResetRequests,
};