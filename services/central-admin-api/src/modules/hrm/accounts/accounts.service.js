const { prisma } = require("../../../shared/config/database");
const ApiError = require("../../../shared/utils/ApiError");
const logger = require("../../../shared/utils/logger");
const { hashPassword } = require("../../../shared/utils/password.util");
const { sendAccountSetupEmail } = require("../../../shared/utils/email.util");
const { unusablePassword } = require("../../../shared/auth/account-setup.service");
const {
  createAuditLog,
} = require("../../../shared/middlewares/audit.middleware");
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
  homePhone: true,
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
  "workPhone",
  "homePhone",
  "personalPhone",
];

const GRANT_SELECT = {
  id: true,
  module: true,
  section: true,
  mode: true,
  grantedBy: true,
  reason: true,
  expiresAt: true,
  createdAt: true,
  revokedAt: true,
};

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
    workPhone: user.workPhone,
    homePhone: user.homePhone,
    personalPhone: user.personalPhone,
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

  const filterBy = String(query.filterBy || "")
    .trim()
    .toLowerCase();
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
    where.OR = [
      { name: contains },
      { email: contains },
      { position: contains },
    ];
  }

  return where;
}

// Security (spec section 3/5.4): invitations carry a signed-in-database,
// single-use, expiring setup link. No password is ever emailed. Returns SENT,
// PENDING_MIGRATION (link table not applied yet: nothing is sent) or
// EMAIL_FAILED.
async function sendInviteLink({ user, actor }) {
  const { accountSetup } = require("../../../shared/auth/account-setup");
  if (!(await accountSetup.isReady())) {
    logger.warn(`HRM invite link for ${user.id} not sent: account setup migration not applied`);
    return "PENDING_MIGRATION";
  }
  const link = await accountSetup.issue({ purpose: "ADMIN_INVITE", subjectId: user.id, email: user.email, createdBy: actor?.id || null });
  try {
    await sendAccountSetupEmail({ to: user.email, name: user.name, purpose: "ADMIN_INVITE", setupUrl: link.url, expiresAt: link.expiresAt });
    return "SENT";
  } catch (error) {
    logger.warn(`HRM account invite email failed for ${user.id}: ${error.message}`);
    return "EMAIL_FAILED";
  }
}

// ─── Mail offboarding on HR lifecycle changes ─────────────────────────────
// Mail is optional: the running app exposes its Mail application on
// app.locals.mail (tests may inject one). When Mail or its tables are absent
// the HR action still succeeds and the skip is logged. Reactivation never
// restores Mail access.
const MAIL_REVOKING_STATUSES = new Set(["INACTIVE", "LOCKED"]);
let mailApplicationOverride;

function resolveMailApplication(req) {
  if (mailApplicationOverride !== undefined) return mailApplicationOverride;
  return req?.app?.locals?.mail || null;
}

async function offboardMail({ accountId, actor, trigger, req }) {
  const mail = resolveMailApplication(req);
  const offboard = mail?.services?.admin?.offboardForAccountLifecycle;
  if (!offboard) {
    logger.info(`HRM ${trigger} ${accountId}: Mail not available, Mail offboarding skipped`);
    return { status: "SKIPPED_MAIL_UNAVAILABLE" };
  }
  try {
    if (mail.schema && !(await mail.schema.isReady())) {
      logger.warn(`HRM ${trigger} ${accountId}: Mail schema not ready, Mail offboarding skipped`);
      return { status: "SKIPPED_SCHEMA_NOT_READY" };
    }
    const context = { requestId: req?.correlationId || null, ipAddress: req?.ip || null, sessionId: req?.authSession?.id || null };
    const summary = await offboard(accountId, { actorAdminUserId: actor?.id || null, trigger }, context);
    return { status: "OFFBOARDED", ...summary };
  } catch (error) {
    logger.error(`HRM ${trigger} ${accountId}: Mail offboarding failed (${error?.code || "error"})`);
    return { status: "FAILED" };
  }
}

function isForeignKeyViolation(error) {
  return error?.code === "P2003" || error?.cause?.code === "P2003" || /foreign key constraint/i.test(String(error?.message || ""));
}

class AccountsService {
  // Test seam: inject a Mail application (or null for "Mail not available").
  setMailApplication(application) {
    mailApplicationOverride = application;
  }

  // ─── Account Methods ────────────────────────────────────────────────────

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

  async getAccountWithGrants(id) {
    const accountId = assertUuid(id, "account id");
    const user = await prisma.adminUser.findUnique({
      where: { id: accountId },
      select: {
        ...ACCOUNT_SELECT,
        sectionGrants: {
          where: { revokedAt: null },
          select: GRANT_SELECT,
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!user) throw new ApiError(404, "Account not found");
    const account = mapAccountDetail(user);
    account.sectionGrants = user.sectionGrants;
    return account;
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
    if (existing) {
      throw new ApiError(409, "A user with this email already exists");
    }

    // Unusable random password: the invitee chooses one through the link.
    const password = await hashPassword(unusablePassword());

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

    const inviteDelivery = await sendInviteLink({ user: created, actor });

    await createAuditLog({
      adminUserId: actor.id,
      action: "USER_CREATED",
      targetId: created.id,
      targetType: "admin_user",
      metadata: {
        email: created.email,
        tier: created.tier,
        department: created.department,
        inviteDelivery,
      },
      req,
    });

    return { ...mapAccountDetail(created), inviteDelivery };
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

    const mailOffboarding = update.status && MAIL_REVOKING_STATUSES.has(update.status)
      ? await offboardMail({ accountId, actor, trigger: `HR_ACCOUNT_${update.status}`, req })
      : undefined;

    await createAuditLog({
      adminUserId: actor.id,
      action: "USER_UPDATED",
      targetId: accountId,
      targetType: "admin_user",
      metadata: { changes: update, mailOffboarding: mailOffboarding?.status },
      req,
    });

    return mapAccountDetail(updated);
  }

  async deleteAccount({ id, actor, req }) {
    const accountId = assertUuid(id, "account id");
    if (accountId === actor.id) {
      throw new ApiError(400, "You cannot delete your own account");
    }

    const existing = await prisma.adminUser.findUnique({
      where: { id: accountId },
    });
    if (!existing) throw new ApiError(404, "Account not found");

    // A delete attempt revokes Mail access first; Mail history is retained
    // (Restrict foreign keys), so such an account cannot be deleted.
    const mailOffboarding = await offboardMail({ accountId, actor, trigger: "HR_ACCOUNT_DELETE_ATTEMPT", req });

    try {
      await prisma.$transaction(async (tx) => {
        // Delete all grants first
        await tx.adminSectionGrant.deleteMany({
          where: { adminUserId: accountId },
        });

        await tx.task.deleteMany({
          where: { OR: [{ assigneeId: accountId }, { assignerId: accountId }] },
        });
        await tx.projectMember.deleteMany({ where: { adminUserId: accountId } });
        await tx.teamMember.deleteMany({ where: { adminUserId: accountId } });
        await tx.notification.deleteMany({ where: { adminUserId: accountId } });
        await tx.refreshToken.deleteMany({ where: { adminUserId: accountId } });
        await tx.adminUser.delete({ where: { id: accountId } });
      });
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error;
      const message = mailOffboarding.status === "OFFBOARDED"
        ? "This account has retained records (such as CosmicForge Mail history) and cannot be deleted. Its Mail access has been revoked; deactivate the account instead."
        : "This account has retained records (such as CosmicForge Mail history) and cannot be deleted. Offboard the user from Mail and deactivate the account instead.";
      throw new ApiError(409, message, [{ reason: "RECORDS_RETAINED", mailOffboarding: mailOffboarding.status }]);
    }

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

    // Reactivation (ACTIVE) deliberately restores nothing in Mail.
    const mailOffboarding = MAIL_REVOKING_STATUSES.has(status)
      ? await offboardMail({ accountId, actor, trigger: `HR_ACCOUNT_${status}`, req })
      : undefined;

    await createAuditLog({
      adminUserId: actor.id,
      action: status === "ACTIVE" ? "USER_ACTIVATED" : "USER_DEACTIVATED",
      targetId: accountId,
      targetType: "admin_user",
      metadata: {
        previousStatus: existing.status,
        status,
        reassignedTo: status === "INACTIVE" ? newOwnerId : undefined,
        mailOffboarding: mailOffboarding?.status,
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

    // The previous link stops working; no password is generated or emailed.
    // An account that already set its password keeps it until the new link
    // is used.
    const inviteDelivery = await sendInviteLink({ user, actor });

    await createAuditLog({
      adminUserId: actor.id,
      action: "PASSWORD_RESET_COMPLETED",
      targetId: accountId,
      targetType: "admin_user",
      metadata: { reason: "hrm_invite_resend", inviteDelivery },
      req,
    });
    return { inviteDelivery };
  }

  // ─── Grant Methods ──────────────────────────────────────────────────────

  // The signed-in user's own active grants (drives navigation visibility).
  async getMyGrants(actor) {
    const now = new Date();
    const grants = await prisma.adminSectionGrant.findMany({
      where: { adminUserId: actor.id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { module: true, section: true, mode: true, expiresAt: true },
      orderBy: { createdAt: "asc" },
    });
    return { tier: actor.tier, grants };
  }

  async getUserGrants(userId) {
    const accountId = assertUuid(userId, "user id");

    const user = await prisma.adminUser.findUnique({
      where: { id: accountId },
      select: { id: true },
    });
    if (!user) throw new ApiError(404, "User not found");

    const grants = await prisma.adminSectionGrant.findMany({
      where: {
        adminUserId: accountId,
        revokedAt: null,
      },
      select: GRANT_SELECT,
      orderBy: { createdAt: "asc" },
    });

    return grants;
  }

  async addGrant({ userId, data, actor, req }) {
    const accountId = assertUuid(userId, "user id");

    // Check if user exists
    const user = await prisma.adminUser.findUnique({
      where: { id: accountId },
      select: { id: true },
    });
    if (!user) throw new ApiError(404, "User not found");

    // Check if grant already exists (not revoked)
    const existing = await prisma.adminSectionGrant.findFirst({
      where: {
        adminUserId: accountId,
        module: data.module,
        section: data.section,
        revokedAt: null,
      },
    });

    if (existing) {
      throw new ApiError(
        409,
        `Grant for ${data.module}/${data.section} already exists`,
      );
    }

    const grant = await prisma.adminSectionGrant.create({
      data: {
        adminUserId: accountId,
        module: data.module,
        section: data.section,
        mode: data.mode,
        reason: data.reason || `Granted by ${actor.id}`,
        grantedBy: actor.id,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      },
      select: GRANT_SELECT,
    });

    await createAuditLog({
      adminUserId: actor.id,
      action: "SECTION_GRANT_CREATED",
      targetId: accountId,
      targetType: "admin_user",
      metadata: {
        module: data.module,
        section: data.section,
        mode: data.mode,
        grantId: grant.id,
      },
      req,
    });

    return grant;
  }

  async syncGrants({ userId, grants, actor, req }) {
    const accountId = assertUuid(userId, "user id");

    // Check if user exists
    const user = await prisma.adminUser.findUnique({
      where: { id: accountId },
      select: { id: true },
    });
    if (!user) throw new ApiError(404, "User not found");

    // Use transaction to atomically replace all grants
    const result = await prisma.$transaction(async (tx) => {
      // Soft delete all existing grants (revoke them)
      await tx.adminSectionGrant.updateMany({
        where: {
          adminUserId: accountId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });

      // Create new grants if any
      if (grants.length > 0) {
        await tx.adminSectionGrant.createMany({
          data: grants.map((g) => ({
            adminUserId: accountId,
            module: g.module,
            section: g.section,
            mode: g.mode,
            reason: g.reason || `Synced by ${actor.id}`,
            grantedBy: actor.id,
            expiresAt: g.expiresAt ? new Date(g.expiresAt) : null,
          })),
        });
      }

      // Return the new grants
      return tx.adminSectionGrant.findMany({
        where: {
          adminUserId: accountId,
          revokedAt: null,
        },
        select: GRANT_SELECT,
        orderBy: { createdAt: "asc" },
      });
    });

    await createAuditLog({
      adminUserId: actor.id,
      action: "SECTION_GRANT_CREATED",
      targetId: accountId,
      targetType: "admin_user",
      metadata: {
        synced: true,
        grantCount: grants.length,
      },
      req,
    });

    return result;
  }

  async updateGrant({ grantId, data, actor, req }) {
    const id = assertUuid(grantId, "grant id");

    const grant = await prisma.adminSectionGrant.findUnique({
      where: { id },
    });
    if (!grant) throw new ApiError(404, "Grant not found");

    if (grant.revokedAt) {
      throw new ApiError(400, "Cannot update a revoked grant");
    }

    const update = pickDefined(data, ["mode", "reason", "expiresAt"]);
    if (update.expiresAt !== undefined) {
      update.expiresAt = update.expiresAt ? new Date(update.expiresAt) : null;
    }

    const updated = await prisma.adminSectionGrant.update({
      where: { id },
      data: update,
      select: GRANT_SELECT,
    });

    await createAuditLog({
      adminUserId: actor.id,
      action: "SECTION_GRANT_CREATED",
      targetId: grant.adminUserId,
      targetType: "admin_user",
      metadata: {
        updated: true,
        grantId: id,
        changes: update,
      },
      req,
    });

    return updated;
  }

  async removeGrant({ grantId, actor, req }) {
    const id = assertUuid(grantId, "grant id");

    const grant = await prisma.adminSectionGrant.findUnique({
      where: { id },
    });
    if (!grant) throw new ApiError(404, "Grant not found");

    if (grant.revokedAt) {
      throw new ApiError(400, "Grant already revoked");
    }

    await prisma.adminSectionGrant.update({
      where: { id },
      data: { revokedAt: new Date() },
    });

    await createAuditLog({
      adminUserId: actor.id,
      action: "SECTION_GRANT_REVOKED",
      targetId: grant.adminUserId,
      targetType: "admin_user",
      metadata: {
        grantId: id,
        module: grant.module,
        section: grant.section,
      },
      req,
    });
  }

  async getAvailableModules() {
    // Return available modules and their sections
    const modules = {
      hrm: [
        "accounts",
        "payroll",
        "employees",
        "attendance",
        "leaves",
        "departments",
        "hiring",
      ],
      marketing: [
        "campaigns",
        "analytics",
        "social",
        "content",
        "banners",
        "promotions",
        "intelligence",
        "advertising",
      ],
      finance: ["payments", "invoices", "reports", "transactions"],
      verification: ["doctors", "patients", "pharmacy", "labs", "vendors"],
      operations: ["dispatch", "logistics", "delivery"],
      rtc: ["sessions", "calls", "recordings"],
      telemedicine: ["consultations", "prescriptions", "records"],
    };
    return modules;
  }
}

module.exports = new AccountsService();
