#!/usr/bin/env node
"use strict";

// Prepare Karryam's business mail identities in the Central Admin database.
//
//   npm run mail:provision:karryam                          # dry run (default): reads only
//   npm run mail:provision:karryam -- --apply --actor=<adminUserId>
//   npm run mail:provision:karryam -- --org-kind=COMPANY    # only used if the org is created
//   --allow-remote   permit a non-local Admin DB host (staging), still refusing
//                    production-like hosts and any database other than
//                    cosmicforge_admin (scripts/social-operations/admin-database-target.js)
//
// Creates, when missing: organization `karryam`, domain `karryam.com`
// (pending provider verification), SHARED mailboxes info@, support@,
// marketing@, partnership@ and, when MAIL_RESERVED_SENDER_ADDRESSES lists it,
// the SYSTEM reservation no-reply@karryam.com (no mailbox). Re-running is
// safe. It never assigns people, grants senders, calls Resend or changes DNS.
// Writes go through the Mail admin service as --actor (an ACTIVE mail
// administrator), so the usual validation and audit records apply.
// Exit codes: 0 complete, 2 conflicts or work left (dry run), 1 error.

// Keep stdout pure JSON (dotenv 17 prints a banner on every config() call).
process.env.DOTENV_CONFIG_QUIET = process.env.DOTENV_CONFIG_QUIET || "true";
require("dotenv").config();

function parseArgs(argv) {
  const args = { apply: false, actor: null, allowRemote: false, orgKind: null };
  for (const raw of argv) {
    if (raw === "--apply") args.apply = true;
    else if (raw === "--allow-remote") args.allowRemote = true;
    else if (raw.startsWith("--actor=")) args.actor = raw.slice("--actor=".length) || null;
    else if (raw.startsWith("--org-kind=")) {
      const kind = raw.slice("--org-kind=".length).toUpperCase();
      if (!["BRAND", "COMPANY"].includes(kind)) throw new Error("--org-kind must be BRAND or COMPANY");
      args.orgKind = kind;
    } else throw new Error(`Unknown argument ${raw}`);
  }
  if (args.apply && !args.actor) throw new Error("--apply requires --actor=<adminUserId> (an ACTIVE mail administrator)");
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { validateAdminDatabaseTarget, formatTargetSummary } = require("../social-operations/admin-database-target");
  const target = validateAdminDatabaseTarget({ allowRemote: args.allowRemote });
  process.stderr.write(`mail-provision-karryam target ${formatTargetSummary(target)} mode=${args.apply ? "apply" : "dry-run"}\n`);

  const { loadMailConfig } = require("../../src/modules/mail/mail.config");
  const { prisma } = require("../../src/shared/config/database");
  const { createMailApplication } = require("../../src/modules/mail/application");
  const { provisionBrandMail, KARRYAM_MAIL_PLAN } = require("../../src/modules/mail/ops/brand-mail-provisioning");
  try {
    const [{ database }] = await prisma.$queryRawUnsafe("SELECT current_database() AS database");
    if (database !== target.database) throw new Error("connected database does not match the guarded target");
    const config = loadMailConfig(process.env);
    const mail = createMailApplication({ client: prisma, config, logger: { info() {}, warn() {}, error: (message) => process.stderr.write(`${message}\n`) } });
    const user = args.actor ? await prisma.adminUser.findUnique({ where: { id: args.actor }, select: { id: true, email: true, name: true, tier: true, status: true, department: true, isTeamLead: true } }) : null;
    if (args.actor && (!user || user.status !== "ACTIVE")) throw new Error("--actor must be an ACTIVE admin user");
    const plan = args.orgKind ? { ...KARRYAM_MAIL_PLAN, organization: { ...KARRYAM_MAIL_PLAN.organization, kind: args.orgKind } } : KARRYAM_MAIL_PLAN;
    const summary = await provisionBrandMail({ client: prisma, admin: mail.services.admin, config, user, plan, apply: args.apply, context: { requestId: `cli:provision-karryam:${Date.now()}`, ipAddress: "cli" } });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary.complete ? 0 : 2;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`mail-provision-karryam failed: ${error.code ? `${error.code} ` : ""}${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
