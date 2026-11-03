"use strict";

// Effective permissions = department defaults + explicit section grants.
//
// Department defaults are computed on every request from the account's
// department, role and status. They are never stored, so they cannot go
// stale: changing department, losing Team Lead status or deactivation
// removes them immediately. Explicit grants (HR -> Accounts -> Module
// Permissions, table admin_section_grants) stay the only way to give
// additional, cross-department or sensitive access.
//
// Department defaults deliberately never include sensitive sections
// (payroll, account permissions, security/admin settings, payment status
// changes, Email Marketing brands or approvals, bulk sending). Those still
// require an explicit grant.

const SECTION_MODE_RANK = Object.freeze({ VIEW: 1, EDIT: 2 });

const ROLES = Object.freeze({ STAFF: "STAFF", TEAM_LEAD: "TEAM_LEAD", MANAGER: "MANAGER" });
const ROLE_RANK = Object.freeze({ STAFF: 1, TEAM_LEAD: 2, MANAGER: 3 });

// Department Manager is a department role, not an account tier. It is
// recorded as a role grant "department" / "manage:<DEPARTMENT>" (set only
// through HR -> Accounts -> Designation / Role) and applies only while the
// account belongs to that department. The Admin tier is Platform Admin and
// never implies a department role.
const ROLE_GRANT_MODULE = "department";
const managerSection = (department) => `manage:${department}`;
const isRoleGrant = (grant) => grant?.module === ROLE_GRANT_MODULE && /^manage:/.test(String(grant.section));

const g = (module, section, mode) => Object.freeze({ module, section, mode });

// Every department: the colleague directory (basic work information only).
const DIRECTORY = Object.freeze({
  STAFF: [g("department", "directory", "VIEW")],
  TEAM_LEAD: [g("department", "directory", "VIEW"), g("department", "roster", "VIEW")],
  MANAGER: [g("department", "directory", "VIEW"), g("department", "roster", "VIEW"), g("department", "leaves", "VIEW")],
});

// Normal workspace per department. Each role inherits the roles below it.
const DEPARTMENT_POLICY = Object.freeze({
  MARKETING: {
    STAFF: [g("marketing", "workspace", "EDIT")],
    TEAM_LEAD: [g("marketing", "workspace-manage", "EDIT")],
    MANAGER: [g("marketing", "intelligence", "VIEW")],
  },
  CUSTOMER_CARE: {
    STAFF: [g("support", "tickets", "VIEW"), g("support", "chats", "VIEW")],
    TEAM_LEAD: [g("support", "chats", "EDIT")],
    MANAGER: [],
  },
  FINANCE: {
    STAFF: [g("finance", "payments", "VIEW")],
    TEAM_LEAD: [],
    MANAGER: [],
  },
  OPERATIONS: {
    STAFF: [g("operations", "logistics", "VIEW")],
    TEAM_LEAD: [],
    MANAGER: [],
  },
  RTC: {
    STAFF: [g("rtc", "sessions", "VIEW")],
    TEAM_LEAD: [],
    MANAGER: [],
  },
  TELEMEDICINE: {
    STAFF: [g("telemedicine", "consultations", "VIEW")],
    TEAM_LEAD: [],
    MANAGER: [],
  },
});

function holdsManagerGrant(user, explicit = []) {
  if (!user?.department) return false;
  const section = managerSection(user.department);
  return explicit.some((grant) => grant.module === ROLE_GRANT_MODULE && grant.section === section && grant.mode === "EDIT");
}

// Role from department membership, Team Lead status and the manager role
// grant. Tier and job title (position) are never used.
function accountRole(user, explicit = []) {
  if (!user) return null;
  if (holdsManagerGrant(user, explicit)) return ROLES.MANAGER;
  if (user.isTeamLead === true) return ROLES.TEAM_LEAD;
  return ROLES.STAFF;
}

function departmentRole(user, explicit = []) {
  return user?.department ? accountRole(user, explicit) : null;
}

function rolesUpTo(role) {
  return Object.keys(ROLE_RANK).filter((r) => ROLE_RANK[r] <= ROLE_RANK[role]);
}

// Department defaults for this account (empty unless ACTIVE with a
// department). `explicit` = the account's active explicit grants.
function inheritedGrants(user, explicit = []) {
  const role = departmentRole(user, explicit);
  if (!role || user.status !== "ACTIVE") return [];
  const policy = DEPARTMENT_POLICY[user.department] || {};
  const byKey = new Map();
  for (const entry of [...DIRECTORY[role], ...rolesUpTo(role).flatMap((r) => policy[r] || [])]) {
    const key = `${entry.module}:${entry.section}`;
    const prev = byKey.get(key);
    if (!prev || SECTION_MODE_RANK[entry.mode] > SECTION_MODE_RANK[prev.mode]) byKey.set(key, entry);
  }
  return [...byKey.values()].map((entry) => ({
    module: entry.module,
    section: entry.section,
    mode: entry.mode,
    expiresAt: null,
    source: "DEPARTMENT",
    department: user.department,
    role,
  }));
}

function activeGrantWhere(adminUserId, now, extra = {}) {
  return { adminUserId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], ...extra };
}

async function explicitGrants(client, user, { module, now = new Date() } = {}) {
  if (!user?.id) return [];
  const rows = await client.adminSectionGrant.findMany({
    where: activeGrantWhere(user.id, now, module ? { module } : {}),
    select: { id: true, module: true, section: true, mode: true, expiresAt: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({ ...row, source: isRoleGrant(row) ? "ROLE" : "MANUAL" }));
}

// One resolver for all callers: explicit grants plus department defaults.
async function effectiveGrants(client, user, { module, now = new Date() } = {}) {
  const explicit = await explicitGrants(client, user, { now });
  const all = [...inheritedGrants(user, explicit), ...explicit];
  return module ? all.filter((grant) => grant.module === module) : all;
}

function grantsAllow(grants, module, section, mode = "VIEW") {
  return grants.some(
    (grant) => grant.module === module
      && (grant.section === section || grant.section === "*")
      && SECTION_MODE_RANK[grant.mode] >= SECTION_MODE_RANK[mode],
  );
}

async function hasEffectiveSection(client, user, module, section, mode = "VIEW", options = {}) {
  if (!user) return false;
  return grantsAllow(await effectiveGrants(client, user, { ...options, module }), module, section, mode);
}

module.exports = {
  ROLES,
  DEPARTMENT_POLICY,
  SECTION_MODE_RANK,
  ROLE_GRANT_MODULE,
  managerSection,
  isRoleGrant,
  accountRole,
  departmentRole,
  inheritedGrants,
  explicitGrants,
  effectiveGrants,
  grantsAllow,
  hasEffectiveSection,
};
