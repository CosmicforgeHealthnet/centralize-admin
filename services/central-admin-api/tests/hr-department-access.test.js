"use strict";

// Department-based access and RBAC corrections (HR -> Accounts).
// Drives the real resolver, RBAC middleware, HR accounts service, department
// directory router, Marketing workspace guard and Email Marketing brand
// scopes against an in-memory Admin database.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");

// ── In-memory Admin database ──────────────────────────────────────────────
const tables = { adminUser: [], adminSectionGrant: [], mailOrganization: [], auditLog: [] };

function matches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return cond.some((sub) => matches(row, sub));
    const value = row[key];
    if (key === "adminUser" && cond && typeof cond === "object") {
      return matches(tables.adminUser.find((user) => user.id === row.adminUserId) || {}, cond);
    }
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return cond.in.includes(value);
      if ("gt" in cond) return value != null && value > cond.gt;
      return false;
    }
    if (cond === null) return value === null || value === undefined;
    return value === cond;
  });
}

function pick(row, select) {
  if (!row || !select) return row ? { ...row } : row;
  const out = {};
  for (const [key, on] of Object.entries(select)) if (on && typeof on !== "object") out[key] = row[key];
  return out;
}

function model(name, defaults = () => ({})) {
  const rows = () => tables[name];
  return {
    findUnique: async ({ where, select }) => pick(rows().find((row) => matches(row, where)), select) || null,
    findFirst: async ({ where, select } = {}) => pick(rows().find((row) => matches(row, where)), select) || null,
    findMany: async ({ where, select, include, skip = 0, take } = {}) => {
      const found = rows().filter((row) => matches(row, where));
      return found.slice(skip, take ? skip + take : undefined).map((row) => {
        const out = pick(row, select);
        if (include?.adminUser) out.adminUser = pick(tables.adminUser.find((user) => user.id === row.adminUserId), include.adminUser.select);
        return out;
      });
    },
    count: async ({ where } = {}) => rows().filter((row) => matches(row, where)).length,
    create: async ({ data, select }) => {
      const row = { id: crypto.randomUUID(), createdAt: new Date(), ...defaults(), ...data };
      rows().push(row);
      return pick(row, select);
    },
    createMany: async ({ data }) => {
      for (const entry of data) rows().push({ id: crypto.randomUUID(), createdAt: new Date(), ...defaults(), ...entry });
      return { count: data.length };
    },
    update: async ({ where, data, select }) => {
      const row = rows().find((entry) => matches(entry, where));
      if (!row) throw new Error(`${name} not found`);
      Object.assign(row, data);
      return pick(row, select);
    },
    updateMany: async ({ where, data }) => {
      const found = rows().filter((row) => matches(row, where));
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    },
  };
}

const prisma = {
  adminUser: model("adminUser", () => ({ avatarUrl: null, isTeamLead: false, tier: "EMPLOYEE", status: "PENDING", department: null, position: null })),
  adminSectionGrant: model("adminSectionGrant", () => ({ revokedAt: null, expiresAt: null })),
  mailOrganization: model("mailOrganization"),
  auditLog: model("auditLog"),
  refreshToken: model("refreshToken"),
  team: model("team"),
  project: model("project"),
  leaveRequest: model("leaveRequest"),
  leaveBalance: model("leaveBalance"),
  $transaction: async (fn) => fn(prisma),
};
for (const name of ["refreshToken", "team", "project", "leaveRequest", "leaveBalance"]) tables[name] = [];

function stub(relative, exports) {
  const resolved = require.resolve(relative);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub("../src/shared/config/database", { prisma, connectDatabase: async () => {} });
stub("../src/shared/mail/mail-lifecycle", {
  setMailApplication: () => {},
  offboardMailForAccount: async () => ({ status: "SKIPPED" }),
  isMailRevokingStatus: (status) => status === "INACTIVE",
  requestMailProvisioningForAccount: async () => ({ status: "SKIPPED" }),
});
stub("../src/shared/auth/account-setup", { accountSetup: { isReady: async () => false } });

const access = require("../src/shared/auth/effective-access");
const rbac = require("../src/shared/middlewares/rbac.middleware");
const accounts = require("../src/modules/hrm/accounts/accounts.service");
const departmentsRouter = require("../src/modules/hrm/departments/departments.routes");
const { createMarketingWorkspaceGuard } = require("../src/modules/marketing/marketing-workspace.guard");
const policy = require("../src/modules/mail/authz/mail.policy");
const { planReconciliation } = require("../scripts/hr/reconcile-department-access");

// ── Fixtures ──────────────────────────────────────────────────────────────
const SUPER = { id: crypto.randomUUID(), email: "super@hq.test", name: "Super", tier: "SUPER", status: "ACTIVE", department: null, isTeamLead: false };
const HR = { id: crypto.randomUUID(), email: "hr@hq.test", name: "HR Admin", tier: "ADMIN", status: "ACTIVE", department: "MANAGEMENT", isTeamLead: true };
tables.adminUser.push({ ...SUPER }, { ...HR });
tables.mailOrganization.push(
  { id: crypto.randomUUID(), slug: "karryam", name: "Karryam", kind: "BRAND", status: "ACTIVE" },
  { id: crypto.randomUUID(), slug: "cosmicforge", name: "CosmicForge", kind: "BRAND", status: "ACTIVE" },
);
tables.adminSectionGrant.push({ id: crypto.randomUUID(), adminUserId: HR.id, module: "hrm", section: "accounts", mode: "EDIT", grantedBy: SUPER.id, revokedAt: null, expiresAt: null, createdAt: new Date() });

const row = (id) => tables.adminUser.find((user) => user.id === id);
const asUser = (id) => ({ ...row(id) });
const keys = (grants) => grants.map((grant) => `${grant.module}:${grant.section}:${grant.mode}`).sort();

async function createEmployee(data, actor = SUPER) {
  const created = await accounts.createAccount({ data: { tier: "EMPLOYEE", ...data }, actor, req: {} });
  await accounts.updateStatus({ id: created.id, status: "ACTIVE", actor, req: {} });
  return created;
}

function appWith(mount) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.adminUser = asUser(req.get("x-user"));
    next();
  });
  mount(app);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
  return app;
}

async function call(app, method, path, userId) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "x-user": userId } });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const sectionApp = appWith((app) => {
  app.get("/support/tickets", rbac.requireTierOrDepartment("ADMIN", "support"), rbac.requireSection("support", "tickets", "VIEW"), (_req, res) => res.json({ ok: true }));
  app.get("/finance/payroll", rbac.requireTierOrDepartment("ADMIN", "finance"), rbac.requireSection("finance", "payroll", "VIEW"), (_req, res) => res.json({ ok: true }));
});
const marketingApp = appWith((app) => {
  const router = express.Router();
  router.use(createMarketingWorkspaceGuard());
  router.all(/.*/, (_req, res) => res.json({ ok: true }));
  app.use("/api/marketing", router);
});
const directoryApp = appWith((app) => app.use("/api/hrm/departments", departmentsRouter));

// ── 1. Create a Marketing employee -> Marketing access ─────────────────────
test("1. a new Marketing employee receives Marketing access once active", async () => {
  const created = await accounts.createAccount({ data: { name: "Mara Staff", email: "mara@hq.test", department: "MARKETING", position: "Content Writer", role: "STAFF", tier: "EMPLOYEE" }, actor: SUPER, req: {} });
  assert.equal(created.role, "STAFF");
  assert.equal(created.jobTitle, "Content Writer");
  assert.equal(created.isTeamLead, false);
  assert.deepEqual(access.inheritedGrants(asUser(created.id)), [], "PENDING accounts have no department access");

  await accounts.updateStatus({ id: created.id, status: "ACTIVE", actor: SUPER, req: {} });
  const effective = await accounts.getEffectiveAccess(created.id);
  assert.ok(keys(effective.inherited).includes("marketing:workspace:EDIT") && keys(effective.inherited).includes("department:directory:VIEW"));
  assert.ok(!keys(effective.inherited).includes("marketing:workspace-manage:EDIT"), "staff do not inherit leadership");
  assert.deepEqual(effective.manual, []);

  assert.equal((await call(marketingApp, "GET", "/api/marketing/campaigns", created.id)).status, 200);
  assert.equal((await call(marketingApp, "POST", "/api/marketing/campaigns", created.id)).status, 200);
  assert.equal((await call(marketingApp, "DELETE", "/api/marketing/campaigns/1", created.id)).status, 403, "staff cannot delete");
  assert.equal((await call(marketingApp, "PATCH", "/api/marketing/campaigns/1/status", created.id)).status, 403, "staff cannot change status");

  const mine = await accounts.getMyGrants(asUser(created.id));
  assert.equal(mine.role, "STAFF");
  assert.ok(mine.grants.every((grant) => grant.source === "DEPARTMENT"));
  assert.ok(mine.grants.some((grant) => grant.module === "marketing"), "navigation shows Marketing");
});

// ── 2. Marketing Team Lead -> departmental management ─────────────────────
test("2. assigning Marketing Team Lead adds departmental management", async () => {
  const lead = await createEmployee({ name: "Enoch Lead", email: "enoch@hq.test", department: "MARKETING", position: "Marketing Officer", role: "STAFF" });
  const updated = await accounts.updateAccount({ id: lead.id, data: { role: "TEAM_LEAD" }, actor: HR, req: {} });
  assert.equal(updated.isTeamLead, true);
  assert.equal(updated.role, "TEAM_LEAD");
  assert.equal(updated.jobTitle, "Marketing Officer", "job title is unchanged by the role");

  const effective = await accounts.getEffectiveAccess(lead.id);
  for (const key of ["department:roster:VIEW", "marketing:workspace-manage:EDIT", "marketing:workspace:EDIT", "marketing:intelligence:EDIT", "marketing:advertising-execution:EDIT", "marketing:social_publish:EDIT", "marketing:social_approvals:EDIT"]) assert.ok(keys(effective.inherited).includes(key), key);
  assert.ok(!keys(effective.inherited).includes("department:leaves:VIEW"), "leave requests are Manager-only");
  assert.equal((await call(marketingApp, "DELETE", "/api/marketing/campaigns/1", lead.id)).status, 200);
  assert.equal((await call(marketingApp, "PATCH", "/api/marketing/campaigns/1/status", lead.id)).status, 200);

  const audit = tables.auditLog.filter((entry) => entry.data?.action === "USER_UPDATED" || entry.action === "USER_UPDATED").pop();
  assert.ok(audit.metadata.inheritedAccess.added.includes("marketing:workspace-manage:EDIT") && audit.metadata.inheritedAccess.added.includes("department:roster:VIEW"));

  // Job titles never imply leadership.
  const fromTitle = await createEmployee({ name: "Titled", email: "titled@hq.test", department: "MARKETING", position: "Marketing Manager" });
  assert.equal(access.departmentRole(asUser(fromTitle.id)), "STAFF");
});

// ── 3. Directory -> only own department ───────────────────────────────────
test("3. employees see only colleagues in their own department", async () => {
  const finance = await createEmployee({ name: "Fin Person", email: "fin@hq.test", department: "FINANCE" });
  const pending = await accounts.createAccount({ data: { name: "New Hire", email: "newhire@hq.test", department: "MARKETING", tier: "EMPLOYEE" }, actor: SUPER, req: {} });
  const staff = tables.adminUser.find((user) => user.email === "mara@hq.test");
  const lead = tables.adminUser.find((user) => user.email === "enoch@hq.test");

  const mine = await call(directoryApp, "GET", "/api/hrm/departments/mine/employees?limit=100", staff.id);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.data.data.length >= 2);
  assert.ok(mine.body.data.data.every((user) => user.department === "MARKETING"));
  assert.ok(!mine.body.data.data.some((user) => user.id === finance.id));
  assert.ok(!mine.body.data.data.some((user) => user.id === pending.id), "staff see active colleagues only");
  for (const user of mine.body.data.data) {
    assert.deepEqual(Object.keys(user).sort(), ["avatarUrl", "department", "designation", "email", "id", "jobTitle", "name", "role"]);
  }

  assert.equal((await call(directoryApp, "GET", "/api/hrm/departments/FINANCE/employees", staff.id)).status, 403);
  assert.equal((await call(directoryApp, "GET", "/api/hrm/departments/all/employees", staff.id)).status, 403);
  assert.equal((await call(directoryApp, "GET", "/api/hrm/departments", staff.id)).status, 403, "department list stays HR-only");

  const roster = await call(directoryApp, "GET", "/api/hrm/departments/MARKETING/employees?limit=100", lead.id);
  assert.equal(roster.status, 200);
  assert.ok(roster.body.data.data.some((user) => user.id === pending.id && user.status === "PENDING"), "leads see the full roster");

  // HR with hrm/departments VIEW keeps the full cross-department view.
  tables.adminSectionGrant.push({ id: crypto.randomUUID(), adminUserId: HR.id, module: "hrm", section: "departments", mode: "VIEW", grantedBy: SUPER.id, revokedAt: null, expiresAt: null });
  const hrView = await call(directoryApp, "GET", "/api/hrm/departments/FINANCE/employees", HR.id);
  assert.equal(hrView.status, 200);
  assert.ok(hrView.body.data.data.some((user) => user.id === finance.id));
});

// ── 4. Email Marketing brands ─────────────────────────────────────────────
test("4. Email Marketing brands follow the department; other brands stay isolated", async () => {
  const lead = tables.adminUser.find((user) => user.email === "enoch@hq.test");
  const staff = tables.adminUser.find((user) => user.email === "mara@hq.test");
  const finance = tables.adminUser.find((user) => user.email === "fin@hq.test");
  const karryam = tables.mailOrganization.find((org) => org.slug === "karryam");
  const cosmic = tables.mailOrganization.find((org) => org.slug === "cosmicforge");

  // No manual mail-marketing:karryam grant is needed for the Marketing department.
  assert.ok(!tables.adminSectionGrant.some((grant) => grant.adminUserId === lead.id && grant.module === "mail-marketing"));
  const leadScopes = await policy.marketingScopes(prisma, asUser(lead.id));
  assert.deepEqual(leadScopes.map((scope) => [scope.slug, scope.canView, scope.canAuthor, scope.canApprove, scope.access]), [["karryam", true, true, true, "DEPARTMENT"]]);
  const staffScopes = await policy.marketingScopes(prisma, asUser(staff.id));
  assert.deepEqual(staffScopes.map((scope) => [scope.slug, scope.canAuthor, scope.canApprove]), [["karryam", true, false]], "staff: normal capabilities, no approval");
  assert.deepEqual(await policy.marketingScopes(prisma, asUser(finance.id)), [], "other departments get no Marketing brand");

  await policy.requireMarketingScope(prisma, asUser(lead.id), karryam.id, "EDIT");
  await policy.requireMarketingScope(prisma, asUser(lead.id), karryam.id, "APPROVE");
  await assert.rejects(policy.requireMarketingScope(prisma, asUser(staff.id), karryam.id, "APPROVE"), (error) => error.code === "MAIL_FORBIDDEN");
  await assert.rejects(policy.requireMarketingScope(prisma, asUser(lead.id), cosmic.id, "VIEW"), (error) => error.code === "MAIL_NOT_FOUND", "brand isolation");

  // Authorising is configuration: the mapping can be changed or disabled.
  // An empty/invalid override can never remove the built-in MARKETING:karryam default.
  for (const bad of ["", "   ", "garbage", ":::", "MARKETING:", "MARKETING:!!"]) {
    assert.deepEqual((await policy.marketingScopes(prisma, asUser(lead.id), { env: { MAIL_MARKETING_DEPARTMENT_BRANDS: bad } })).map((s) => s.slug), ["karryam"], `override ${JSON.stringify(bad)} keeps karryam`);
  }
  // Overrides add brands on top of the default.
  assert.deepEqual((await policy.marketingScopes(prisma, asUser(lead.id), { env: { MAIL_MARKETING_DEPARTMENT_BRANDS: "MARKETING:cosmicforge" } })).map((s) => s.slug).sort(), ["cosmicforge", "karryam"]);

  // Explicit Module Permissions remain for additional brands (case-insensitive).
  await accounts.addGrant({ userId: staff.id, data: { module: "mail-marketing", section: "CosmicForge", mode: "VIEW" }, actor: HR, req: {} });
  assert.ok(tables.adminSectionGrant.some((grant) => grant.adminUserId === staff.id && grant.section === "cosmicforge"), "brand section stored lowercase");
  const extra = await policy.marketingScopes(prisma, asUser(staff.id));
  assert.deepEqual(extra.map((scope) => [scope.slug, scope.access, scope.canAuthor]).sort(), [["cosmicforge", "EXPLICIT", false], ["karryam", "DEPARTMENT", true]]);

  // Deactivation and transfer remove the brand immediately.
  const transferred = { ...asUser(lead.id), department: "FINANCE" };
  assert.deepEqual(await policy.marketingScopes(prisma, transferred), []);
  assert.deepEqual(await policy.marketingScopes(prisma, { ...asUser(lead.id), status: "INACTIVE" }), []);

  // Platform Admin (ADMIN) and Super Admin see every ACTIVE brand through the
  // backend policy, can author but cannot approve without leadership/explicit grant.
  const adminScopes = await policy.marketingScopes(prisma, asUser(HR.id));
  assert.deepEqual(adminScopes.map((s) => [s.slug, s.canView, s.canAuthor, s.canApprove, s.access]).sort(), [["cosmicforge", true, true, false, "PLATFORM_ADMIN"], ["karryam", true, true, false, "PLATFORM_ADMIN"]]);
  assert.equal((await policy.marketingScopes(prisma, asUser(SUPER.id))).length, 2);
  await policy.requireMarketingScope(prisma, asUser(HR.id), karryam.id, "EDIT");
  await assert.rejects(policy.requireMarketingScope(prisma, asUser(HR.id), karryam.id, "APPROVE"), (error) => error.code === "MAIL_FORBIDDEN");
  assert.deepEqual(await policy.marketingScopes(prisma, { ...asUser(HR.id), status: "INACTIVE" }), [], "inactive admins have no access");
  assert.deepEqual(await policy.marketingScopes(prisma, { ...asUser(HR.id), tier: "EMPLOYEE", department: "FINANCE" }), [], "tier-based access ends with the tier");

  const effective = await accounts.getEffectiveAccess(lead.id);
  assert.deepEqual(effective.emailMarketing, [{ slug: "karryam", name: "Karryam", canView: true, canAuthor: true, canApprove: true, access: "DEPARTMENT" }]);
});

// ── 5. Manual Module Permission -> only that access ───────────────────────
test("5. a manual Module Permission grants only the specified extra access", async () => {
  const staff = tables.adminUser.find((user) => user.email === "mara@hq.test");
  assert.equal((await call(sectionApp, "GET", "/support/tickets", staff.id)).status, 403);
  await accounts.addGrant({ userId: staff.id, data: { module: "support", section: "tickets", mode: "VIEW" }, actor: HR, req: {} });
  assert.equal((await call(sectionApp, "GET", "/support/tickets", staff.id)).status, 200, "an explicit grant opens exactly that section");
  assert.equal(await rbac.hasSectionAccess(asUser(staff.id), "support", "tickets", "VIEW"), true);
  assert.equal(await rbac.hasSectionAccess(asUser(staff.id), "support", "chats", "VIEW"), false);
  assert.equal(await rbac.hasSectionAccess(asUser(staff.id), "support", "tickets", "EDIT"), false);

  const effective = await accounts.getEffectiveAccess(staff.id);
  assert.ok(effective.manual.some((grant) => grant.module === "support" && grant.source === "MANUAL"));
  assert.ok(effective.inherited.every((grant) => grant.source === "DEPARTMENT"));

  await assert.rejects(accounts.addGrant({ userId: HR.id, data: { module: "finance", section: "payroll", mode: "EDIT" }, actor: HR, req: {} }), /own permissions/);
  await assert.rejects(accounts.addGrant({ userId: staff.id, data: { module: "mail-marketing", section: "*", mode: "EDIT" }, actor: HR, req: {} }), /Only Super/);
  await assert.rejects(accounts.addGrant({ userId: staff.id, data: { module: "mail-marketing", section: "approve:*", mode: "EDIT" }, actor: HR, req: {} }), /Only Super/);
  await assert.rejects(accounts.addGrant({ userId: staff.id, data: { module: "mail-marketing", section: "nosuchbrand", mode: "VIEW" }, actor: HR, req: {} }), /Unknown Email Marketing brand/);

  const modules = await accounts.getAvailableModules();
  assert.deepEqual([...modules["mail-marketing"]].sort(), ["approve:cosmicforge", "approve:karryam", "cosmicforge", "karryam"]);
  assert.ok(modules.support.includes("tickets"));
});

test("5b. syncing Module Permissions keeps unchanged grants and never stores department defaults", async () => {
  const staff = tables.adminUser.find((user) => user.email === "mara@hq.test");
  const before = tables.adminSectionGrant.filter((grant) => grant.adminUserId === staff.id && !grant.revokedAt);
  const kept = before.find((grant) => grant.module === "support");
  const payload = before.filter((grant) => grant.module !== "mail-marketing" || grant.section !== "CosmicForge").map(({ module, section, mode }) => ({ module, section, mode }));
  payload.push({ module: "finance", section: "payments", mode: "VIEW" });
  const result = await accounts.syncGrants({ userId: staff.id, grants: payload, actor: HR, req: {} });
  assert.ok(result.some((grant) => grant.id === kept.id), "unchanged grant keeps its id, grantor and reason");
  assert.ok(result.some((grant) => grant.module === "finance"));
  assert.ok(!result.some((grant) => grant.section === "CosmicForge"));
  assert.ok(!tables.adminSectionGrant.some((grant) => grant.module === "department" || (grant.module === "marketing" && grant.section === "workspace")), "defaults are computed, never stored");
  await assert.rejects(accounts.syncGrants({ userId: HR.id, grants: [{ module: "finance", section: "payroll", mode: "EDIT" }], actor: HR, req: {} }), /own permissions/);
});

// ── 6. Department change -> old inherited access removed ──────────────────
test("6. changing department removes the old department access", async () => {
  const mover = await createEmployee({ name: "Mover", email: "mover@hq.test", department: "MARKETING", role: "TEAM_LEAD" });
  await accounts.addGrant({ userId: mover.id, data: { module: "hrm", section: "attendance", mode: "VIEW" }, actor: HR, req: {} });
  assert.equal((await call(marketingApp, "GET", "/api/marketing/campaigns", mover.id)).status, 200);

  await accounts.updateAccount({ id: mover.id, data: { department: "CUSTOMER_CARE" }, actor: HR, req: {} });
  assert.equal((await call(marketingApp, "GET", "/api/marketing/campaigns", mover.id)).status, 403);
  assert.equal((await call(sectionApp, "GET", "/support/tickets", mover.id)).status, 200, "new department access applies at once");
  const effective = await accounts.getEffectiveAccess(mover.id);
  assert.ok(effective.manual.some((grant) => grant.module === "hrm" && grant.section === "attendance"), "unrelated manual grant preserved");
  const audit = tables.auditLog.filter((entry) => entry.action === "USER_UPDATED").pop();
  assert.ok(audit.metadata.inheritedAccess.removed.includes("marketing:workspace:EDIT"));

  // Losing Team Lead status removes the lead-only access.
  await accounts.updateAccount({ id: mover.id, data: { role: "STAFF" }, actor: HR, req: {} });
  assert.ok(!(await accounts.getEffectiveAccess(mover.id)).inherited.some((grant) => grant.section === "chats" && grant.mode === "EDIT"));
});

// ── 7. Deactivation -> access denied ──────────────────────────────────────
test("7. deactivating an employee removes department access", async () => {
  const leaver = await createEmployee({ name: "Leaver", email: "leaver@hq.test", department: "MARKETING" });
  assert.equal((await call(marketingApp, "GET", "/api/marketing/campaigns", leaver.id)).status, 200);
  await accounts.updateStatus({ id: leaver.id, status: "INACTIVE", actor: HR, req: {} });
  assert.deepEqual(access.inheritedGrants(asUser(leaver.id)), []);
  assert.equal((await call(marketingApp, "GET", "/api/marketing/campaigns", leaver.id)).status, 403);
  assert.equal((await call(directoryApp, "GET", "/api/hrm/departments/mine/employees", leaver.id)).status, 403);
  assert.deepEqual((await accounts.getEffectiveAccess(leaver.id)).inherited, []);
});

// ── 8. Existing accounts and other departments unchanged ──────────────────
test("8. existing Admin/Super access and unrelated departments keep working", async () => {
  const financeAdmin = await createEmployee({ name: "Finance Admin", email: "finadmin@hq.test", department: "FINANCE", tier: "ADMIN" });
  assert.equal(access.departmentRole(asUser(financeAdmin.id)), "STAFF", "the Admin tier is Platform Admin, not a department role");
  assert.equal((await call(sectionApp, "GET", "/support/tickets", financeAdmin.id)).status, 403, "admin tier still needs a support grant");
  assert.equal((await call(sectionApp, "GET", "/support/tickets", SUPER.id)).status, 200);
  assert.equal((await call(marketingApp, "DELETE", "/api/marketing/campaigns/1", financeAdmin.id)).status, 200, "admin tier keeps prior Marketing API access");
  assert.equal((await call(marketingApp, "GET", "/api/marketing/email-templates/customers/search", HR.id)).status, 200);
  const finance = tables.adminUser.find((user) => user.email === "fin@hq.test");
  assert.equal((await call(marketingApp, "GET", "/api/marketing/campaigns", finance.id)).status, 403, "no cross-department Marketing access");

  await assert.rejects(
    accounts.createAccount({ data: { name: "No Dept Manager", email: "nodept@hq.test", tier: "EMPLOYEE", role: "MANAGER" }, actor: SUPER, req: {} }),
    /needs a department/,
  );
  const plain = await accounts.createAccount({ data: { name: "No Role", email: "norole@hq.test", department: "HR", tier: "EMPLOYEE" }, actor: SUPER, req: {} });
  assert.equal(plain.role, "STAFF");
  assert.equal(plain.department, "HR", "every Department value is assignable");
});

// ── 9. Sensitive operations stay protected ────────────────────────────────
test("9. sensitive functions and brand boundaries stay protected", async () => {
  const lead = tables.adminUser.find((user) => user.email === "enoch@hq.test");
  for (const department of Object.keys(access.DEPARTMENT_POLICY)) {
    for (const [tier, isTeamLead] of [["EMPLOYEE", false], ["EMPLOYEE", true], ["ADMIN", false]]) {
      const grants = access.inheritedGrants({ id: "x", status: "ACTIVE", department, tier, isTeamLead });
      for (const grant of grants) {
        assert.ok(!["payroll", "accounts", "admin", "*", "social_publish_emergency_override", "social_moderation_restricted", "documents", "departments"].includes(grant.section), `${department} must not inherit ${grant.module}:${grant.section}`);
        assert.ok(!["mail", "mail-marketing", "development", "admin-settings", "admin-ops"].includes(grant.module), `${department} must not inherit ${grant.module}`);
        assert.ok(!(grant.module === "hrm" && ["accounts", "payroll"].includes(grant.section)));
        // Leadership is confined to the department's own modules.
        const owned = new Set([...access.DEPARTMENT_OWNERSHIP[department].map(([m, s]) => `${m}:${s}`), "department:directory", "department:roster", "department:leaves"]);
        assert.ok(owned.has(`${grant.module}:${grant.section}`), `${department} inherits only what it owns: ${grant.module}:${grant.section}`);
      }
    }
  }
  assert.equal((await call(sectionApp, "GET", "/finance/payroll", tables.adminUser.find((user) => user.email === "fin@hq.test").id)).status, 403, "finance staff do not inherit payroll");
  assert.equal((await call(marketingApp, "GET", "/api/marketing/email-templates/customers/search", lead.id)).status, 403, "customer search stays Admin-only");
  assert.equal((await call(marketingApp, "PATCH", "/api/marketing/email-templates/1/notification", lead.id)).status, 403, "sending settings stay Admin-only");
  assert.equal((await call(marketingApp, "PATCH", "/api/marketing/email-templates/1/recipients", lead.id)).status, 403);
  const scopes = await policy.marketingScopes(prisma, asUser(lead.id));
  assert.ok(scopes.every((scope) => scope.access === "DEPARTMENT" || scope.canApprove === false));
  assert.ok(!scopes.some((scope) => scope.slug === "cosmicforge"), "no inherited access to unassigned brands");
});

test("reconciliation plan flags review items and only revokes fully redundant grants", () => {
  const accountsList = [
    { id: "a", email: "a@x", status: "ACTIVE", department: "MARKETING", tier: "EMPLOYEE", isTeamLead: true, position: "Marketing Officer" },
    { id: "b", email: "b@x", status: "ACTIVE", department: "MARKETING", tier: "EMPLOYEE", isTeamLead: false, position: "Team Lead, Growth" },
    { id: "c", email: "c@x", status: "INACTIVE", department: "FINANCE", tier: "EMPLOYEE", isTeamLead: false, position: null },
  ];
  const grants = [
    { id: "g1", adminUserId: "a", module: "marketing", section: "workspace", mode: "VIEW", expiresAt: null },
    { id: "g2", adminUserId: "a", module: "marketing", section: "intelligence", mode: "EDIT", expiresAt: null },
    { id: "g3", adminUserId: "a", module: "mail-marketing", section: "karryam", mode: "VIEW", expiresAt: null },
    { id: "g4", adminUserId: "b", module: "mail-marketing", section: "unknown", mode: "VIEW", expiresAt: null },
    { id: "g5", adminUserId: "c", module: "finance", section: "payments", mode: "VIEW", expiresAt: null },
  ];
  const plan = planReconciliation({ accounts: accountsList, grants, brands: ["karryam"] });
  assert.deepEqual(plan.redundant.map((entry) => entry.id), ["g1", "g2"], "inactive and non-covered grants are preserved");
  const byId = Object.fromEntries(plan.report.map((entry) => [entry.id, entry]));
  assert.equal(byId.a.role, "TEAM_LEAD");
  assert.deepEqual(byId.a.flags, []);
  assert.ok(byId.b.flags.includes("JOB_TITLE_SUGGESTS_LEADERSHIP_NOT_ASSIGNED"));
  assert.equal(byId.b.role, "STAFF", "leadership is never inferred from a job title");
  assert.ok(byId.b.flags.includes("UNKNOWN_BRAND_GRANT:unknown"));
  assert.ok(byId.c.flags.includes("INACTIVE_WITH_MANUAL_GRANTS"));
  assert.deepEqual(byId.c.inherited, []);
  // Idempotent: planning again after revoking g1 finds nothing to revoke.
  const again = planReconciliation({ accounts: accountsList, grants: grants.filter((grant) => grant.id !== "g1"), brands: ["karryam"] });
  assert.deepEqual(again.redundant.map((entry) => entry.id), ["g2"]);
});

// ── 10. Department Manager is a department role, not the Admin tier ───────
const legacyApp = appWith((app) => {
  app.get("/legacy-admin-only", rbac.requireTier("ADMIN"), (_req, res) => res.json({ ok: true }));
});

test("10. Department Managers manage only their own department and get no Admin-tier powers", async () => {
  const manager = await createEmployee({ name: "Maya Manager", email: "maya@hq.test", department: "MARKETING", role: "MANAGER" });
  assert.equal(manager.role, "MANAGER");
  assert.equal(manager.tier, "EMPLOYEE", "Manager does not change the account tier");
  assert.ok(tables.adminSectionGrant.some((g) => g.adminUserId === manager.id && g.module === "department" && g.section === "manage:MARKETING" && !g.revokedAt));

  const effective = await accounts.getEffectiveAccess(manager.id);
  assert.equal(effective.role, "MANAGER");
  for (const key of ["department:directory:VIEW", "department:leaves:VIEW", "department:roster:VIEW", "marketing:intelligence:EDIT", "marketing:workspace-manage:EDIT", "marketing:workspace:EDIT"]) assert.ok(keys(effective.inherited).includes(key), key);
  assert.ok(!effective.manual.some((g) => g.module === "department"), "role grant is not a Module Permission");
  assert.ok(!(await accounts.getUserGrants(manager.id)).some((g) => g.module === "department"));

  // No bypass through legacy Admin-tier routes or other departments.
  assert.equal((await call(legacyApp, "GET", "/legacy-admin-only", manager.id)).status, 403);
  assert.equal((await call(sectionApp, "GET", "/support/tickets", manager.id)).status, 403);
  assert.equal((await call(marketingApp, "GET", "/api/marketing/email-templates/customers/search", manager.id)).status, 403);
  assert.equal((await call(directoryApp, "GET", "/api/hrm/departments/FINANCE/employees", manager.id)).status, 403);
  assert.equal((await call(marketingApp, "DELETE", "/api/marketing/campaigns/1", manager.id)).status, 200, "manages own department work");

  // Department leave requests: own department only, managers only.
  const marketingStaff = tables.adminUser.find((u) => u.email === "mara@hq.test");
  const financeStaff = tables.adminUser.find((u) => u.email === "fin@hq.test");
  for (const user of [marketingStaff, financeStaff]) {
    tables.leaveRequest.push({ id: crypto.randomUUID(), adminUserId: user.id, leaveType: "ANNUAL", startDate: new Date(), resumptionDate: new Date(), status: "PENDING", createdAt: new Date() });
  }
  const leaves = await call(directoryApp, "GET", "/api/hrm/departments/mine/leaves", manager.id);
  assert.equal(leaves.status, 200);
  assert.deepEqual(leaves.body.data.data.map((l) => l.adminUserId), [marketingStaff.id]);
  const lead = tables.adminUser.find((u) => u.email === "enoch@hq.test");
  assert.equal((await call(directoryApp, "GET", "/api/hrm/departments/mine/leaves", lead.id)).status, 403, "Team Leads do not see leave requests");
  assert.equal((await call(directoryApp, "GET", "/api/hrm/departments/mine/leaves", marketingStaff.id)).status, 403);

  // The role cannot be granted or removed through Module Permissions.
  await assert.rejects(accounts.addGrant({ userId: marketingStaff.id, data: { module: "department", section: "manage:MARKETING", mode: "EDIT" }, actor: HR, req: {} }), /Designation \/ Role/);
  await accounts.syncGrants({ userId: manager.id, grants: [], actor: HR, req: {} });
  assert.equal((await accounts.getEffectiveAccess(manager.id)).role, "MANAGER", "syncing Module Permissions keeps the role");
  const roleRow = tables.adminSectionGrant.find((g) => g.adminUserId === manager.id && g.module === "department" && !g.revokedAt);
  await assert.rejects(accounts.removeGrant({ grantId: roleRow.id, actor: HR, req: {} }), /Designation \/ Role/);
  await assert.rejects(accounts.updateAccount({ id: HR.id, data: { role: "MANAGER" }, actor: HR, req: {} }), /own role/);

  // Email Marketing: assigned brands only; approval stays separate.
  await accounts.addGrant({ userId: manager.id, data: { module: "mail-marketing", section: "karryam", mode: "VIEW" }, actor: HR, req: {} });
  const scopes = await policy.marketingScopes(prisma, asUser(manager.id));
  assert.deepEqual(scopes.map((x) => [x.slug, x.canAuthor, x.canApprove]), [["karryam", true, true]], "Manager manages the department brand (approval keeps SoD + step-up)");

  // Department change revokes the role (it was for Marketing only).
  await accounts.updateAccount({ id: manager.id, data: { department: "FINANCE" }, actor: HR, req: {} });
  const moved = await accounts.getEffectiveAccess(manager.id);
  assert.equal(moved.role, "STAFF");
  assert.ok(!moved.inherited.some((g) => g.module === "marketing" || g.section === "leaves"));
  assert.ok(!tables.adminSectionGrant.some((g) => g.adminUserId === manager.id && g.module === "department" && !g.revokedAt), "stale manager role revoked");
  assert.equal((await policy.marketingScopes(prisma, asUser(manager.id)))[0].canAuthor, false, "no longer authors as a Marketing lead");

  // Role change back to Manager (Finance), then demotion, then deactivation.
  await accounts.updateAccount({ id: manager.id, data: { role: "MANAGER" }, actor: HR, req: {} });
  assert.equal((await accounts.getEffectiveAccess(manager.id)).role, "MANAGER");
  await accounts.updateAccount({ id: manager.id, data: { role: "STAFF" }, actor: HR, req: {} });
  assert.equal((await accounts.getEffectiveAccess(manager.id)).role, "STAFF");
  await accounts.updateAccount({ id: manager.id, data: { role: "MANAGER" }, actor: HR, req: {} });
  await accounts.updateStatus({ id: manager.id, status: "INACTIVE", actor: HR, req: {} });
  assert.deepEqual((await accounts.getEffectiveAccess(manager.id)).inherited, []);
  assert.equal((await call(directoryApp, "GET", "/api/hrm/departments/mine/leaves", manager.id)).status, 403);
});

test("11. Platform Admin and Super keep their privileges; unassigned users get nothing", async () => {
  const platformAdmin = await createEmployee({ name: "Platform Admin", email: "padmin@hq.test", department: "MARKETING", tier: "ADMIN" });
  assert.equal((await accounts.getEffectiveAccess(platformAdmin.id)).role, "STAFF");
  assert.equal((await call(legacyApp, "GET", "/legacy-admin-only", platformAdmin.id)).status, 200);
  assert.equal((await call(marketingApp, "GET", "/api/marketing/email-templates/customers/search", platformAdmin.id)).status, 200);
  assert.equal((await call(legacyApp, "GET", "/legacy-admin-only", SUPER.id)).status, 200);
  assert.equal((await call(sectionApp, "GET", "/finance/payroll", SUPER.id)).status, 200);

  const nobody = await createEmployee({ name: "No Department", email: "nodepartment@hq.test" });
  assert.deepEqual((await accounts.getEffectiveAccess(nobody.id)).inherited, []);
  assert.equal((await call(directoryApp, "GET", "/api/hrm/departments/mine/employees", nobody.id)).status, 403);
  assert.equal((await call(marketingApp, "GET", "/api/marketing/campaigns", nobody.id)).status, 403);
  assert.equal((await call(sectionApp, "GET", "/support/tickets", nobody.id)).status, 403);
  assert.equal((await call(legacyApp, "GET", "/legacy-admin-only", nobody.id)).status, 403);

  const plan = planReconciliation({ accounts: [asUser(platformAdmin.id)], grants: [], brands: ["karryam"] });
  assert.ok(plan.report[0].flags.includes("ADMIN_TIER_IN_DEPARTMENT_REVIEW"), "legacy Admin-tier managers are flagged for HR review");
});
