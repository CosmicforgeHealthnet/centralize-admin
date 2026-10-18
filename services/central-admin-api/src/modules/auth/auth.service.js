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
const { sendEmail } = require("../../shared/utils/email.util");
const ApiError = require("../../shared/utils/ApiError");
const crypto = require("crypto");
const notificationService = require("../notifications/notifications.service");

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 30;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

class AuthService {
  // ─────────────────────────────────────────────────────────────
  // LOGIN
  // ─────────────────────────────────────────────────────────────
  async login({ email, password, ipAddress, userAgent }) {
    const user = await prisma.adminUser.findUnique({ where: { email } });

    if (!user) {
      throw new ApiError(401, "Invalid email or password");
    }

    if (user.status === "LOCKED") {
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        const minutesLeft = Math.ceil((user.lockedUntil - new Date()) / 60000);
        throw new ApiError(
          423,
          `Account locked. Try again in ${minutesLeft} minutes`,
        );
      }

      await prisma.adminUser.update({
        where: { id: user.id },
        data: { status: "ACTIVE", failedLoginAttempts: 0, lockedUntil: null },
      });

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

    const isPasswordValid = await comparePassword(password, user.password);

    if (!isPasswordValid) {
      const newAttempts = user.failedLoginAttempts + 1;
      const updateData = { failedLoginAttempts: newAttempts };

      if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
        updateData.status = "LOCKED";
        updateData.lockedUntil = new Date(
          Date.now() + LOCK_DURATION_MINUTES * 60 * 1000,
        );

        await notificationService.createNotification({
          adminUserId: user.id,
          icon: "alert",
          title: "Account Locked",
          subtitle: `Your account has been locked due to ${MAX_LOGIN_ATTEMPTS} failed login attempts. Please try again in ${LOCK_DURATION_MINUTES} minutes.`,
        });
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

    await prisma.adminUser.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lastLoginAt: new Date(),
        lastLoginIp: ipAddress,
        lockedUntil: null,
      },
    });

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
      metadata: { ipAddress },
      req: { ip: ipAddress, headers: { "user-agent": userAgent } },
    });

    await notificationService.createNotification({
      adminUserId: user.id,
      icon: "bell",
      title: "New Login Detected",
      subtitle: `You logged in from IP: ${ipAddress || "Unknown location"}`,
    });

    return {
      accessToken,
      refreshToken,
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

  // ─────────────────────────────────────────────────────────────
  // REFRESH TOKEN
  // ─────────────────────────────────────────────────────────────
  async refreshToken({ token, ipAddress, userAgent }) {
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

    await prisma.refreshToken.create({
      data: {
        token: hashToken(newRefreshToken),
        adminUserId: stored.adminUser.id,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
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

  // ─────────────────────────────────────────────────────────────
  // LOGOUT
  // ─────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────
  // CHANGE PASSWORD - ✅ UPDATED
  // ─────────────────────────────────────────────────────────────
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

    await prisma.adminUser.update({
      where: { id: adminUserId },
      data: {
        password: hashed,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        // ✅ FIX: Activate user if they were PENDING
        status: user.status === "PENDING" ? "ACTIVE" : user.status,
      },
    });

    await prisma.refreshToken.updateMany({
      where: { adminUserId },
      data: { isRevoked: true },
    });

    await createAuditLog({
      adminUserId,
      action: "PASSWORD_CHANGED",
      metadata: { ipAddress: req.ip },
      req,
    });

    await notificationService.createNotification({
      adminUserId,
      icon: "check",
      title: "Password Changed",
      subtitle:
        "Your password was successfully changed. If this wasn't you, contact support immediately.",
    });
  }

  // ─────────────────────────────────────────────────────────────
  // GOOGLE LOGIN
  // ─────────────────────────────────────────────────────────────
  async googleLogin({ user, ipAddress, userAgent }) {
    await prisma.adminUser.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lastLoginAt: new Date(),
        lastLoginIp: ipAddress,
        lockedUntil: null,
      },
    });

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

    await notificationService.createNotification({
      adminUserId: user.id,
      icon: "bell",
      title: "Google Login",
      subtitle: `You logged in using Google from IP: ${ipAddress || "Unknown location"}`,
    });

    return {
      accessToken,
      refreshToken,
      mustChangePassword: false,
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

  // ─────────────────────────────────────────────────────────────
  // REQUEST PASSWORD RESET (employee submits)
  // ─────────────────────────────────────────────────────────────
  async requestPasswordReset({ name, email, position, req }) {
    const user = await prisma.adminUser.findUnique({ where: { email } });

    // Don't reveal whether email exists
    if (!user) return;

    if (user.name.toLowerCase() !== name.toLowerCase()) {
      throw new ApiError(
        400,
        "The details you provided do not match our records",
      );
    }

    if (position && user.position?.toLowerCase() !== position.toLowerCase()) {
      throw new ApiError(
        400,
        "The details you provided do not match our records",
      );
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = hashToken(rawToken);

    await prisma.adminUser.update({
      where: { id: user.id },
      data: {
        passwordResetToken: hashedToken,
        passwordResetExpires: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    });

    // Notify all HR Admins (MANAGEMENT dept, ADMIN tier, team lead)
    const hrAdmins = await prisma.adminUser.findMany({
      where: {
        department: "MANAGEMENT",
        tier: "ADMIN",
        isTeamLead: true,
        status: "ACTIVE",
      },
    });

    await Promise.all(
      hrAdmins.map((admin) =>
        notificationService.createNotification({
          adminUserId: admin.id,
          icon: "alert",
          title: "Password Reset Request",
          subtitle: `${user.name} (${user.position || "Staff"}) has requested a password reset. Review and approve in the admin panel.`,
        }),
      ),
    );

    await createAuditLog({
      adminUserId: user.id,
      action: "PASSWORD_RESET_REQUESTED",
      metadata: { email: user.email, position: user.position },
      req,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // APPROVE PASSWORD RESET (HR Admin approves)
  // ─────────────────────────────────────────────────────────────
  async approvePasswordReset({ targetUserId, approvedBy, req }) {
    const approver = await prisma.adminUser.findUnique({
      where: { id: approvedBy },
    });

    if (
      !approver ||
      approver.department !== "MANAGEMENT" ||
      approver.tier !== "ADMIN" ||
      !approver.isTeamLead
    ) {
      throw new ApiError(403, "Only HR Admins can approve password resets");
    }

    const user = await prisma.adminUser.findUnique({
      where: { id: targetUserId },
    });

    if (!user) throw new ApiError(404, "User not found");

    if (!user.passwordResetToken || !user.passwordResetExpires) {
      throw new ApiError(
        400,
        "No pending password reset request for this user",
      );
    }

    if (user.passwordResetExpires < new Date()) {
      throw new ApiError(
        400,
        "Password reset request has expired. User must submit a new request.",
      );
    }

    const tempPassword = this._generateTempPassword();
    const hashed = await hashPassword(tempPassword);

    await prisma.adminUser.update({
      where: { id: user.id },
      data: {
        password: hashed,
        mustChangePassword: true,
        failedLoginAttempts: 0,
        status: user.status === "LOCKED" ? "ACTIVE" : user.status,
        lockedUntil: null,
        passwordResetToken: null,
        passwordResetExpires: null,
        passwordChangedAt: new Date(),
      },
    });

    await prisma.refreshToken.updateMany({
      where: { adminUserId: user.id },
      data: { isRevoked: true },
    });

    await sendEmail({
      to: user.email,
      subject: "Your Temporary Password — Cosmicforge Admin",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Password Reset Approved</h2>
          <p>Hi ${user.name},</p>
          <p>Your password reset request has been approved by HR. Here is your temporary password:</p>
          <div style="background: #f4f4f4; padding: 16px; border-radius: 8px; margin: 24px 0;">
            <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px; margin: 0; text-align: center;">
              ${tempPassword}
            </p>
          </div>
          <p><strong>Important:</strong> You will be required to change this password immediately after logging in.</p>
          <p>If you did not request this reset, please contact your administrator immediately.</p>
          <br/>
          <p style="color: #999; font-size: 12px;">Cosmicforge Centralized Admin</p>
        </div>
      `,
    });

    await notificationService.createNotification({
      adminUserId: user.id,
      icon: "check",
      title: "Password Reset Approved",
      subtitle:
        "Your password reset request has been approved. Check your email for your temporary password.",
    });

    await createAuditLog({
      adminUserId: approvedBy,
      action: "PASSWORD_RESET_COMPLETED",
      targetId: user.id,
      targetType: "admin_user",
      metadata: { approvedBy: approver.name, userEmail: user.email },
      req,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // REJECT PASSWORD RESET (HR Admin rejects)
  // ─────────────────────────────────────────────────────────────
  async rejectPasswordReset({ targetUserId, approvedBy, reason, req }) {
    const approver = await prisma.adminUser.findUnique({
      where: { id: approvedBy },
    });

    if (
      !approver ||
      approver.department !== "MANAGEMENT" ||
      approver.tier !== "ADMIN" ||
      !approver.isTeamLead
    ) {
      throw new ApiError(403, "Only HR Admins can reject password resets");
    }

    const user = await prisma.adminUser.findUnique({
      where: { id: targetUserId },
    });

    if (!user) throw new ApiError(404, "User not found");

    await prisma.adminUser.update({
      where: { id: user.id },
      data: {
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });

    await notificationService.createNotification({
      adminUserId: user.id,
      icon: "xcircle",
      title: "Password Reset Rejected",
      subtitle: reason
        ? `Your password reset request was rejected. Reason: ${reason}`
        : "Your password reset request was rejected. Please contact HR for assistance.",
    });

    await createAuditLog({
      adminUserId: approvedBy,
      action: "PASSWORD_RESET_COMPLETED",
      targetId: user.id,
      targetType: "admin_user",
      metadata: { action: "REJECTED", reason, userEmail: user.email },
      req,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // GET PENDING RESET REQUESTS (HR Admin panel)
  // ─────────────────────────────────────────────────────────────
  async getPendingResetRequests() {
    return prisma.adminUser.findMany({
      where: {
        passwordResetToken: { not: null },
        passwordResetExpires: { gt: new Date() },
      },
      select: {
        id: true,
        name: true,
        email: true,
        position: true,
        department: true,
        tier: true,
        passwordResetExpires: true,
      },
      orderBy: { passwordResetExpires: "asc" },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // HELPER: generate temp password
  // ─────────────────────────────────────────────────────────────
  _generateTempPassword() {
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lower = "abcdefghijklmnopqrstuvwxyz";
    const digits = "0123456789";
    const special = "!@#$%";
    const all = upper + lower + digits + special;

    let password =
      upper[Math.floor(Math.random() * upper.length)] +
      lower[Math.floor(Math.random() * lower.length)] +
      digits[Math.floor(Math.random() * digits.length)] +
      special[Math.floor(Math.random() * special.length)];

    for (let i = 0; i < 6; i++) {
      password += all[Math.floor(Math.random() * all.length)];
    }

    return password
      .split("")
      .sort(() => Math.random() - 0.5)
      .join("");
  }
}

module.exports = new AuthService();
