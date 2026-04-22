const { prisma } = require("../../shared/config/database");
const { mainPrisma } = require("../../shared/config/mainDatabase");
const { hashPassword } = require("../../shared/utils/password.util");
const { createAuditLog } = require("../../shared/middlewares/audit.middleware");
const ApiError = require("../../shared/utils/ApiError");

// Fields we never return to the client
const SAFE_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  position: true,
  department: true,
  tier: true,
  status: true,
  isTeamLead: true,
  mustChangePassword: true,
  lastLoginAt: true,
  lastLoginIp: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  mainAppUserId: true,
};

class AdminUsersService {
  async getAllUsers({ page = 1, limit = 20, tier, department, status }) {
    const where = {};
    if (tier) where.tier = tier;
    if (department) where.department = department;
    if (status) where.status = status;

    const skip = (page - 1) * limit;
    const total = await prisma.adminUser.count({ where });
    const users = await prisma.adminUser.findMany({
      where,
      select: SAFE_USER_SELECT,
      orderBy: { createdAt: "desc" },
      skip,
      take: Number(limit),
    });

    return {
      users,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: Number(limit),
      },
    };
  }

  async getUserById(id) {
    const user = await prisma.adminUser.findUnique({
      where: { id },
      select: SAFE_USER_SELECT,
    });
    if (!user) throw new ApiError(404, "User not found");
    return user;
  }

  async createUser({ data, createdBy, req }) {
    // Check email not already taken in admin DB
    const existing = await prisma.adminUser.findUnique({
      where: { email: data.email },
    });
    if (existing)
      throw new ApiError(409, "A user with this email already exists");

    // Only SUPER can create SUPER or EXECUTIVE accounts
    if (["SUPER", "EXECUTIVE"].includes(data.tier)) {
      const creator = await prisma.adminUser.findUnique({
        where: { id: createdBy },
      });
      if (creator?.tier !== "SUPER") {
        throw new ApiError(
          403,
          "Only Super accounts can create Super or Executive accounts",
        );
      }
    }

    const hashed = await hashPassword(data.password);

    // 👇 If CUSTOMER_CARE, create a matching user in the main app DB
    let mainAppUserId = null;
    if (data.department === "CUSTOMER_CARE") {
      // Check if email already exists in main app DB
      const existingMainUser = await mainPrisma.users.findUnique({
        where: { email: data.email },
      });

      if (existingMainUser) {
        // Reuse existing main app user
        mainAppUserId = existingMainUser.id;
      } else {
        // Create new user in main app DB
        const mainAppUser = await mainPrisma.users.create({
          data: {
            fullName: data.name,
            email: data.email,
            role: "admin",
            status: "active",
          },
        });
        mainAppUserId = mainAppUser.id;
      }
    }

    // Create admin user in your own DB
    const user = await prisma.adminUser.create({
      data: {
        ...data,
        password: hashed,
        mustChangePassword: true,
        status: "PENDING",
        createdBy,
        mainAppUserId, // 👈 save the link
      },
      select: SAFE_USER_SELECT,
    });

    await createAuditLog({
      adminUserId: createdBy,
      action: "USER_CREATED",
      targetId: user.id,
      targetType: "admin_user",
      metadata: {
        email: user.email,
        tier: user.tier,
        department: user.department,
      },
      req,
    });

    return user;
  }

  async updateUser({ id, data, updatedBy, req }) {
    const user = await prisma.adminUser.findUnique({ where: { id } });
    if (!user) throw new ApiError(404, "User not found");

    // Prevent modifying SUPER accounts unless you are SUPER
    if (user.tier === "SUPER") {
      const modifier = await prisma.adminUser.findUnique({
        where: { id: updatedBy },
      });
      if (modifier?.tier !== "SUPER") {
        throw new ApiError(
          403,
          "Only Super accounts can modify other Super accounts",
        );
      }
    }

    const updated = await prisma.adminUser.update({
      where: { id },
      data,
      select: SAFE_USER_SELECT,
    });

    await createAuditLog({
      adminUserId: updatedBy,
      action: "USER_UPDATED",
      targetId: id,
      targetType: "admin_user",
      metadata: { changes: data },
      req,
    });

    return updated;
  }

  async deactivateUser({ id, deactivatedBy, req }) {
    const user = await prisma.adminUser.findUnique({ where: { id } });
    if (!user) throw new ApiError(404, "User not found");
    if (id === deactivatedBy)
      throw new ApiError(400, "You cannot deactivate your own account");
    if (user.tier === "SUPER")
      throw new ApiError(403, "Super accounts cannot be deactivated");

    // Immediately revoke all tokens
    await prisma.refreshToken.updateMany({
      where: { adminUserId: id },
      data: { isRevoked: true },
    });

    await prisma.adminUser.update({
      where: { id },
      data: { status: "INACTIVE" },
    });

    await createAuditLog({
      adminUserId: deactivatedBy,
      action: "USER_DEACTIVATED",
      targetId: id,
      targetType: "admin_user",
      req,
    });
  }

  async activateUser({ id, activatedBy, req }) {
    const user = await prisma.adminUser.findUnique({ where: { id } });
    if (!user) throw new ApiError(404, "User not found");

    await prisma.adminUser.update({
      where: { id },
      data: { status: "ACTIVE", failedLoginAttempts: 0, lockedUntil: null },
    });

    await createAuditLog({
      adminUserId: activatedBy,
      action: "USER_ACTIVATED",
      targetId: id,
      targetType: "admin_user",
      req,
    });
  }

  async resetUserPassword({ id, newPassword, resetBy, req }) {
    const user = await prisma.adminUser.findUnique({ where: { id } });
    if (!user) throw new ApiError(404, "User not found");

    // Prevent resetting SUPER passwords unless you are SUPER
    if (user.tier === "SUPER") {
      const resetter = await prisma.adminUser.findUnique({
        where: { id: resetBy },
      });
      if (resetter?.tier !== "SUPER") {
        throw new ApiError(
          403,
          "Only Super accounts can reset Super account passwords",
        );
      }
    }

    const hashed = await hashPassword(newPassword);

    await prisma.adminUser.update({
      where: { id },
      data: {
        password: hashed,
        mustChangePassword: true, // Force them to change on next login
        failedLoginAttempts: 0,
        status: user.status === "LOCKED" ? "ACTIVE" : user.status,
        lockedUntil: null,
      },
    });

    // Revoke all their refresh tokens
    await prisma.refreshToken.updateMany({
      where: { adminUserId: id },
      data: { isRevoked: true },
    });

    await createAuditLog({
      adminUserId: resetBy,
      action: "PASSWORD_RESET_COMPLETED",
      targetId: id,
      targetType: "admin_user",
      req,
    });
  }

  async getAuditLogs({ page = 1, limit = 50, adminUserId, action }) {
    const where = {};
    if (adminUserId) where.adminUserId = adminUserId;
    if (action) where.action = action;

    const skip = (page - 1) * limit;
    const total = await prisma.auditLog.count({ where });
    const logs = await prisma.auditLog.findMany({
      where,
      include: {
        adminUser: {
          select: { id: true, name: true, email: true, tier: true },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: Number(limit),
    });

    return {
      logs,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: Number(limit),
      },
    };
  }
}

module.exports = new AdminUsersService();
