#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { prisma } = require("../../src/shared/config/database");
const {
  evaluateLegacySocialBackfill,
  markdownReport,
} = require("../../src/modules/marketing/social-operations/migration/legacy-social-backfill.mapper");

const REPORT_DIR = path.resolve(process.cwd(), "reports/social-operations");
const JSON_REPORT_PATH = path.join(REPORT_DIR, "legacy-migration-reconciliation.json");
const MARKDOWN_REPORT_PATH = path.join(REPORT_DIR, "legacy-migration-reconciliation.md");

function parseDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    database: parsed.pathname.replace(/^\//, ""),
  };
}

function assertLocalDatabase() {
  const target = parseDatabaseUrl();
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(target.host) || target.database !== "cosmicforge_admin") {
    throw new Error(
      `Refusing legacy backfill outside local cosmicforge_admin (host=${target.host}, database=${target.database})`,
    );
  }
  return target;
}

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    dryRun: args.has("--dry-run") || (!args.has("--apply-check") && !args.has("--report-only")),
    applyCheck: args.has("--apply-check"),
    reportOnly: args.has("--report-only"),
    validateMedia: args.has("--validate-media"),
  };
}

async function acquireLock() {
  const rows = await prisma.$queryRawUnsafe(
    "SELECT pg_try_advisory_lock(hashtext('social_operations_legacy_marketing_social_backfill')) AS locked",
  );
  if (!rows?.[0]?.locked) throw new Error("Another legacy social backfill is already running");
}

async function releaseLock() {
  await prisma.$queryRawUnsafe(
    "SELECT pg_advisory_unlock(hashtext('social_operations_legacy_marketing_social_backfill'))",
  );
}

async function readInputs() {
  const [legacyRows, legacyAccounts, adminUsers, existingSocialPosts] = await Promise.all([
    prisma.marketing_social_posts.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.marketing_social_accounts.findMany({
      select: {
        id: true,
        platform: true,
        username: true,
        encryptedPassword: true,
        credentialsSaved: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.adminUser.findMany({ select: { id: true } }),
    prisma.socialPost.findMany({
      where: { legacySourceId: { not: null } },
      select: { legacySourceId: true },
    }),
  ]);

  return {
    legacyRows,
    legacyAccounts,
    adminUsers,
    existingLegacySourceIds: existingSocialPosts
      .map((row) => row.legacySourceId)
      .filter(Boolean),
  };
}

function writeReports(report) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(MARKDOWN_REPORT_PATH, markdownReport(report));
}

async function main() {
  const mode = parseArgs(process.argv);
  const target = assertLocalDatabase();
  await prisma.$connect();
  await acquireLock();
  try {
    const inputs = await readInputs();
    const report = evaluateLegacySocialBackfill({
      ...inputs,
      migrationReferenceTime: new Date(),
      mediaOptions: {
        validateMedia: mode.validateMedia,
        nodeEnv: process.env.NODE_ENV || "development",
      },
    });
    report.mode = mode.applyCheck ? "apply-check" : mode.reportOnly ? "report-only" : "dry-run";
    report.databaseTarget = target;
    writeReports(report);
    console.log(
      JSON.stringify(
        {
          mode: report.mode,
          database: target.database,
          host: target.host,
          reportPath: JSON_REPORT_PATH,
          markdownReportPath: MARKDOWN_REPORT_PATH,
          checksum: report.reportChecksum,
          counts: report.counts,
          blockingIssueCount: report.blockingIssueCount,
        },
        null,
        2,
      ),
    );
    if (mode.dryRun && report.blockingIssueCount > 0) {
      process.exitCode = 1;
    }
  } finally {
    await releaseLock().catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  await prisma.$disconnect().catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
});
