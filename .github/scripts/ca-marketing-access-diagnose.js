"use strict";

// READ-ONLY Email Marketing access diagnostic. Piped into the running app
// container by ca-mail-staging-ops.sh --marketing-access-diagnose:
//   docker exec -i -w /app <container> node - < ca-marketing-access-diagnose.js
// Evaluates the container's OWN policy code against its own database.
// Prints counts, booleans, enum values and brand slugs only: no names, emails,
// ids, secrets or tokens. Never writes. Output: one line `CA_MKT_DIAG <json>`.

const { prisma } = require("./src/shared/config/database");
const policy = require("./src/modules/mail/authz/mail.policy");
const access = require("./src/shared/auth/effective-access");

const out = {};
const safe = async (label, fn) => { try { return await fn(); } catch (e) { return { error: String(e?.code || e?.name || "error"), message: String(e?.message || "").slice(0, 120), label }; } };
const tally = (rows, key) => rows.reduce((m, r) => { const k = String(key(r)); m[k] = (m[k] || 0) + 1; return m; }, {});

(async () => {
  const raw = process.env.MAIL_MARKETING_DEPARTMENT_BRANDS;
  out.env = {
    MAIL_ENABLED: process.env.MAIL_ENABLED,
    MAIL_MARKETING_ENABLED: process.env.MAIL_MARKETING_ENABLED,
    MAIL_MARKETING_DEPARTMENT_BRANDS: raw === undefined ? "<unset>" : raw === "" ? "<empty>" : raw.slice(0, 200),
    MAIL_BROADCAST_DISPATCH_ENABLED: process.env.MAIL_BROADCAST_DISPATCH_ENABLED,
    MAIL_MARKETING_TEST_SENDS_ENABLED: process.env.MAIL_MARKETING_TEST_SENDS_ENABLED,
  };
  out.departmentBrands = typeof access.departmentBrands === "function" ? access.departmentBrands(process.env) : "unavailable";
  out.release = process.env.MAIL_RELEASE_IMAGE || null;
  out.organizations = await safe("orgs", async () => (await prisma.mailOrganization.findMany({ select: { slug: true, kind: true, status: true } })));
  const users = await safe("users", () => prisma.adminUser.findMany({ select: { id: true, department: true, tier: true, status: true, isTeamLead: true } }));
  if (Array.isArray(users)) {
    out.accountsByDepartmentStatus = tally(users, (u) => `${u.department || "NONE"}/${u.status}`);
    const rows = [];
    for (const u of users.filter((x) => x.status === "ACTIVE")) {
      const scopes = await safe("scopes", () => policy.marketingScopes(prisma, u, { env: process.env }));
      const karryam = Array.isArray(scopes) ? scopes.find((s) => s.slug === "karryam") : null;
      const explicit = await safe("grants", () => prisma.adminSectionGrant.count({ where: { adminUserId: u.id, module: "mail-marketing", revokedAt: null } }));
      rows.push({ department: u.department || "NONE", tier: u.tier, teamLead: u.isTeamLead, explicitMarketingGrants: explicit, brands: Array.isArray(scopes) ? scopes.map((s) => s.slug) : scopes, karryamView: !!karryam?.canView, karryamAuthor: !!karryam?.canAuthor, karryamApprove: !!karryam?.canApprove });
    }
    // Aggregated by shape so no individual is identifiable.
    const shapes = {};
    for (const r of rows) { const k = JSON.stringify(r); shapes[k] = (shapes[k] || 0) + 1; }
    out.activeAccountShapes = Object.entries(shapes).map(([k, n]) => ({ n, ...JSON.parse(k) })).sort((a, b) => b.n - a.n);
  } else out.users = users;
  console.log("CA_MKT_DIAG " + JSON.stringify(out));
  await prisma.$disconnect();
})().catch((e) => { console.log("CA_MKT_DIAG " + JSON.stringify({ fatal: String(e?.message || e).slice(0, 200) })); process.exit(0); });
