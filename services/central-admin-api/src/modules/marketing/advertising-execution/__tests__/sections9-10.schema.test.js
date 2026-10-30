const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { OPERATION_STATES, PLAN_STATES } = require("../execution.constants");

const ROOT = path.resolve(__dirname, "../../../../../");
const schema = fs.readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
const migration = fs.readFileSync(path.join(ROOT, "prisma/manual-migrations/20260728_advertising_execution_sections9_10.sql"), "utf8");

const REQUIRED_MODELS = [
  "MarketingExecutionPlan", "MarketingExecutionPlanItem", "MarketingExecutionApproval",
  "MarketingExecutionApprovalEvent", "MarketingExecutionRun", "MarketingExecutionJob",
  "MarketingProviderOperation", "MarketingProviderOperationAttempt", "MarketingExecutionStateSnapshot",
  "MarketingExecutionValidationIssue", "MarketingExecutionReconciliation", "MarketingExecutionPolicy",
  "MarketingCreativePublication",
];

const REQUIRED_ENUMS = [
  "MarketingExecutionSourceType", "MarketingExecutionPlanStatus", "MarketingExecutionOperationType",
  "MarketingExecutionResourceType", "MarketingExecutionApprovalDecision", "MarketingExecutionRunStatus",
  "MarketingExecutionRunTrigger", "MarketingExecutionJobStatus", "MarketingExecutionOperationStatus",
  "MarketingExecutionOutcomeCertainty", "MarketingExecutionSnapshotKind",
  "MarketingExecutionReconciliationStatus", "MarketingExecutionPolicyScope",
  "MarketingExecutionPolicyValueType", "MarketingExecutionValidationSeverity",
  "MarketingCreativePublicationReviewStatus",
];

function block(kind, name) {
  const match = new RegExp(`${kind} ${name} \\{([\\s\\S]*?)\\n\\}`, "m").exec(schema);
  assert.ok(match, `${kind} ${name}`);
  return match[1];
}

test("all Section 9 models and enums exist in the admin Prisma schema", () => {
  for (const name of REQUIRED_MODELS) assert.match(schema, new RegExp(`model ${name} \\{`));
  for (const name of REQUIRED_ENUMS) assert.match(schema, new RegExp(`enum ${name} \\{`));
  assert.doesNotMatch(schema, /datasource\s+main|mainPrisma/);
});

test("new models map to physical snake_case tables", () => {
  for (const name of REQUIRED_MODELS) assert.match(block("model", name), /@@map\("[a-z0-9_]+"\)/, name);
});

test("domain and Prisma plan and operation states remain in parity", () => {
  const values = (name) => block("enum", name).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(values("MarketingExecutionPlanStatus").sort(), [...PLAN_STATES].sort());
  assert.deepEqual(values("MarketingExecutionOperationStatus").sort(), [...OPERATION_STATES].sort());
});

test("plan relations reuse existing connection, recommendation and AdminUser models", () => {
  const plan = block("model", "MarketingExecutionPlan");
  assert.match(plan, /marketing_recommendations\?/);
  assert.match(plan, /marketing_ad_platform_connections/);
  assert.match(plan, /AdminUser/);
  assert.match(plan, /onDelete: SetNull[^\n]+source_recommendation|sourceRecommendation[\s\S]+onDelete: SetNull/i);
  assert.equal((schema.match(/model marketing_ad_platform_connections \{/g) || []).length, 1);
  assert.equal((schema.match(/model marketing_recommendations \{/g) || []).length, 1);
  assert.equal((schema.match(/model marketing_creative_assets \{/g) || []).length, 1);
});

test("historical execution evidence foreign keys are restrictive", () => {
  for (const table of [
    "marketing_execution_plan_items", "marketing_execution_approvals", "marketing_execution_runs",
    "marketing_execution_jobs", "marketing_provider_operations", "marketing_provider_operation_attempts",
    "marketing_execution_state_snapshots", "marketing_execution_reconciliations", "marketing_creative_publications",
  ]) {
    const lines = migration.split(/\r?\n/).filter((line) => line.includes(`ALTER TABLE "${table}"`) || line.includes(`FK_${table}`));
    assert.ok(lines.length > 0, table);
  }
  assert.doesNotMatch(migration, /marketing_(?:execution|provider|creative_publications)[^;]+ON DELETE CASCADE/i);
});

test("required unique constraints and queue/query indexes are present", () => {
  for (const name of [
    "UQ_marketing_execution_plans_plan_number",
    "UQ_marketing_execution_plan_items_plan_sequence",
    "UQ_marketing_execution_plan_items_plan_client_ref",
    "UQ_marketing_execution_approvals_plan_version_approver",
    "UQ_marketing_provider_operations_key",
    "UQ_marketing_provider_operation_attempts_number",
    "UQ_marketing_creative_publications_revision",
    "IDX_marketing_execution_plans_connection_status_created",
    "IDX_marketing_execution_jobs_claim",
    "IDX_marketing_execution_jobs_expired_lease",
  ]) assert.match(migration, new RegExp(name));
});

test("policy scope uniqueness uses three correct PostgreSQL partial indexes", () => {
  assert.match(migration, /UQ_marketing_execution_policies_global_key[\s\S]+WHERE "scope" = 'GLOBAL'/);
  assert.match(migration, /UQ_marketing_execution_policies_platform_key[\s\S]+WHERE "scope" = 'PLATFORM'/);
  assert.match(migration, /UQ_marketing_execution_policies_connection_key[\s\S]+WHERE "scope" = 'CONNECTION'/);
});

test("database checks cover SHA-256, currency, versions and policy scope", () => {
  assert.match(migration, /CHK_marketing_execution_plans_currency/);
  assert.match(migration, /\^\[A-Z\]\{3\}\$/);
  assert.ok((migration.match(/\^\[a-f0-9\]\{64\}\$/g) || []).length >= 7);
  assert.match(migration, /CHK_marketing_execution_policies_scope/);
});

test("migration is additive and contains only the new domain DDL", () => {
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN|TYPE)\b|\bTRUNCATE\b/i);
  assert.doesNotMatch(migration, /CREATE TYPE "marketing_(?:creative|recommendation|ad_platform)/);
  assert.match(migration, /CREATE TABLE "marketing_execution_plans"/);
});

test("generated admin client contains every new model and no main client dependency", () => {
  const generated = require("../../../../generated/admin-client");
  for (const name of REQUIRED_MODELS) assert.equal(generated.Prisma.ModelName[name], name);
  const indexSource = fs.readFileSync(path.join(ROOT, "src/generated/admin-client/index.js"), "utf8");
  assert.doesNotMatch(indexSource, /mainPrisma|mainDatabase/);
});

test("money is not represented with floating point columns", () => {
  const combined = REQUIRED_MODELS.map((name) => block("model", name)).join("\n");
  assert.doesNotMatch(combined, /\bFloat\b/);
});
