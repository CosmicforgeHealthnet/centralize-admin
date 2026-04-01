const { prisma } = require("../../shared/config/database");
const {
  hashPassword,
  comparePassword,
} = require("../../shared/utils/password.util");
const {
  generateAccessToken,
  generateRefreshToken,
} = require("../../shared/utils/jwt.util");
const { createAuditLog } = require("../../shared/middlewares/audit.middleware");
const ApiError = require("../../shared/utils/ApiError");
const crypto = require("crypto");

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 30;

// FIX #6: Single source of truth for refresh token TTL
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// FIX #3: Hash the refresh token before storing in DB.
// The plaintext token is returned to the client; only the hash lives in DB.
// A breach can't replay tokens without the originals.
const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

class AuthService {
  async login({ email, password, ipAddress, userAgent }) {
    const user = await prisma.adminUser.findUnique({ where: { email } });

    if (!user) {
      // Don't reveal whether email exists
      throw new ApiError(401, "Invalid email or password");
    }

    // Check if account is locked
    if (user.status === "LOCKED") {
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        const minutesLeft = Math.ceil((user.lockedUntil - new Date()) / 60000);
        throw new ApiError(
          423,
          `Account locked. Try again in ${minutesLeft} minutes`,
        );
      }

      // Lock expired — unlock account
      await prisma.adminUser.update({
        where: { id: user.id },
        data: { status: "ACTIVE", failedLoginAttempts: 0, lockedUntil: null },
      });

      // FIX #2 (partial): Re-fetch user so all subsequent checks use fresh status,
      // not the stale in-memory object that still has status: "LOCKED"
      const freshUser = await prisma.adminUser.findUnique({
        where: { id: user.id },
      });
      return this._authenticate({
        user: freshUser,
        password,
        ipAddress,
        userAgent,
      });
    }

    return this._authenticate({ user, password, ipAddress, userAgent });
  }

  async _authenticate({ user, password, ipAddress, userAgent }) {
    if (user.status === "INACTIVE") {
      throw new ApiError(
        403,
        "Account deactivated. Contact your administrator",
      );
    }

    // Verify password
    const isPasswordValid = await comparePassword(password, user.password);

    if (!isPasswordValid) {
      const newAttempts = user.failedLoginAttempts + 1;
      const updateData = { failedLoginAttempts: newAttempts };

      if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
        updateData.status = "LOCKED";
        updateData.lockedUntil = new Date(
          Date.now() + LOCK_DURATION_MINUTES * 60 * 1000,
        );
      }

      await prisma.adminUser.update({
        where: { id: user.id },
        data: updateData,
      });

      await createAuditLog({
        adminUserId: user.id,
        action:
          newAttempts >= MAX_LOGIN_ATTEMPTS ? "ACCOUNT_LOCKED" : "LOGIN_FAILED",
        metadata: { attempts: newAttempts, ipAddress },
        req: { ip: ipAddress, headers: { "user-agent": userAgent } },
      });

      if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
        throw new ApiError(
          423,
          `Account locked after ${MAX_LOGIN_ATTEMPTS} failed attempts`,
        );
      }

      throw new ApiError(
        401,
        `Invalid email or password. ${MAX_LOGIN_ATTEMPTS - newAttempts} attempts remaining`,
      );
    }

    // Reset failed attempts on successful login
    await prisma.adminUser.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lastLoginAt: new Date(),
        lastLoginIp: ipAddress,
        lockedUntil: null,
      },
    });

    // Generate tokens
    const accessToken = generateAccessToken({
      sub: user.id,
      email: user.email,
      tier: user.tier,
      name: user.name,
      isTeamLead: user.isTeamLead,
    });

    const refreshToken = generateRefreshToken();

    // FIX #3: Store hash, not the raw token
    await prisma.refreshToken.create({
      data: {
        token: hashToken(refreshToken),
        adminUserId: user.id,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS), // FIX #6
        ipAddress,
        userAgent,
      },
    });

    await createAuditLog({
      adminUserId: user.id,
      action: "LOGIN",
      metadata: { ipAddress },
      req: { ip: ipAddress, headers: { "user-agent": userAgent } },
    });

    return {
      accessToken,
      refreshToken, // plaintext — controller puts this in HttpOnly cookie
      mustChangePassword: user.mustChangePassword,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        tier: user.tier,
        department: user.department,
        isTeamLead: user.isTeamLead,
      },
    };
  }

  async refreshToken({ token, ipAddress, userAgent }) {
    // FIX #3: Look up by hash
    const stored = await prisma.refreshToken.findUnique({
      where: { token: hashToken(token) },
      include: { adminUser: true },
    });

    if (!stored || stored.isRevoked || stored.expiresAt < new Date()) {
      throw new ApiError(401, "Invalid or expired refresh token");
    }

    if (stored.adminUser.status !== "ACTIVE") {
      throw new ApiError(403, "Account is not active");
    }

    // Rotate — revoke old token
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { isRevoked: true },
    });

    const newAccessToken = generateAccessToken({
      sub: stored.adminUser.id,
      email: stored.adminUser.email,
      tier: stored.adminUser.tier,
      name: stored.adminUser.name,
      isTeamLead: stored.adminUser.isTeamLead,
    });

    const newRefreshToken = generateRefreshToken();

    // FIX #3: Store hash of new token too
    await prisma.refreshToken.create({
      data: {
        token: hashToken(newRefreshToken),
        adminUserId: stored.adminUser.id,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS), // FIX #6
        ipAddress,
        userAgent,
      },
    });

    await createAuditLog({
      adminUserId: stored.adminUser.id,
      action: "TOKEN_REFRESHED",
      req: { ip: ipAddress, headers: { "user-agent": userAgent } },
    });

    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
  }

  // auth.service.js
  async logout({ refreshToken, req }) {
    if (refreshToken) {
      const stored = await prisma.refreshToken.findUnique({
        where: { token: hashToken(refreshToken) },
      });

      if (stored) {
        await prisma.refreshToken.update({
          where: { id: stored.id },
          data: { isRevoked: true },
        });

        await createAuditLog({
          adminUserId: stored.adminUserId,
          action: "LOGOUT",
          req,
        });
      }
    }
  }
  async changePassword({ adminUserId, currentPassword, newPassword, req }) {
    const user = await prisma.adminUser.findUnique({
      where: { id: adminUserId },
    });
    if (!user) throw new ApiError(404, "User not found");

    const isValid = await comparePassword(currentPassword, user.password);
    if (!isValid) throw new ApiError(401, "Current password is incorrect");

    const isSame = await comparePassword(newPassword, user.password);
    if (isSame)
      throw new ApiError(
        400,
        "New password must be different from current password",
      );

    const hashed = await hashPassword(newPassword);

    // FIX #2: Store passwordChangedAt so auth middleware can invalidate
    // access tokens that were issued before this moment
    await prisma.adminUser.update({
      where: { id: adminUserId },
      data: {
        password: hashed,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
      },
    });

    // Revoke all refresh tokens on password change
    await prisma.refreshToken.updateMany({
      where: { adminUserId },
      data: { isRevoked: true },
    });

    // FIX #9: Pass explicit ipAddress for consistent audit log IP capture
    await createAuditLog({
      adminUserId,
      action: "PASSWORD_CHANGED",
      metadata: { ipAddress: req.ip },
      req,
    });
  }
  async googleLogin({ user, ipAddress, userAgent }) {
    // Reset failed attempts and update last login
    await prisma.adminUser.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lastLoginAt: new Date(),
        lastLoginIp: ipAddress,
        lockedUntil: null,
      },
    });

    // Generate tokens
    const accessToken = generateAccessToken({
      sub: user.id,
      email: user.email,
      tier: user.tier,
      name: user.name,
      isTeamLead: user.isTeamLead,
    });

    const refreshToken = generateRefreshToken();

    await prisma.refreshToken.create({
      data: {
        token: hashToken(refreshToken),
        adminUserId: user.id,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        ipAddress,
        userAgent,
      },
    });

    await createAuditLog({
      adminUserId: user.id,
      action: "LOGIN",
      metadata: { ipAddress, method: "GOOGLE" },
      req: { ip: ipAddress, headers: { "user-agent": userAgent } },
    });

    return {
      accessToken,
      refreshToken,
      mustChangePassword: false, // Google login skips mustChangePassword
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        tier: user.tier,
        department: user.department,
        isTeamLead: user.isTeamLead,
      },
    };
  }
}

module.exports = new AuthService();
