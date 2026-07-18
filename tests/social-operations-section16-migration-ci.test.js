const { execFileSync } = require("child_process");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  verifyMigrationManifest,
} = require("../scripts/social-operations/migration-manifest");
const {
  replayCreateTypeSafely,
} = require("../scripts/social-operations/db-replay-verify");
const {
  policyFailures,
} = require("../scripts/security/check-npm-audit-policy");

const ROOT = path.resolve(__dirname, "..");

function nodeScript(script) {
  return execFileSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("manual migration manifest protects order and checksums", () => {
  const result = verifyMigrationManifest();
  assert.equal(result.failures.length, 0);
  assert.equal(result.count, 14);
  assert.equal(
    result.manifest.migrations.some(
      (entry) => entry.file === "20260716_add_social_operations_section_5.sql",
    ),
    true,
  );
});

test("replay transform makes legacy CREATE TYPE statements idempotent without changing files", () => {
  const sql = "CREATE TYPE marketing_example_enum AS ENUM ('A', 'B');";
  const transformed = replayCreateTypeSafely(sql);
  assert.match(transformed, /EXCEPTION WHEN duplicate_object THEN NULL/);
  assert.match(transformed, /CREATE TYPE marketing_example_enum AS ENUM/);
});

test("migration safety and static Social Operations checks pass", () => {
  assert.match(
    nodeScript("scripts/social-operations/migration-safety-check.js"),
    /findings=0/,
  );
  assert.match(
    nodeScript("scripts/social-operations/static-code-safety-check.js"),
    /status=ok/,
  );
  assert.match(
    nodeScript("scripts/security/check-test-network-safety.js"),
    /status=ok/,
  );
});

test("CI uses the Admin database, prepares PostgreSQL artifacts before assertions, and keeps live providers disabled", () => {
  const source = fs.readFileSync(
    path.join(ROOT, ".github", "workflows", "social-operations-ci.yml"),
    "utf8",
  );
  assert.match(source, /postgres:16/);
  assert.match(source, /POSTGRES_DB:\s*cosmicforge_admin/);
  assert.match(source, /DATABASE_URL:\s*postgresql:\/\/postgres:postgres@localhost:5432\/cosmicforge_admin\b/);
  assert.match(source, /npm run db:admin:guard/);
  assert.match(source, /npx prisma db push --schema prisma\/schema\.prisma/);
  assert.match(source, /npm run db:admin:prepare/);
  assert.match(source, /npm run db:schema:assert/);
  assert.ok(source.indexOf("npm run db:admin:prepare") < source.indexOf("npm run db:schema:assert"));
  assert.doesNotMatch(source, /db:replay:ci/);
  assert.doesNotMatch(source, /cosmicforge_social_replay_/);
  assert.doesNotMatch(source, /\bCREATE\s+DATABASE\b/i);
  assert.doesNotMatch(source, /\bDROP\s+DATABASE\b/i);
  assert.doesNotMatch(source, /\bcreatedb\b/i);
  assert.doesNotMatch(source, /\bdropdb\b/i);
  assert.doesNotMatch(source, /db:manifest:generate/);
  assert.match(source, /npm run security:static-social/);
  assert.match(source, /npm run security:network-guard-static/);
  assert.match(source, /npm run test:network-guard/);
  assert.match(source, /TEST_NETWORK_GUARD_ENABLED:\s*"true"/);
  assert.match(source, /META_SOCIAL_ENABLED:\s*"false"/);
  assert.match(source, /SOCIAL_WORKERS_ENABLED:\s*"false"/);
});

test("production deployment is manual and protected, not push-to-main", () => {
  const source = fs.readFileSync(
    path.join(ROOT, ".github", "workflows", "production.yml"),
    "utf8",
  );
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /environment:\s*production/);
  assert.doesNotMatch(source, /push:\s*[\s\S]*main/);
});

test("dependency audit policy allows only advisory-specific documented moderate findings", () => {
  const allowedReport = {
    vulnerabilities: {
      prisma: {
        name: "prisma",
        severity: "moderate",
        isDirect: true,
        via: [{ url: "https://github.com/advisories/GHSA-92pp-h63x-v22m" }],
      },
    },
    metadata: { vulnerabilities: { total: 1, moderate: 1, high: 0, critical: 0 } },
  };
  assert.equal(policyFailures(allowedReport).failures.length, 0);

  const blockedReport = {
    vulnerabilities: {
      runtime: {
        name: "runtime-lib",
        severity: "high",
        isDirect: false,
        via: [{ url: "https://github.com/advisories/GHSA-0000-0000-0000" }],
      },
    },
  };
  assert.equal(policyFailures(blockedReport).failures.length, 1);
});
