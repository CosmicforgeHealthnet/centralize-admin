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
// Team Leads and Department Managers inherit full operational access to what
// their department owns (see DEPARTMENT_OWNERSHIP). Sensitive areas that no
// department owns (payroll, account permissions, security/admin settings)
// still require an explicit grant, and MFA, consent, segregation-of-duties
// and independent-approval checks are enforced where the action happens.

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

// ── Department ownership (single registry) ───────────────────────────────
// Every department-owned section is registered here once: [module, section,
// staffMode]. staffMode is what ordinary Staff receive (null = leaders only).
// Team Leads and Department Managers automatically receive full operational
// access (EDIT = view, create, edit, delete, manage) to EVERY section their
// department owns, with no Module Permission grant. Backend guards and the
// frontend both read this registry (via effective grants), so they cannot
// disagree. New departmental functionality inherits leadership access by
// registering its sections with registerDepartmentOwnership().
//
// Deliberately not owned by any department (explicit grant only): payroll and
// HR account/permission management, security and admin settings (Mail admin,
// admin-ops), emergency/restricted social moderation, advertising execution
// roles, and Platform Admin / Super functions.
const own = (module, section, staffMode = null) => Object.freeze([module, section, staffMode]);

const SOCIAL_SECTIONS = Object.freeze([
  own("marketing", "social_content", "EDIT"),
  own("marketing", "social_content_submit", "EDIT"),
  own("marketing", "social_analytics", "VIEW"),
  own("marketing", "social_inbox", "VIEW"),
  own("marketing", "social_approvals"),
  own("marketing", "social_publish"),
  own("marketing", "social_schedule"),
  own("marketing", "social_publish_retry"),
  own("marketing", "social_publish_cancel"),
  own("marketing", "social_publish_delete"),
  own("marketing", "social_inbox_reply"),
  own("marketing", "social_inbox_assign"),
  own("marketing", "social_inbox_resolve"),
  own("marketing", "social_inbox_note"),
  own("marketing", "social_inbox_tag"),
  own("marketing", "social_moderation_hide"),
  own("marketing", "social_moderation_delete"),
  own("marketing", "social_moderation_escalate"),
  own("marketing", "social_moderation_safety"),
  own("marketing", "social_connections"),
  own("marketing", "social_settings"),
  own("marketing", "social_operations"),
]);

const DEPARTMENT_OWNERSHIP = {
  MARKETING: [
    own("marketing", "workspace", "EDIT"),
    own("marketing", "workspace-manage"),
    own("marketing", "intelligence"),
    own("marketing", "advertising-execution"),
    ...SOCIAL_SECTIONS,
  ],
  SOCIAL_MEDIA: [own("marketing", "workspace", "VIEW"), ...SOCIAL_SECTIONS],
  CUSTOMER_CARE: [own("support", "tickets", "VIEW"), own("support", "chats", "VIEW")],
  FINANCE: [own("finance", "payments", "VIEW"), own("finance", "payment-status")],
  OPERATIONS: [own("operations", "logistics", "VIEW")],
  RTC: [own("rtc", "sessions", "VIEW")],
  TELEMEDICINE: [own("telemedicine", "consultations", "VIEW")],
  VERIFICATION: [own("verification", "providers", "VIEW")],
  HR: [
    own("hrm", "attendance", "VIEW"),
    own("hrm", "hiring", "VIEW"),
    own("hrm", "leaves", "VIEW"),
    own("hrm", "performance"),
  ],
  // No department-owned modules implemented yet; register them here when added.
  DEVELOPMENT: [],
  EXECUTIVE: [],
  MANAGEMENT: [],
};

function registerDepartmentOwnership(department, sections) {
  DEPARTMENT_OWNERSHIP[department] = [...(DEPARTMENT_OWNERSHIP[department] || []), ...sections.map(([m, s, mode]) => own(m, s, mode || null))];
}

// Departments whose members/leaders work with the Email Marketing brands
// authorised for them (brand isolation: only these brand slugs).
// MAIL_MARKETING_DEPARTMENT_BRANDS="MARKETING:karryam,other;SOCIAL_MEDIA:karryam"
// ADDS mappings on top of the built-in default (MARKETING:karryam). The
// default can never be removed by an empty, blank or malformed override, so a
// bad production value cannot lock the Marketing department out of Karryam.
// No migration: this is configuration, not data.
const DEFAULT_DEPARTMENT_BRANDS = "MARKETING:karryam";
function parseDepartmentBrands(raw, map) {
  for (const part of String(raw || "").split(";")) {
    const [dept, list] = part.split(":");
    const key = String(dept || "").trim().toUpperCase();
    if (!/^[A-Z_]+$/.test(key) || !list) continue;
    const slugs = list.split(",").map((b) => b.trim().toLowerCase()).filter((b) => /^[a-z0-9][a-z0-9-]*$/.test(b));
    if (slugs.length) map[key] = [...new Set([...(map[key] || []), ...slugs])];
  }
  return map;
}
function departmentBrands(env = process.env) {
  const map = parseDepartmentBrands(DEFAULT_DEPARTMENT_BRANDS, {});
  return parseDepartmentBrands(env.MAIL_MARKETING_DEPARTMENT_BRANDS, map);
}

// Derived per-role view of the registry (kept for callers and tests).
function policyFor(department) {
  const entries = DEPARTMENT_OWNERSHIP[department] || [];
  const staff = entries.filter(([, , mode]) => mode).map(([m, s, mode]) => g(m, s, mode));
  const lead = entries.map(([m, s]) => g(m, s, "EDIT"));
  return { STAFF: staff, TEAM_LEAD: lead, MANAGER: lead };
}
const DEPARTMENT_POLICY = new Proxy({}, { get: (_t, department) => policyFor(department), has: (_t, department) => department in DEPARTMENT_OWNERSHIP, ownKeys: () => Object.keys(DEPARTMENT_OWNERSHIP), getOwnPropertyDescriptor: (_t, department) => (department in DEPARTMENT_OWNERSHIP ? { enumerable: true, configurable: true, value: policyFor(department) } : undefined) });

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
  const policy = policyFor(user.department);
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
  DEPARTMENT_OWNERSHIP,
  registerDepartmentOwnership,
  departmentBrands,
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
