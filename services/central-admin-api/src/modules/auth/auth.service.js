const { prisma } = require("../../shared/config/database");
const {
  hashPassword,
  comparePassword,
} = require("../../shared/utils/password.util");
const { sessionService } = require("../../shared/auth");
const { mfaService } = require("./mfa.instance");
const { createAuditLog } = require("../../shared/middlewares/audit.middleware");
const { sendEmail } = require("../../shared/utils/email.util");
const ApiError = require("../../shared/utils/ApiError");
const crypto = require("crypto");
const notificationService = require("../notifications/notifications.service");

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 30;
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

    // Verified MFA users get a second step; no session exists until it passes.
    if (mfaService.isEnrolled(user)) {
      const challenge = await mfaService.createChallenge(user, { authMethod: "PASSWORD", ipAddress, userAgent });
      return { mfaRequired: true, ...challenge };
    }

    return this._startSession({ user, authMethod: "PASSWORD", ipAddress, userAgent, mfaVerified: false });
  }

  // Second login step (password or Google, then TOTP / recovery code).
  async completeMfaLogin({ challengeToken, code, recoveryCode, ipAddress, userAgent, req }) {
    const { user, authMethod } = await mfaService.completeChallenge({ challengeToken, code, recoveryCode, req });
    return this._startSession({ user, authMethod, ipAddress, userAgent, mfaVerified: true });
  }

  // Always mints a NEW server-side session (session-fixation safe).
  async _startSession({ user, authMethod, ipAddress, userAgent, mfaVerified }) {
    const created = await sessionService.createSession(user, { authMethod, ipAddress, userAgent, mfaVerified });

    await createAuditLog({
      adminUserId: user.id,
      action: "LOGIN",
      metadata: { ipAddress, method: authMethod, sessionId: created.session.id },
      req: { ip: ipAddress, headers: { "user-agent": userAgent } },
    });

    await notificationService.createNotification({
      adminUserId: user.id,
      icon: "bell",
      title: authMethod.startsWith("GOOGLE") ? "Google Login" : "New Login Detected",
      subtitle: authMethod.startsWith("GOOGLE")
        ? `You logged in using Google from IP: ${ipAddress || "Unknown location"}`
        : `You logged in from IP: ${ipAddress || "Unknown location"}`,
    });

    return {
      accessToken: created.accessToken,
      refreshToken: created.refreshToken,
      csrfToken: created.csrfToken,
      accessTtlSeconds: created.accessTtlSeconds,
      refreshTtlMs: created.refreshTtlMs,
      session: created.session,
      mustChangePassword: authMethod.startsWith("GOOGLE") ? false : user.mustChangePassword,
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
  // REFRESH TOKEN (rotation + reuse detection, see session.service)
  // ─────────────────────────────────────────────────────────────
  async refreshToken({ token, ipAddress, userAgent }) {
    const result = await sessionService.rotateRefresh(token, { ipAddress, userAgent });

    await createAuditLog({
      adminUserId: result.user.id,
      action: "TOKEN_REFRESHED",
      metadata: { sessionId: result.session.id },
      req: { ip: ipAddress, headers: { "user-agent": userAgent } },
    });

    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // LOGOUT
  // ─────────────────────────────────────────────────────────────
  async logout({ refreshToken, sessionId, req }) {
    let adminUserId = null;
    if (refreshToken) {
      const stored = await sessionService.revokeByRefreshToken(refreshToken, "LOGOUT");
      adminUserId = stored?.adminUserId || null;
    }
    if (sessionId) {
      await sessionService.revokeSession(sessionId, "LOGOUT");
    }
    if (adminUserId || sessionId) {
      await createAuditLog({ adminUserId, action: "LOGOUT", metadata: { sessionId: sessionId || null }, req });
    }
  }

  async logoutAll({ adminUserId, req }) {
    const count = await sessionService.revokeAllForUser(adminUserId, "LOGOUT_ALL");
    await createAuditLog({ adminUserId, action: "LOGOUT", metadata: { scope: "all", sessions: count }, req });
    return count;
  }

  async listSessions({ adminUserId, currentSessionId }) {
    const rows = await sessionService.listActive(adminUserId);
    return rows.map((row) => ({ ...row, current: row.id === currentSessionId }));
  }

  async revokeOwnSession({ adminUserId, sessionId, req }) {
    const sessions = await sessionService.listActive(adminUserId);
    if (!sessions.some((row) => row.id === sessionId)) throw new ApiError(404, "Session not found");
    await sessionService.revokeSession(sessionId, "USER_REVOKED", { actorId: adminUserId });
    await createAuditLog({ adminUserId, action: "SESSION_REVOKED", targetId: sessionId, targetType: "admin_session", req });
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

    await sessionService.revokeAllForUser(adminUserId, "PASSWORD_CHANGED");

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

    const fresh = await prisma.adminUser.findUnique({ where: { id: user.id } });
    if (mfaService.isEnrolled(fresh)) {
      const challenge = await mfaService.createChallenge(fresh, { authMethod: "GOOGLE", ipAddress, userAgent });
      return { mfaRequired: true, ...challenge };
    }

    return this._startSession({ user: fresh, authMethod: "GOOGLE", ipAddress, userAgent, mfaVerified: false });
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

    await sessionService.revokeAllForUser(user.id, "PASSWORD_RESET_APPROVED", { actorId: approvedBy });

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
