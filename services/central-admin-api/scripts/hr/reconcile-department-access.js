#!/usr/bin/env node
"use strict";

// Reconcile existing accounts with department-based access.
//
// Department defaults are computed on every request (src/shared/auth/
// effective-access.js), so existing employees get them as soon as this
// release runs, and lose them as soon as they change department, lose Team
// Lead status or are deactivated. Nothing has to be written for that.
//
// This script reports, per account, the role and department defaults, and
// flags what HR should review. It never infers leadership from job titles.
//
//   node scripts/hr/reconcile-department-access.js            # dry run (default)
//   node scripts/hr/reconcile-department-access.js --json     # machine-readable
//   node scripts/hr/reconcile-department-access.js --apply    # revoke redundant grants
//
// --apply only revokes explicit grants that are fully covered by the
// account's current department defaults (same module/section, mode not
// higher). Such a grant adds nothing today, but would otherwise survive a
// department change. Every other manual grant is preserved. Re-running is
// a no-op (idempotent).

const { accountRole, inheritedGrants, SECTION_MODE_RANK } = require("../../src/shared/auth/effective-access");

const LEADERSHIP_TITLE = /\b(lead|manager|head|director|supervisor|vp|chief)\b/i;

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
    const inherited = inheritedGrants(account);
    const manual = grantsByUser.get(account.id) || [];
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

    if (account.isTeamLead && !account.department) flags.push("TEAM_LEAD_WITHOUT_DEPARTMENT");
    if (!account.department && account.status === "ACTIVE" && !["SUPER", "EXECUTIVE"].includes(account.tier)) flags.push("NO_DEPARTMENT");
    if (account.tier === "EMPLOYEE" && !account.isTeamLead && LEADERSHIP_TITLE.test(account.position || "")) {
      flags.push("JOB_TITLE_SUGGESTS_LEADERSHIP_NOT_ASSIGNED"); // HR to confirm; never inferred.
    }
    const role = accountRole(account);
    if (account.department === "MARKETING" && account.status === "ACTIVE" && !manual.some((grant) => grant.module === "mail-marketing")) {
      flags.push(role === "STAFF" ? "MARKETING_NO_EMAIL_BRAND" : "MARKETING_LEAD_NO_EMAIL_BRAND");
    }
    if (account.status !== "ACTIVE" && manual.length) flags.push("INACTIVE_WITH_MANUAL_GRANTS");

    report.push({
      id: account.id,
      email: account.email,
      status: account.status,
      department: account.department,
      tier: account.tier,
      isTeamLead: account.isTeamLead,
      role,
      inherited: inherited.map((entry) => `${entry.module}:${entry.section}:${entry.mode}`),
      manual: manual.map((grant) => `${grant.module}:${grant.section}:${grant.mode}`),
      flags,
    });
  }
  return { report, redundant };
}

async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes("--apply");
  const json = argv.includes("--json");
  const { prisma } = require("../../src/shared/config/database");
  try {
    const now = new Date();
    const [accounts, grants, brands] = await Promise.all([
      prisma.adminUser.findMany({
        select: { id: true, email: true, status: true, department: true, tier: true, isTeamLead: true, position: true },
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

    const summary = {
      mode: apply ? "apply" : "dry-run",
      accounts: plan.report.length,
      flagged: plan.report.filter((entry) => entry.flags.length).length,
      redundantGrants: plan.redundant.length,
      revoked,
    };
    if (json) {
      process.stdout.write(`${JSON.stringify({ summary, report: plan.report, redundant: plan.redundant }, null, 2)}\n`);
    } else {
      for (const entry of plan.report) {
        process.stdout.write(`${entry.email} [${entry.status}] ${entry.department || "-"} ${entry.role}: ${entry.inherited.join(", ") || "no department defaults"}${entry.flags.length ? `  !! ${entry.flags.join(", ")}` : ""}\n`);
      }
      for (const entry of plan.redundant) process.stdout.write(`redundant manual grant ${entry.key} on ${entry.adminUserId}${apply ? " (revoked)" : ""}\n`);
      process.stdout.write(`${JSON.stringify(summary)}\n`);
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

module.exports = { planReconciliation };
