"use strict";

// Section 29 — Docs and migrations mandatory suite (route inventory, schema
// assertions, manifest, replay, no drift). Full disposable-database replay and
// drift verification run through db:replay:verify / db:schema:assert; this
// suite proves runtime route inventory, manifest integrity, migration safety
// and documentation consistency without touching any database.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createExecutionRouter } = require("../execution.routes");
const { REQUIRED_TABLES, REQUIRED_INDEXES, REQUIRED_ENUMS, createExecutionSchemaAssertion } = require("../execution-schema-assertion.service");
const { verifyManifest, calculateMigrationChecksum, loadMigrationManifest } = require("../../../../../scripts/social-operations/migration-manifest");

const ROOT = path.join(__dirname, "..", "..", "..", "..", "..");
const MIGRATION_DIR = path.join(ROOT, "prisma", "manual-migrations");

const EXPECTED_BUSINESS_ROUTES = [
  "GET /capabilities", "GET /policies", "PATCH /policies", "POST /overrides",
  "POST /plans", "GET /plans", "GET /plans/:id", "PATCH /plans/:id", "DELETE /plans/:id",
  "POST /plans/:id/validate", "POST /plans/:id/submit", "POST /plans/:id/approve",
  "POST /plans/:id/reject", "POST /plans/:id/revoke-approval", "POST /plans/:id/queue",
  "POST /plans/:id/cancel", "POST /plans/:id/create-compensation",
  "GET /runs", "GET /runs/:id", "GET /operations/:id", "POST /operations/:id/retry",
  "GET /drift", "POST /drift/:id/acknowledge", "POST /recommendations/:id/create-plan",
  "POST /creatives/:id/publications", "GET /creatives/:id/publications",
];

function routeInventory(router) {
  const routes = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      routes.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return routes;
}

test("29-DOCS runtime route inventory: 25 business endpoints plus publications listing and authenticated health", () => {
  const noop = () => (req, res, next) => next();
  const router = createExecutionRouter({ authenticateMiddleware: (req, res, next) => next(), sectionGate: noop, fineGate: noop });
  const routes = routeInventory(router);
  // Every documented business route is mounted with the exact method.
  for (const route of EXPECTED_BUSINESS_ROUTES) {
    assert.ok(routes.includes(route), `expected route ${route} to be mounted`);
  }
  // The Section 25 surface is 25 business endpoints + the publications list + health.
  assert.equal(EXPECTED_BUSINESS_ROUTES.length, 26);
  assert.ok(routes.includes("GET /health"), "authenticated health endpoint is mounted");
  // Mounted exactly once: no duplicate method+path pair anywhere.
  const seen = new Set();
  for (const route of routes) {
    assert.equal(seen.has(route), false, `duplicate route registration: ${route}`);
    seen.add(route);
  }
  // No direct execute endpoint and no undocumented high-risk execution route.
  assert.equal(routes.some((route) => /execute/i.test(route)), false, "no direct provider-execute endpoint may exist");
  for (const route of routes.filter((entry) => !EXPECTED_BUSINESS_ROUTES.includes(entry) && entry !== "GET /health")) {
    // Remaining routes are the documented Sections 6-24 compatibility surface.
    assert.ok([
      "GET /lifecycle", "POST /preflight", "POST /creatives", "GET /creatives/:id",
      "POST /creatives/:id/sync-review", "POST /recommendations/:recommendationId/draft-plan",
      "GET /runs/:runId/status", "POST /jobs/:jobId/dead-letter-review",
      "GET /reconciliations/:id", "POST /compensations",
    ].includes(route), `undocumented route mounted: ${route}`);
  }
});

test("29-DOCS the application mounts the execution router once under the versioned marketing base path", () => {
  const appSource = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  const mounts = appSource.match(/advertising-execution/g) || [];
  assert.ok(appSource.includes("/api/v1/marketing/advertising-execution"), "base path is exact");
  assert.equal((appSource.match(/\/api\/v1\/marketing\/advertising-execution/g) || []).length, 1, "the base path is mounted exactly once");
  assert.ok(mounts.length >= 1);
});

test("29-DOCS schema assertion inventory covers every required durable object and fails closed when absent", async () => {
  // Inventory includes the queue idempotency, retry linkage, cancellation,
  // compensation lineage and emergency-override objects.
  for (const tableName of ["marketing_execution_jobs", "marketing_execution_retry_reviews", "marketing_execution_compensation_links", "marketing_execution_emergency_overrides", "marketing_execution_approval_events"]) {
    assert.ok(REQUIRED_TABLES.includes(tableName), tableName);
  }
  for (const indexName of ["UQ_marketing_execution_jobs_submission_identity", "UQ_marketing_provider_operations_key", "UQ_marketing_execution_retry_reviews_key", "IDX_marketing_execution_jobs_cancellation_request", "IDX_marketing_execution_overrides_active"]) {
    assert.ok(REQUIRED_INDEXES.includes(indexName), indexName);
  }
  assert.ok(REQUIRED_ENUMS.includes("MarketingExecutionOutcomeCertainty"));
  // A database missing one required object reports not-ready with exact counts.
  const partial = createExecutionSchemaAssertion({
    client: {
      $queryRawUnsafe: async (sql) => {
        if (sql.includes("pg_tables")) return REQUIRED_TABLES.slice(1).map((name) => ({ name }));
        if (sql.includes("pg_indexes")) return REQUIRED_INDEXES.map((name) => ({ name }));
        return REQUIRED_ENUMS.map((name) => ({ name }));
      },
    },
  });
  const report = await partial.inspect({ force: true });
  assert.equal(report.ready, false);
  assert.equal(report.category, "SCHEMA");
  assert.equal(report.missingCounts.tables, 1);
  // A database error is DATABASE, never a silent pass.
  const failing = createExecutionSchemaAssertion({ client: { $queryRawUnsafe: async () => { throw new Error("connection refused"); } } });
  assert.equal((await failing.inspect({ force: true })).category, "DATABASE");
});

test("29-DOCS the manifest lists every advertising-execution migration with canonical checksums and no drift", () => {
  const manifest = loadMigrationManifest();
  const listed = new Map(manifest.migrations.map((entry) => [entry.file, entry.sha256]));
  const onDisk = fs.readdirSync(MIGRATION_DIR).filter((file) => file.endsWith(".sql"));
  const advertisingMigrations = onDisk.filter((file) => file.includes("advertising_execution"));
  assert.ok(advertisingMigrations.length >= 5, "all five advertising-execution migrations exist");
  // Every on-disk migration is listed exactly once; nothing is missing or duplicated.
  assert.equal(manifest.migrations.length, onDisk.length, "manifest and directory agree");
  assert.equal(new Set(manifest.migrations.map((entry) => entry.file)).size, manifest.migrations.length, "no duplicate manifest entries");
  for (const file of advertisingMigrations) {
    assert.ok(listed.has(file), `${file} must be listed in the manifest`);
    // Checksums are canonical (utf8, no BOM, LF, single final newline) so the
    // verification is line-ending independent across platforms.
    assert.equal(listed.get(file), calculateMigrationChecksum(path.join(MIGRATION_DIR, file)), `${file} has been modified after being recorded`);
  }
  assert.equal(manifest.checksumCanonicalization, "utf8-no-bom-lf-one-final-newline");
  // Verification never regenerates: verifyManifest is read-only and passes.
  const before = fs.readFileSync(path.join(MIGRATION_DIR, "manifest.json"), "utf8");
  const result = verifyManifest();
  const after = fs.readFileSync(path.join(MIGRATION_DIR, "manifest.json"), "utf8");
  assert.deepEqual(result.failures, [], "manifest verification reports zero failures");
  assert.equal(result.count, onDisk.length);
  assert.equal(before, after, "verification does not rewrite the manifest");
});

test("29-DOCS advertising-execution migrations are additive and ordered for empty-database replay", () => {
  const manifest = loadMigrationManifest();
  const files = fs.readdirSync(MIGRATION_DIR).filter((file) => file.includes("advertising_execution")).sort();
  // Ordered execution: manifest order agrees with the date-prefixed file names.
  const manifestOrder = manifest.migrations.filter((entry) => entry.file.includes("advertising_execution")).sort((a, b) => a.order - b.order).map((entry) => entry.file);
  assert.deepEqual(manifestOrder, files, "manifest replay order matches the date-prefixed order");
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATION_DIR, file), "utf8");
    // No destructive statements: additive DDL only, so replay from empty and
    // historical backfills cannot destroy execution evidence.
    assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i, `${file} must not drop tables`);
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i, `${file} must not truncate`);
    assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i, `${file} must not delete rows`);
    assert.doesNotMatch(sql, /\bDROP\s+COLUMN\b/i, `${file} must not drop columns`);
  }
});

test("29-DOCS documentation inventory: error codes, endpoints and the live-validation matrix stay current", () => {
  const errorDocs = fs.readFileSync(path.join(ROOT, "docs", "advertising-execution-error-codes.md"), "utf8");
  const { STABLE_ERROR_DEFINITIONS } = require("../execution.errors");
  for (const [code, definition] of Object.entries(STABLE_ERROR_DEFINITIONS)) {
    assert.ok(errorDocs.includes(code), `error code ${code} must be documented`);
    assert.ok(errorDocs.includes(`| ${definition.status} |`) || errorDocs.includes(`${definition.status}`), `status for ${code} documented`);
  }
  const handoff = fs.readFileSync(path.join(ROOT, "docs", "advertising-execution-api-handoff.md"), "utf8");
  assert.ok(handoff.includes("/api/v1/marketing/advertising-execution"));
  // The live-validation matrix keeps every provider row NOT_LIVE_VALIDATED.
  const matrix = fs.readFileSync(path.join(ROOT, "docs", "advertising-execution-live-validation-matrix.md"), "utf8");
  assert.match(matrix, /NOT_LIVE_VALIDATED/);
  assert.doesNotMatch(matrix, /\|\s*LIVE_VALIDATED\s*\|/, "no provider row may claim LIVE_VALIDATED");
  // The runbook documents the Section 29 test commands.
  const runbook = fs.readFileSync(path.join(ROOT, "docs", "advertising-execution-operations-runbook.md"), "utf8");
  assert.ok(runbook.includes("test:advertising-execution:section29"), "runbook documents the Section 29 suite command");
  assert.ok(runbook.includes("NOT_LIVE_VALIDATED"), "runbook states the live status");
});
