"use strict";

// Department leadership access across every department: Team Leads and
// Department Managers get full operational access to what their department
// owns, Staff get normal access, nobody crosses departments, and Platform
// Admin / Super keep their separate privileges.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const grants = []; // explicit AdminSectionGrant rows
const prisma = {
  adminSectionGrant: {
    findMany: async ({ where }) => grants.filter((g) => g.adminUserId === where.adminUserId && !g.revokedAt && (!where.module || g.module === where.module)),
  },
};
const dbPath = require.resolve("../src/shared/config/database");
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma, connectDatabase: async () => {} } };

const access = require("../src/shared/auth/effective-access");
const rbac = require("../src/shared/middlewares/rbac.middleware");

const user = (id, department, role = "STAFF", tier = "EMPLOYEE") => {
  const u = { id, department, tier, status: "ACTIVE", isTeamLead: role === "TEAM_LEAD" };
  if (role === "MANAGER") grants.push({ adminUserId: id, module: "department", section: `manage:${department}`, mode: "EDIT" });
  return u;
};

function app(routes) {
  const a = express();
  a.use((req, _res, next) => { req.adminUser = JSON.parse(req.get("x-user")); req.authSession = { id: "s", mfaVerifiedAt: req.get("x-mfa") ? new Date() : null }; next(); });
  routes(a);
  a.use((e, _req, res, _next) => res.status(e.statusCode || 500).json({ message: e.message }));
  return a;
}
async function call(a, method, path, u, { mfa = false } = {}) {
  const server = a.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { "x-user": JSON.stringify(u), ...(mfa ? { "x-mfa": "1" } : {}) } });
    return res.status;
  } finally { await new Promise((r) => server.close(r)); }
}
const ok = (_req, res) => res.json({ ok: true });

// Representative guarded endpoints per department (same guards as the real routers).
const OWNED = {
  MARKETING: [["marketing", "workspace-manage"], ["marketing", "intelligence"], ["marketing", "social_publish"], ["marketing", "social_approvals"], ["marketing", "advertising-execution"]],
  SOCIAL_MEDIA: [["marketing", "social_publish"], ["marketing", "social_inbox_reply"]],
  CUSTOMER_CARE: [["support", "tickets"], ["support", "chats"]],
  FINANCE: [["finance", "payments"], ["finance", "payment-status"]],
  OPERATIONS: [["operations", "logistics"]],
  RTC: [["rtc", "sessions"]],
  TELEMEDICINE: [["telemedicine", "consultations"]],
  VERIFICATION: [["verification", "providers"]],
  HR: [["hrm", "attendance"], ["hrm", "hiring"], ["hrm", "leaves"], ["hrm", "performance"]],
};
// Never owned by a department: explicit grant, Platform Admin or Super only.
const UNOWNED = [["hrm", "accounts"], ["hrm", "payroll"], ["mail", "admin"], ["admin-ops", "services"], ["marketing", "social_publish_emergency_override"], ["marketing", "social_moderation_restricted"]];

test("leaders get full EDIT on every owned section; staff get normal access; no cross-department access", async () => {
  const departments = Object.keys(access.DEPARTMENT_OWNERSHIP);
  for (const department of departments) {
    for (const role of ["STAFF", "TEAM_LEAD", "MANAGER"]) {
      const u = user(`${department}-${role}`, department, role);
      const effective = await access.effectiveGrants(prisma, u);
      for (const [module, section] of OWNED[department] || []) {
        const leaderOnly = access.DEPARTMENT_OWNERSHIP[department].find(([m, s]) => m === module && s === section)[2] === null;
        const edit = access.grantsAllow(effective, module, section, "EDIT");
        if (role === "STAFF") assert.equal(edit, !leaderOnly && access.DEPARTMENT_OWNERSHIP[department].find(([m, s]) => m === module && s === section)[2] === "EDIT", `${department} staff ${module}:${section}`);
        else assert.equal(edit, true, `${department} ${role} must manage ${module}:${section} without Module Permissions`);
      }
      for (const [module, section] of UNOWNED) assert.equal(access.grantsAllow(effective, module, section, "VIEW"), false, `${department} ${role} must not inherit ${module}:${section}`);
      // Other departments' sections stay closed.
      for (const other of departments.filter((d) => d !== department)) {
        for (const [module, section] of OWNED[other] || []) {
          const ownedToo = access.DEPARTMENT_OWNERSHIP[department].some(([m, s]) => m === module && s === section); // Marketing and Social Media share social operations
          if (!ownedToo) assert.equal(access.grantsAllow(effective, module, section, "VIEW"), false, `${department} ${role} must not reach ${other}'s ${module}:${section}`);
        }
      }
    }
  }
});

test("backend guards: leaders pass department routers; staff are limited; Platform Admin and Super keep their own authority", async () => {
  const a = app((r) => {
    r.get("/support/tickets", rbac.requireTierOrDepartment("ADMIN", "support"), rbac.requireSection("support", "tickets", "VIEW"), ok);
    r.patch("/support/chats", rbac.requireTierOrDepartment("ADMIN", "support"), rbac.requireSection("support", "chats", "EDIT"), ok);
    r.patch("/verification/doctors/1", rbac.requireTierOrSection("ADMIN", "verification", "providers", "EDIT"), ok);
    r.patch("/payments/1/status", rbac.requireSection("finance", "payment-status", "EDIT"), rbac.requireRecentMfaBelowTier("ADMIN"), ok);
    r.get("/hrm/attendance", rbac.requireTierOrDepartment("ADMIN", "hrm"), rbac.requireSection("hrm", "attendance", "VIEW"), ok);
    r.post("/hrm/accounts", rbac.requireTier("ADMIN"), rbac.requireSection("hrm", "accounts", "EDIT"), ok);
    r.get("/admin-settings", rbac.requireTier("ADMIN"), ok);
  });
  const care = (role) => user(`care-${role}`, "CUSTOMER_CARE", role);
  assert.equal(await call(a, "GET", "/support/tickets", care("STAFF")), 200);
  assert.equal(await call(a, "PATCH", "/support/chats", care("STAFF")), 403, "staff cannot edit chats");
  assert.equal(await call(a, "PATCH", "/support/chats", care("TEAM_LEAD")), 200);
  assert.equal(await call(a, "PATCH", "/support/chats", care("MANAGER")), 200);
  assert.equal(await call(a, "GET", "/hrm/attendance", care("MANAGER")), 403, "cross-department");

  const verifier = (role) => user(`ver-${role}`, "VERIFICATION", role);
  assert.equal(await call(a, "PATCH", "/verification/doctors/1", verifier("STAFF")), 403);
  assert.equal(await call(a, "PATCH", "/verification/doctors/1", verifier("TEAM_LEAD")), 200);
  assert.equal(await call(a, "PATCH", "/verification/doctors/1", care("MANAGER")), 403);

  // Sensitive transaction: leaders also need recent MFA; Platform Admin unchanged.
  const fin = (role) => user(`fin-${role}`, "FINANCE", role);
  assert.equal(await call(a, "PATCH", "/payments/1/status", fin("STAFF"), { mfa: true }), 403);
  assert.equal(await call(a, "PATCH", "/payments/1/status", fin("TEAM_LEAD")), 403, "MFA step-up required");
  assert.equal(await call(a, "PATCH", "/payments/1/status", fin("TEAM_LEAD"), { mfa: true }), 200);

  // HR leaders run HR operations but never account/permission/tier management.
  const hr = (role) => user(`hr-${role}`, "HR", role);
  assert.equal(await call(a, "GET", "/hrm/attendance", hr("STAFF")), 200);
  assert.equal(await call(a, "POST", "/hrm/accounts", hr("MANAGER")), 403, "no privilege escalation through account management");
  assert.equal(await call(a, "GET", "/admin-settings", hr("MANAGER")), 403, "no platform-wide authority");

  // Platform Admin and Super: unchanged, separate from department roles.
  const padmin = { id: "pa", department: "MARKETING", tier: "ADMIN", status: "ACTIVE", isTeamLead: false };
  const sup = { id: "su", department: null, tier: "SUPER", status: "ACTIVE", isTeamLead: false };
  assert.equal(await call(a, "GET", "/admin-settings", padmin), 200);
  assert.equal(await call(a, "PATCH", "/payments/1/status", padmin), 403, "Platform Admin gets no department finance authority without a grant");
  assert.equal(await call(a, "PATCH", "/payments/1/status", sup), 200);
  assert.equal(await call(a, "POST", "/hrm/accounts", sup), 200);
});

test("revocation: role change, transfer and deactivation update access immediately; Module Permissions stay additional", async () => {
  const lead = user("mover", "OPERATIONS", "TEAM_LEAD");
  assert.equal(access.grantsAllow(await access.effectiveGrants(prisma, lead), "operations", "logistics", "EDIT"), true);
  assert.equal(access.grantsAllow(await access.effectiveGrants(prisma, { ...lead, isTeamLead: false }), "operations", "logistics", "EDIT"), false, "demoted");
  assert.equal(access.grantsAllow(await access.effectiveGrants(prisma, { ...lead, department: "RTC" }), "operations", "logistics", "VIEW"), false, "transferred");
  assert.deepEqual(await access.effectiveGrants(prisma, { ...lead, status: "INACTIVE" }), []);
  grants.push({ adminUserId: "mover", module: "support", section: "tickets", mode: "VIEW" });
  const extra = await access.effectiveGrants(prisma, { ...lead, department: "RTC" }, { module: "support" });
  assert.deepEqual(extra.map((g) => g.source), ["MANUAL"], "cross-department responsibility needs an explicit Module Permission");
  grants.pop();
});

test("new departmental functionality inherits leadership access once registered", async () => {
  access.registerDepartmentOwnership("DEVELOPMENT", [["development", "deployments", "VIEW"]]);
  const lead = user("dev-lead", "DEVELOPMENT", "TEAM_LEAD");
  const staff = user("dev-staff", "DEVELOPMENT", "STAFF");
  assert.equal(access.grantsAllow(await access.effectiveGrants(prisma, lead), "development", "deployments", "EDIT"), true);
  assert.equal(access.grantsAllow(await access.effectiveGrants(prisma, staff), "development", "deployments", "EDIT"), false);
  assert.equal(access.grantsAllow(await access.effectiveGrants(prisma, staff), "development", "deployments", "VIEW"), true);
  access.DEPARTMENT_OWNERSHIP.DEVELOPMENT.length = 0;
});
