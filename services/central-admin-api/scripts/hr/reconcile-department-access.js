#!/usr/bin/env node
"use strict";

// Reconcile existing accounts with department-based access.
//
// Department defaults are computed on every request (src/shared/auth/
// effective-access.js), so existing employees get them as soon as this
// release runs, and lose them as soon as they change department, role or
// are deactivated. Nothing has to be written for that.
//
// This script reports, per account, the role and department defaults, and
// flags what HR should review. It never infers leadership from job titles.
//
//   node scripts/hr/reconcile-department-access.js                 # dry run, redacted
//   node scripts/hr/reconcile-department-access.js --match=enoch   # full detail for matching names/emails
//   node scripts/hr/reconcile-department-access.js --json          # machine-readable (redacted)
//   node scripts/hr/reconcile-department-access.js --apply         # revoke redundant grants
//
// Output is redacted by default (no names; emails masked) so it can be
// printed in CI logs. --apply only revokes explicit grants that are fully
// covered by the account's current department defaults (same module/section,
// mode not higher, no expiry). Every other grant, including department role
// grants, is preserved. Re-running is a no-op (idempotent).

const {
  SECTION_MODE_RANK,
  accountRole,
  inheritedGrants,
  isRoleGrant,
  departmentBrands,
} = require("../../src/shared/auth/effective-access");

const LEADERSHIP_TITLE = /\b(lead|manager|head|director|supervisor|vp|chief)\b/i;
const PLATFORM_TIERS = new Set(["ADMIN", "EXECUTIVE", "SUPER"]);
const NON_OPERATIONAL = new Set(["MANAGEMENT", "EXECUTIVE", "HR"]);

function maskEmail(email) {
  const [local = "", domain = ""] = String(email || "").split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

function planReconciliation({ accounts, grants, brands }) {
  const grantsByUser = new Map();
  for (const grant of grants) {
    if (!grantsByUser.has(grant.adminUserId)) grantsByUser.set(grant.adminUserId, []);
    grantsByUser.get(grant.adminUserId).push(grant);
  }
  const brandSet = brands ? new Set(brands) : null;
  const report = [];
  const redundant = [];

  for (const account of accounts) {
    const explicit = grantsByUser.get(account.id) || [];
    const manual = explicit.filter((grant) => !isRoleGrant(grant));
    const roleGrants = explicit.filter(isRoleGrant);
    const inherited = inheritedGrants(account, roleGrants);
    const role = accountRole(account, roleGrants);
    const flags = [];

    for (const grant of manual) {
      const covered = inherited.find((entry) => entry.module === grant.module && entry.section === grant.section);
      if (covered && SECTION_MODE_RANK[covered.mode] >= SECTION_MODE_RANK[grant.mode] && !grant.expiresAt) {
        redundant.push({ id: grant.id, adminUserId: account.id, key: `${grant.module}:${grant.section}:${grant.mode}` });
      }
      if (grant.module === "mail-marketing") {
        const section = String(grant.section).trim().toLowerCase();
        const slug = section.replace(/^approve:/, "");
        if (slug !== "*" && brandSet && !brandSet.has(slug)) flags.push(`UNKNOWN_BRAND_GRANT:${grant.section}`);
      }
    }
    for (const grant of roleGrants) {
      if (grant.section !== `manage:${account.department}`) flags.push(`STALE_MANAGER_ROLE:${grant.section}`);
    }

    if (account.isTeamLead && !account.department) flags.push("TEAM_LEAD_WITHOUT_DEPARTMENT");
    if (!account.department && account.status === "ACTIVE" && !["SUPER", "EXECUTIVE"].includes(account.tier)) flags.push("NO_DEPARTMENT");
    if (role === "STAFF" && LEADERSHIP_TITLE.test(account.position || "")) {
      flags.push("JOB_TITLE_SUGGESTS_LEADERSHIP_NOT_ASSIGNED"); // HR to confirm; never inferred.
    }
    // Before this release an Admin-tier account counted as its department's
    // manager. Admin tier is now Platform Admin only: HR should confirm
    // whether this person is a Platform Admin or a Department Manager.
    if (account.tier === "ADMIN" && account.department && !NON_OPERATIONAL.has(account.department) && account.status === "ACTIVE") {
      flags.push("ADMIN_TIER_IN_DEPARTMENT_REVIEW");
    }
    const departmentHasBrands = (departmentBrands()[account.department] || []).length > 0;
    if (account.department === "MARKETING" && account.status === "ACTIVE" && !departmentHasBrands && !manual.some((grant) => grant.module === "mail-marketing")) {
      flags.push(role === "STAFF" ? "MARKETING_NO_EMAIL_BRAND" : "MARKETING_LEAD_NO_EMAIL_BRAND");
    }
    if (account.status !== "ACTIVE" && manual.length) flags.push("INACTIVE_WITH_MANUAL_GRANTS");

    report.push({
      id: account.id,
      name: account.name,
      email: account.email,
      position: account.position,
      status: account.status,
      department: account.department,
      tier: account.tier,
      isTeamLead: account.isTeamLead,
      role,
      inherited: inherited.map((entry) => `${entry.module}:${entry.section}:${entry.mode}`),
      manual: manual.map((grant) => `${grant.module}:${grant.section}:${grant.mode}`),
      roleGrants: roleGrants.map((grant) => `${grant.module}:${grant.section}`),
      flags,
    });
  }
  return { report, redundant };
}

function redact(entry) {
  const { name: _name, position: _position, email, ...rest } = entry;
  return { ...rest, email: maskEmail(email) };
}

function summarize(plan) {
  const count = (key) => plan.report.filter(key).length;
  const flagCounts = {};
  for (const entry of plan.report) for (const flag of entry.flags) {
    const name = flag.split(":")[0];
    flagCounts[name] = (flagCounts[name] || 0) + 1;
  }
  const roles = {};
  for (const entry of plan.report.filter((e) => e.status === "ACTIVE")) {
    const key = `${entry.department || "NONE"}/${entry.role}`;
    roles[key] = (roles[key] || 0) + 1;
  }
  return {
    accounts: plan.report.length,
    active: count((e) => e.status === "ACTIVE"),
    flagged: count((e) => e.flags.length > 0),
    redundantGrants: plan.redundant.length,
    flagCounts,
    activeByDepartmentRole: roles,
  };
}

async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes("--apply");
  const json = argv.includes("--json");
  const matchArg = argv.find((arg) => arg.startsWith("--match="));
  const match = matchArg ? matchArg.slice("--match=".length).trim().toLowerCase() : null;
  const { prisma } = require("../../src/shared/config/database");
  try {
    const now = new Date();
    const [accounts, grants, brands] = await Promise.all([
      prisma.adminUser.findMany({
        select: { id: true, name: true, email: true, status: true, department: true, tier: true, isTeamLead: true, position: true },
        orderBy: { email: "asc" },
      }),
      prisma.adminSectionGrant.findMany({
        where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { id: true, adminUserId: true, module: true, section: true, mode: true, expiresAt: true },
      }),
      prisma.mailOrganization.findMany({ where: { status: "ACTIVE" }, select: { slug: true } }).then((rows) => rows.map((row) => row.slug)).catch(() => null),
    ]);
    const plan = planReconciliation({ accounts, grants, brands });

    let revoked = 0;
    if (apply && plan.redundant.length) {
      const result = await prisma.adminSectionGrant.updateMany({
        where: { id: { in: plan.redundant.map((entry) => entry.id) }, revokedAt: null },
        data: { revokedAt: now },
      });
      revoked = result.count;
    }

    const summary = { mode: apply ? "apply" : "dry-run", brands, revoked, ...summarize(plan) };
    const matched = match
      ? plan.report.filter((entry) => `${entry.name || ""} ${entry.email || ""}`.toLowerCase().includes(match))
      : [];
    const output = {
      summary,
      ...(match ? { match, matched } : {}),
      report: plan.report.map(redact),
      redundant: plan.redundant,
    };
    if (json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      for (const entry of output.report) {
        process.stdout.write(`${entry.email} [${entry.status}] ${entry.department || "-"} ${entry.tier} ${entry.role}: ${entry.inherited.join(", ") || "no department defaults"}${entry.flags.length ? `  !! ${entry.flags.join(", ")}` : ""}\n`);
      }
      for (const entry of plan.redundant) process.stdout.write(`redundant manual grant ${entry.key} on ${entry.adminUserId}${apply ? " (revoked)" : ""}\n`);
      if (match) process.stdout.write(`MATCH ${JSON.stringify(matched, null, 2)}\n`);
      process.stdout.write(`SUMMARY ${JSON.stringify(summary)}\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`reconcile-department-access failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { planReconciliation, maskEmail };
