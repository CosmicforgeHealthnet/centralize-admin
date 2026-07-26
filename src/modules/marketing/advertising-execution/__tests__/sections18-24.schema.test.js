const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../../../../");
const schema = fs.readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
const migration = fs.readFileSync(path.join(ROOT, "prisma/manual-migrations/20260729_advertising_execution_sections18_24.sql"), "utf8");
const remediation = fs.readFileSync(path.join(ROOT, "prisma/manual-migrations/20260730_advertising_execution_sections18_24_remediation.sql"), "utf8");
const jobRepository = fs.readFileSync(path.join(ROOT, "src/modules/marketing/advertising-execution/jobs/execution-job.repository.js"), "utf8");

test("creative provider review enum includes LIMITED and UNKNOWN without removing historical states", () => {
  const block = /enum MarketingCreativePublicationReviewStatus \{([\s\S]*?)\n\}/.exec(schema)?.[1] || "";
  for (const state of ["DRAFT", "PENDING_REVIEW", "APPROVED", "REJECTED", "LIMITED", "UNKNOWN", "PUBLISHED", "FAILED"]) assert.match(block, new RegExp(`\\b${state}\\b`));
  assert.match(migration, /ADD VALUE IF NOT EXISTS 'LIMITED'/);
  assert.match(migration, /ADD VALUE IF NOT EXISTS 'UNKNOWN'/);
});

test("one active recommendation plan is enforced while terminal history remains", () => {
  assert.doesNotMatch(schema, /sourceRecommendationId\s+String\?\s+@unique/);
  assert.match(remediation, /UQ_marketing_execution_plans_active_source_recommendation/);
  assert.match(remediation, /status" IN \('DRAFT', 'VALIDATING', 'VALIDATED', 'PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'EXECUTING'\)/);
});

test("duplicate approved plan submission resolves to one durable run", () => {
  assert.match(schema, /submissionKey\s+String\s+@unique\(map: "UQ_marketing_execution_runs_submission_key"\)/);
  assert.match(migration, /UQ_marketing_execution_runs_submission_key/);
  assert.match(migration, /row_number\(\) OVER \(PARTITION BY "plan_id", "approval_fingerprint"/);
  assert.match(migration, /run\."plan_id"::text \|\| ':' \|\| run\."approval_fingerprint"/);
});

test("durable jobs persist provider account scope and serialize the exact provider account", () => {
  const block = /model MarketingExecutionJob \{([\s\S]*?)\n\}/.exec(schema)?.[1] || "";
  assert.match(block, /connectionId\s+String/);
  assert.match(block, /platform\s+marketing_ad_platform_enum/);
  assert.match(block, /accountExternalId\s+String/);
  assert.match(jobRepository, /FOR UPDATE OF job SKIP LOCKED/);
  assert.match(remediation, /UQ_marketing_execution_jobs_active_account/);
  assert.match(remediation, /"platform", "connection_id", "account_external_id"/);
  assert.match(migration, /ranked_active_jobs/);
  assert.match(migration, /WHERE "status" IN \('CLAIMED', 'RUNNING'\)/);
  assert.match(migration, /FK_marketing_execution_jobs_connection/);
});

test("Sections 18-24 migration is additive and preserves execution history", () => {
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN|TYPE)\b|\bTRUNCATE\b|ON DELETE CASCADE/i);
  assert.match(migration, /UPDATE "marketing_execution_jobs" AS job/);
  assert.match(migration, /ALTER COLUMN "connection_id" SET NOT NULL/);
});
