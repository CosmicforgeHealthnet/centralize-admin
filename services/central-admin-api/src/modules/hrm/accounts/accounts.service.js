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
const {
  ROLE_GRANT_MODULE,
  accountRole,
  departmentRole,
  explicitGrants,
  inheritedGrants,
  isRoleGrant,
  managerSection,
} = require("../../../shared/auth/effective-access");

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

function mapAccountListItem(user, roleGrants = []) {
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
    isTeamLead: user.isTeamLead,
    role: accountRole(user, roleGrants),
    avatarUrl: user.avatarUrl,
  };
}

const accessKey = (grant) => `${grant.module}:${grant.section}:${grant.mode}`;

// Designation / Role -> stored data. Team Lead status is isTeamLead. The
// Department Manager role is a role grant "department" / "manage:<DEPT>",
// independent of the account tier (Admin tier = Platform Admin).
function applyRole(update, role, department) {
  if (!role || role === "MANAGER") {
    if (role === "MANAGER" && !department) {
      throw new ApiError(400, "A Department Manager needs a department", [{ field: "role", reason: "MANAGER_REQUIRES_DEPARTMENT" }]);
    }
    return update;
  }
  return { ...update, isTeamLead: role === "TEAM_LEAD" };
}

const activeWindow = (now = new Date()) => ({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

// Active role grants for a set of accounts.
async function roleGrantsByUser(ids, client = prisma) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await client.adminSectionGrant.findMany({
    where: { adminUserId: { in: ids }, module: ROLE_GRANT_MODULE, ...activeWindow() },
    select: { adminUserId: true, module: true, section: true, mode: true },
  });
  for (const row of rows) {
    if (!map.has(row.adminUserId)) map.set(row.adminUserId, []);
    map.get(row.adminUserId).push(row);
  }
  return map;
}

// Keep the manager role grant in line with the role and the department:
// one manage:<department> grant for a Department Manager, none otherwise.
// A grant for any other department (e.g. after a department change) is
// always revoked. role === undefined keeps the current role.
async function syncManagerRole({ client = prisma, accountId, role, department, actor }) {
  const now = new Date();
  const current = (await client.adminSectionGrant.findMany({ where: { adminUserId: accountId, module: ROLE_GRANT_MODULE, ...activeWindow(now) } })).filter(isRoleGrant);
  const own = department ? managerSection(department) : null;
  const keep = role === "MANAGER" || (!role && current.some((grant) => grant.section === own)) ? own : null;
  const revoke = current.filter((grant) => grant.section !== keep);
  if (revoke.length) {
    await client.adminSectionGrant.updateMany({ where: { id: { in: revoke.map((grant) => grant.id) }, revokedAt: null }, data: { revokedAt: now } });
  }
  const created = keep && !current.some((grant) => grant.section === keep) ? keep : null;
  if (created) {
    await client.adminSectionGrant.create({
      data: { adminUserId: accountId, module: ROLE_GRANT_MODULE, section: created, mode: "EDIT", grantedBy: actor.id, reason: "HR role: Department Manager" },
    });
  }
  return { revoked: revoke.map((grant) => grant.section), created };
}

// ─── Module Permissions safety ────────────────────────────────────────────
const MAIL_MARKETING_MODULE = "mail-marketing";
const BRAND_SECTION = /^(approve:)?([a-z0-9][a-z0-9-]{0,62}|\*)$/;

async function activeBrandSlugs() {
  try {
    const rows = await prisma.mailOrganization.findMany({ where: { status: "ACTIVE" }, select: { slug: true }, orderBy: { slug: "asc" } });
    return rows.map((row) => row.slug);
  } catch {
    return null; // Mail tables not present yet.
  }
}

// Explicit grants are additional access only. They may not be self-issued,
// and Email Marketing grants must name a real brand (or a wildcard, which
// only a Super account may issue). Approval itself stays protected by the
// campaign workflow (reviewer must differ from the author, step-up).
async function normalizeGrant({ actor, accountId, grant, brands }) {
  if (accountId === actor.id && actor.tier !== "SUPER") {
    throw new ApiError(403, "You cannot change your own permissions");
  }
  if (grant.module === ROLE_GRANT_MODULE) {
    throw new ApiError(400, "Department roles are set with Designation / Role, not Module Permissions", [{ field: "module" }]);
  }
  if (grant.module !== MAIL_MARKETING_MODULE) return grant;
  const section = String(grant.section).trim().toLowerCase();
  const match = BRAND_SECTION.exec(section);
  if (!match) throw new ApiError(400, "Invalid Email Marketing brand section", [{ field: "section" }]);
  if (match[2] === "*") {
    if (actor.tier !== "SUPER") throw new ApiError(403, "Only Super accounts can grant access to every brand");
  } else if (brands && !brands.includes(match[2])) {
    throw new ApiError(400, `Unknown Email Marketing brand: ${match[2]}`, [{ field: "section" }]);
  }
  return { ...grant, section };
}

function mapAccountDetail(user, roleGrants = []) {
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
    isTeamLead: user.isTeamLead,
    role: accountRole(user, roleGrants),
    departmentRole: departmentRole(user, roleGrants),
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

// ─── Mail offboarding / onboarding on HR lifecycle changes ────────────────
// Shared with admin-users and HRM employees (src/shared/mail/mail-lifecycle):
// Mail is optional, the HR action always succeeds, the outcome is recorded in
// the HR audit entry. Reactivation never restores Mail access.
const mailLifecycle = require("../../../shared/mail/mail-lifecycle");

function offboardMail({ accountId, actor, trigger, req }) {
  return mailLifecycle.offboardMailForAccount({ accountId, actorId: actor?.id || null, trigger, req });
}

function isForeignKeyViolation(error) {
  return error?.code === "P2003" || error?.cause?.code === "P2003" || /foreign key constraint/i.test(String(error?.message || ""));
}

class AccountsService {
  // Test seam: inject a Mail application (or null for "Mail not available").
  setMailApplication(application) {
    mailLifecycle.setMailApplication(application);
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

    const roles = await roleGrantsByUser(users.map((user) => user.id));
    return {
      accounts: users.map((user) => mapAccountListItem(user, roles.get(user.id))),
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
    return mapAccountDetail(user, (await roleGrantsByUser([user.id])).get(user.id));
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
    const roleGrants = user.sectionGrants.filter(isRoleGrant);
    const account = mapAccountDetail(user, roleGrants);
    // sectionGrants = Module Permissions (manual grants) only, as before.
    account.sectionGrants = user.sectionGrants.filter((grant) => !isRoleGrant(grant));
    account.inheritedGrants = inheritedGrants(user, roleGrants);
    return account;
  }

  // Effective permissions shown on the employee account page: department
  // defaults and additional (manual) grants, plus Email Marketing brands.
  async getEffectiveAccess(id) {
    const accountId = assertUuid(id, "account id");
    const user = await prisma.adminUser.findUnique({ where: { id: accountId }, select: ACCOUNT_SELECT });
    if (!user) throw new ApiError(404, "Account not found");
    const now = new Date();
    const explicit = await explicitGrants(prisma, user, { now });
    const manual = user.status === "ACTIVE" ? explicit.filter((grant) => grant.source === "MANUAL") : [];
    let emailMarketing = null;
    try {
      const policy = require("../../mail/authz/mail.policy");
      emailMarketing = (await policy.marketingScopes(prisma, user, { now })).map(({ slug, name, canView, canAuthor, canApprove }) => ({ slug, name, canView, canAuthor, canApprove }));
    } catch (error) {
      logger.warn(`Email Marketing scopes unavailable for ${accountId}: ${error.message}`);
    }
    return {
      accountId,
      status: user.status,
      active: user.status === "ACTIVE",
      department: user.department,
      tier: user.tier,
      isTeamLead: user.isTeamLead,
      role: accountRole(user, explicit),
      departmentRole: departmentRole(user, explicit),
      inherited: inheritedGrants(user, explicit),
      manual,
      emailMarketing,
    };
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

    // Optional HR onboarding request for a work email (spec section 15).
    // Not an AdminUser column: stripped before the account is created.
    const { mailProvisioning: mailProvisioningInput, role, ...fields } = data;
    const accountData = applyRole(fields, role, fields.department);

    // Unusable random password: the invitee chooses one through the link.
    const password = await hashPassword(unusablePassword());

    const created = await prisma.adminUser.create({
      data: {
        ...accountData,
        password,
        mustChangePassword: true,
        status: "PENDING",
        createdBy: actor.id,
      },
      select: ACCOUNT_SELECT,
    });

    // Department Manager role (a role grant; never the account tier).
    let managerGrants = [];
    if (role === "MANAGER") {
      await syncManagerRole({ accountId: created.id, role, department: created.department, actor });
      managerGrants = [{ module: ROLE_GRANT_MODULE, section: managerSection(created.department), mode: "EDIT" }];
    }

    const inviteDelivery = await sendInviteLink({ user: created, actor });

    // A PENDING request only: IT still approves it in Mail administration.
    const mailProvisioning = mailProvisioningInput?.requested
      ? await mailLifecycle.requestMailProvisioningForAccount({
        accountId: created.id,
        actorId: actor.id,
        localPart: mailProvisioningInput.localPart || null,
        domainId: mailProvisioningInput.domainId || null,
        name: created.name,
        req,
      })
      : undefined;

    await createAuditLog({
      adminUserId: actor.id,
      action: "USER_CREATED",
      targetId: created.id,
      targetType: "admin_user",
      metadata: {
        email: created.email,
        tier: created.tier,
        department: created.department,
        isTeamLead: created.isTeamLead,
        role: accountRole(created, managerGrants),
        inviteDelivery,
        mailProvisioning: mailProvisioning
          ? { status: mailProvisioning.status, reason: mailProvisioning.reason, requestId: mailProvisioning.requestId }
          : undefined,
      },
      req,
    });

    return { ...mapAccountDetail(created, managerGrants), inviteDelivery, ...(mailProvisioning ? { mailProvisioning } : {}) };
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

    let update = pickDefined(data, ACCOUNT_UPDATE_FIELDS);
    if (!isSensitiveTier(actor)) {
      delete update.tier;
      delete update.status;
    }
    const nextDepartment = update.department !== undefined ? update.department : existing.department;
    if (data.role && accountId === actor.id && actor.tier !== "SUPER") {
      throw new ApiError(403, "You cannot change your own role");
    }
    update = applyRole(update, data.role, nextDepartment);
    const rolesBefore = (await roleGrantsByUser([accountId])).get(accountId) || [];

    const updated = await prisma.adminUser.update({
      where: { id: accountId },
      data: update,
      select: ACCOUNT_SELECT,
    });

    // Department defaults follow the new department/role/status at once
    // (they are computed, never stored); record what changed.
    // The manager role grant follows the role and the (new) department.
    const roleGrant = await syncManagerRole({ accountId, role: data.role, department: updated.department, actor });
    const rolesAfter = (await roleGrantsByUser([accountId])).get(accountId) || [];
    const before = new Set(inheritedGrants(existing, rolesBefore).map(accessKey));
    const after = new Set(inheritedGrants(updated, rolesAfter).map(accessKey));
    const inheritedAccess = {
      added: [...after].filter((key) => !before.has(key)),
      removed: [...before].filter((key) => !after.has(key)),
    };

    const mailOffboarding = update.status && mailLifecycle.isMailRevokingStatus(update.status)
      ? await offboardMail({ accountId, actor, trigger: `HR_ACCOUNT_${update.status}`, req })
      : undefined;

    await createAuditLog({
      adminUserId: actor.id,
      action: "USER_UPDATED",
      targetId: accountId,
      targetType: "admin_user",
      metadata: { changes: update, role: accountRole(updated, rolesAfter), roleGrant, inheritedAccess, mailOffboarding: mailOffboarding?.status },
      req,
    });

    return mapAccountDetail(updated, rolesAfter);
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
    const mailOffboarding = mailLifecycle.isMailRevokingStatus(status)
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

    return mapAccountDetail(updated, (await roleGrantsByUser([accountId])).get(accountId));
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
  // Effective grants: department defaults (source DEPARTMENT) followed by
  // explicit grants (source MANUAL).
  async getMyGrants(actor) {
    const manual = await explicitGrants(prisma, actor);
    const grants = [...inheritedGrants(actor, manual), ...manual].map(({ module, section, mode, expiresAt, source }) => ({ module, section, mode, expiresAt, source }));
    return { tier: actor.tier, department: actor.department || null, role: accountRole(actor, manual), isTeamLead: Boolean(actor.isTeamLead), grants };
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

    // Module Permissions only; department role grants are managed by role.
    return grants.filter((grant) => !isRoleGrant(grant));
  }

  async addGrant({ userId, data, actor, req }) {
    const accountId = assertUuid(userId, "user id");

    // Check if user exists
    const user = await prisma.adminUser.findUnique({
      where: { id: accountId },
      select: { id: true },
    });
    if (!user) throw new ApiError(404, "User not found");

    data = await normalizeGrant({
      actor,
      accountId,
      grant: data,
      brands: data.module === MAIL_MARKETING_MODULE ? await activeBrandSlugs() : null,
    });

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

    // Explicit grants only (department defaults are never stored). Unchanged
    // grants are kept as they are (grantor, reason, expiry); only removed
    // ones are revoked and only new or changed ones are created.
    // Department role grants are never touched by Module Permissions.
    const current = (await prisma.adminSectionGrant.findMany({
      where: { adminUserId: accountId, revokedAt: null },
    })).filter((g) => !isRoleGrant(g));
    const keyOf = (g) => `${g.module}:${String(g.section).trim().toLowerCase()}`;
    const currentByKey = new Map(current.map((g) => [keyOf(g), g]));
    const wanted = new Map();
    for (const g of grants) wanted.set(keyOf(g), g);

    const sameExpiry = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);
    const toRevoke = current.filter((g) => {
      const next = wanted.get(keyOf(g));
      return !next || next.mode !== g.mode || !sameExpiry(next.expiresAt, g.expiresAt);
    });
    const revokedKeys = new Set(toRevoke.map(keyOf));
    const toCreate = [...wanted.entries()]
      .filter(([key]) => !currentByKey.has(key) || revokedKeys.has(key))
      .map(([, g]) => g);

    if (toRevoke.length || toCreate.length) {
      if (accountId === actor.id && actor.tier !== "SUPER") {
        throw new ApiError(403, "You cannot change your own permissions");
      }
    }
    const brands = toCreate.some((g) => g.module === MAIL_MARKETING_MODULE) ? await activeBrandSlugs() : null;
    const normalized = [];
    for (const g of toCreate) normalized.push(await normalizeGrant({ actor, accountId, grant: g, brands }));

    const result = await prisma.$transaction(async (tx) => {
      if (toRevoke.length) {
        await tx.adminSectionGrant.updateMany({
          where: { id: { in: toRevoke.map((g) => g.id) }, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      if (normalized.length > 0) {
        await tx.adminSectionGrant.createMany({
          data: normalized.map((g) => ({
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

      // Return the active grants
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
        revoked: toRevoke.map((g) => `${g.module}:${g.section}:${g.mode}`),
        created: normalized.map((g) => `${g.module}:${g.section}:${g.mode}`),
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
    if (isRoleGrant(grant)) {
      throw new ApiError(400, "Department roles are set with Designation / Role, not Module Permissions");
    }
    if (grant.adminUserId === actor.id && actor.tier !== "SUPER") {
      throw new ApiError(403, "You cannot change your own permissions");
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
    if (isRoleGrant(grant)) {
      throw new ApiError(400, "Department roles are set with Designation / Role, not Module Permissions");
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
    const brands = (await activeBrandSlugs()) || [];
    const modules = {
      hrm: [
        "accounts",
        "payroll",
        "employees",
        "attendance",
        "leaves",
        "departments",
        "hiring",
        "documents",
        "performance",
      ],
      marketing: [
        "workspace",
        "workspace-manage",
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
      support: ["tickets", "chats"],
      // Email Marketing: one section per brand (author access) and
      // approve:<brand> (campaign approval). Wildcards are Super-only and
      // not offered here.
      [MAIL_MARKETING_MODULE]: [...brands, ...brands.map((slug) => `approve:${slug}`)],
    };
    return modules;
  }
}

module.exports = new AccountsService();
