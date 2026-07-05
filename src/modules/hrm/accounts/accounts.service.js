const { prisma } = require("../../../shared/config/database");
const ApiError = require("../../../shared/utils/ApiError");
const logger = require("../../../shared/utils/logger");
const { generateTempPassword, hashPassword } = require("../../../shared/utils/password.util");
const { sendEmail } = require("../../../shared/utils/email.util");
const { createAuditLog } = require("../../../shared/middlewares/audit.middleware");
const {
  assertUuid,
  buildMeta,
  isSensitiveTier,
  normalizeDepartment,
  normalizeTier,
  paginate,
  pickDefined,
} = require("../hrm.utils");

const ACCOUNT_SELECT = {
  id: true,
  name: true,
  email: true,
  position: true,
  department: true,
  tier: true,
  status: true,
  isTeamLead: true,
  avatarUrl: true,
  workPhone: true,
  personalPhone: true,
  createdAt: true,
  employmentType: true,
  employmentCategory: true,
  location: true,
};

const ACCOUNT_UPDATE_FIELDS = [
  "name",
  "email",
  "position",
  "department",
  "tier",
  "status",
  "isTeamLead",
  "employmentType",
  "employmentCategory",
  "location",
];

function mapAccountListItem(user) {
  return {
    id: user.id,
    employeeCode: null,
    name: user.name,
    email: user.email,
    employmentType: user.employmentType,
    employmentCategory: user.employmentCategory,
    department: user.department,
    designation: user.position,
    tier: user.tier,
    status: user.status,
    avatarUrl: user.avatarUrl,
  };
}

function mapAccountDetail(user) {
  return {
    id: user.id,
    employeeCode: null,
    name: user.name,
    email: user.email,
    phone: user.personalPhone || user.workPhone || null,
    employmentDate: user.createdAt,
    position: user.position,
    jobTitle: user.position,
    designation: user.position,
    department: user.department,
    location: user.location,
    headOfDepartment: null,
    employmentType: user.employmentType,
    employmentCategory: user.employmentCategory,
    tier: user.tier,
    status: user.status,
  };
}

function buildAccountWhere(query = {}) {
  const where = {};
  const department = normalizeDepartment(query.department);
  const tier = normalizeTier(query.tier);

  if (department) where.department = department;
  if (tier) where.tier = tier;

  const search = String(query.search || "").trim();
  if (!search) return where;

  const filterBy = String(query.filterBy || "").trim().toLowerCase();
  const contains = { contains: search, mode: "insensitive" };

  if (filterBy === "department") {
    where.department = normalizeDepartment(search);
  } else if (filterBy === "tier") {
    where.tier = normalizeTier(search);
  } else if (filterBy === "status") {
    where.status = search.toUpperCase();
  } else if (filterBy === "designation" || filterBy === "position") {
    where.position = contains;
  } else {
    where.OR = [{ name: contains }, { email: contains }, { position: contains }];
  }

  return where;
}

async function sendInviteEmail({ user, tempPassword }) {
  await sendEmail({
    to: user.email,
    subject: "Your HealthNet Admin account invitation",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2>HealthNet Admin Invitation</h2>
        <p>Hello ${user.name},</p>
        <p>Your admin account has been created.</p>
        <p><strong>Email:</strong> ${user.email}</p>
        <p><strong>Temporary password:</strong> ${tempPassword}</p>
        <p>Please sign in and change your password immediately.</p>
      </div>
    `,
  });
}

class AccountsService {
  async listAccounts(query = {}) {
    const { page, limit, skip } = paginate(query, 10, 100);
    const where = buildAccountWhere(query);

    const [total, users] = await Promise.all([
      prisma.adminUser.count({ where }),
      prisma.adminUser.findMany({
        where,
        select: ACCOUNT_SELECT,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      accounts: users.map(mapAccountListItem),
      meta: buildMeta(total, page, limit),
    };
  }

  async getAccount(id) {
    const accountId = assertUuid(id, "account id");
    const user = await prisma.adminUser.findUnique({
      where: { id: accountId },
      select: ACCOUNT_SELECT,
    });

    if (!user) throw new ApiError(404, "Account not found");
    return mapAccountDetail(user);
  }

  async createAccount({ data, actor, req }) {
    if (["SUPER", "EXECUTIVE"].includes(data.tier) && actor.tier !== "SUPER") {
      throw new ApiError(
        403,
        "Only Super accounts can create Super or Executive accounts",
      );
    }

    if (actor.tier === "ADMIN") {
      if (!actor.department) {
        throw new ApiError(
          403,
          "Your account has no department assigned. Contact a Super admin.",
        );
      }
      if (data.department !== actor.department) {
        throw new ApiError(
          403,
          "You can only create accounts within your own department",
        );
      }
    }

    const existing = await prisma.adminUser.findUnique({
      where: { email: data.email },
    });
    if (existing)
      throw new ApiError(409, "A user with this email already exists");

    const tempPassword = generateTempPassword();
    const password = await hashPassword(tempPassword);

    const created = await prisma.adminUser.create({
      data: {
        ...data,
        password,
        mustChangePassword: true,
        status: "PENDING",
        createdBy: actor.id,
      },
      select: ACCOUNT_SELECT,
    });

    try {
      await sendInviteEmail({ user: created, tempPassword });
    } catch (error) {
      logger.warn(
        `HRM account invite email failed for ${created.email}: ${error.message}`,
      );
    }

    await createAuditLog({
      adminUserId: actor.id,
      action: "USER_CREATED",
      targetId: created.id,
      targetType: "admin_user",
      metadata: {
        email: created.email,
        tier: created.tier,
        department: created.department,
      },
      req,
    });

    return mapAccountDetail(created);
  }

  async updateAccount({ id, data, actor, req }) {
    const accountId = assertUuid(id, "account id");
    const existing = await prisma.adminUser.findUnique({
      where: { id: accountId },
    });
    if (!existing) throw new ApiError(404, "Account not found");

    if (existing.tier === "SUPER" && actor.tier !== "SUPER") {
      throw new ApiError(403, "Only Super accounts can update Super accounts");
    }

    if (
      data.tier &&
      ["SUPER", "EXECUTIVE"].includes(data.tier) &&
      actor.tier !== "SUPER"
    ) {
      throw new ApiError(
        403,
        "Only Super accounts can assign Super or Executive tiers",
      );
    }

    const update = pickDefined(data, ACCOUNT_UPDATE_FIELDS);
    if (!isSensitiveTier(actor)) {
      delete update.tier;
      delete update.status;
    }

    const updated = await prisma.adminUser.update({
      where: { id: accountId },
      data: update,
      select: ACCOUNT_SELECT,
    });

    await createAuditLog({
      adminUserId: actor.id,
      action: "USER_UPDATED",
      targetId: accountId,
      targetType: "admin_user",
      metadata: { changes: update },
      req,
    });

    return mapAccountDetail(updated);
  }

  async deleteAccount({ id, actor, req }) {
    const accountId = assertUuid(id, "account id");
    if (accountId === actor.id)
      throw new ApiError(400, "You cannot delete your own account");

    const existing = await prisma.adminUser.findUnique({
      where: { id: accountId },
    });
    if (!existing) throw new ApiError(404, "Account not found");

    await prisma.$transaction(async (tx) => {
      await tx.task.deleteMany({
        where: { OR: [{ assigneeId: accountId }, { assignerId: accountId }] },
      });
      await tx.projectMember.deleteMany({ where: { adminUserId: accountId } });
      await tx.teamMember.deleteMany({ where: { adminUserId: accountId } });
      await tx.notification.deleteMany({ where: { adminUserId: accountId } });
      await tx.refreshToken.deleteMany({ where: { adminUserId: accountId } });
      await tx.adminUser.delete({ where: { id: accountId } });
    });

    await createAuditLog({
      adminUserId: actor.id,
      action: "USER_DELETED",
      targetId: accountId,
      targetType: "admin_user",
      metadata: { email: existing.email },
      req,
    });
  }

  async updateStatus({ id, status, reassignTo, actor, req }) {
    const accountId = assertUuid(id, "account id");
    if (accountId === actor.id && status === "INACTIVE") {
      throw new ApiError(400, "You cannot deactivate your own account");
    }

    const existing = await prisma.adminUser.findUnique({
      where: { id: accountId },
    });
    if (!existing) throw new ApiError(404, "Account not found");
    if (existing.tier === "SUPER" && actor.tier !== "SUPER") {
      throw new ApiError(
        403,
        "Only Super accounts can change Super account status",
      );
    }

    const newOwnerId = reassignTo || actor.id;

    const updated = await prisma.$transaction(async (tx) => {
      if (status === "INACTIVE") {
        await tx.refreshToken.updateMany({
          where: { adminUserId: accountId },
          data: { isRevoked: true },
        });

        await tx.team.updateMany({
          where: { createdBy: accountId },
          data: { createdBy: newOwnerId },
        });

        await tx.project.updateMany({
          where: { createdBy: accountId },
          data: { createdBy: newOwnerId },
        });

        await tx.leaveRequest.updateMany({
          where: { reviewedById: accountId, status: "PENDING" },
          data: { reviewedById: newOwnerId },
        });
      }

      return tx.adminUser.update({
        where: { id: accountId },
        data: { status, failedLoginAttempts: 0, lockedUntil: null },
        select: ACCOUNT_SELECT,
      });
    });

    await createAuditLog({
      adminUserId: actor.id,
      action: status === "ACTIVE" ? "USER_ACTIVATED" : "USER_DEACTIVATED",
      targetId: accountId,
      targetType: "admin_user",
      metadata: {
        previousStatus: existing.status,
        status,
        reassignedTo: status === "INACTIVE" ? newOwnerId : undefined,
      },
      req,
    });

    return mapAccountDetail(updated);
  }

  async resendInvite({ id, actor, req }) {
    const accountId = assertUuid(id, "account id");
    const user = await prisma.adminUser.findUnique({
      where: { id: accountId },
      select: ACCOUNT_SELECT,
    });
    if (!user) throw new ApiError(404, "Account not found");

    const tempPassword = generateTempPassword();
    const password = await hashPassword(tempPassword);

    await prisma.adminUser.update({
      where: { id: accountId },
      data: {
        password,
        mustChangePassword: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    try {
      await sendInviteEmail({ user, tempPassword });
    } catch (error) {
      logger.warn(
        `HRM invite resend email failed for ${user.email}: ${error.message}`,
      );
    }

    await createAuditLog({
      adminUserId: actor.id,
      action: "PASSWORD_RESET_COMPLETED",
      targetId: accountId,
      targetType: "admin_user",
      metadata: { reason: "hrm_invite_resend" },
      req,
    });
  }
}

module.exports = new AccountsService();
