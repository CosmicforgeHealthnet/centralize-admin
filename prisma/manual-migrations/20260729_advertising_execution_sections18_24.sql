-- Advertising Execution Phase 3, Sections 18-24.
-- Additive review-state and account-scoped job leasing support.

ALTER TYPE "MarketingCreativePublicationReviewStatus" ADD VALUE IF NOT EXISTS 'LIMITED';
ALTER TYPE "MarketingCreativePublicationReviewStatus" ADD VALUE IF NOT EXISTS 'UNKNOWN';

CREATE UNIQUE INDEX "UQ_marketing_execution_plans_source_recommendation"
  ON "marketing_execution_plans"("source_recommendation_id")
  WHERE "source_recommendation_id" IS NOT NULL;

ALTER TABLE "marketing_execution_runs" ADD COLUMN "submission_key" CHAR(64);

WITH ranked_runs AS (
  SELECT
    "id",
    row_number() OVER (PARTITION BY "plan_id", "approval_fingerprint" ORDER BY "created_at", "id") AS duplicate_number
  FROM "marketing_execution_runs"
)
UPDATE "marketing_execution_runs" AS run
SET "submission_key" = encode(digest(
  run."plan_id"::text || ':' || run."approval_fingerprint" ||
  CASE WHEN ranked.duplicate_number = 1 THEN '' ELSE ':' || run."id"::text END,
  'sha256'
), 'hex')
FROM ranked_runs AS ranked
WHERE ranked."id" = run."id";

ALTER TABLE "marketing_execution_runs" ALTER COLUMN "submission_key" SET NOT NULL;

CREATE UNIQUE INDEX "UQ_marketing_execution_runs_submission_key"
  ON "marketing_execution_runs"("submission_key");

ALTER TABLE "marketing_execution_jobs"
  ADD COLUMN "connection_id" TEXT,
  ADD COLUMN "platform" "marketing_ad_platform_enum",
  ADD COLUMN "account_external_id" VARCHAR(255);

UPDATE "marketing_execution_jobs" AS job
SET
  "connection_id" = plan."connection_id",
  "platform" = plan."platform",
  "account_external_id" = plan."account_external_id"
FROM "marketing_execution_runs" AS run
JOIN "marketing_execution_plans" AS plan ON plan."id" = run."plan_id"
WHERE job."run_id" = run."id";

ALTER TABLE "marketing_execution_jobs"
  ALTER COLUMN "connection_id" SET NOT NULL,
  ALTER COLUMN "platform" SET NOT NULL,
  ALTER COLUMN "account_external_id" SET NOT NULL;

ALTER TABLE "marketing_execution_jobs"
  ADD CONSTRAINT "FK_marketing_execution_jobs_connection"
  FOREIGN KEY ("connection_id") REFERENCES "marketing_ad_platform_connections"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE INDEX "IDX_marketing_execution_jobs_connection_status"
  ON "marketing_execution_jobs"("connection_id", "status", "created_at");

WITH ranked_active_jobs AS (
  SELECT
    "id",
    row_number() OVER (PARTITION BY "connection_id" ORDER BY "priority" DESC, "created_at", "id") AS active_number
  FROM "marketing_execution_jobs"
  WHERE "status" IN ('CLAIMED', 'RUNNING')
)
UPDATE "marketing_execution_jobs" AS job
SET
  "status" = 'RETRY_SCHEDULED',
  "next_attempt_at" = CURRENT_TIMESTAMP,
  "lease_owner" = NULL,
  "lease_expires_at" = NULL
FROM ranked_active_jobs AS ranked
WHERE ranked."id" = job."id" AND ranked.active_number > 1;

CREATE UNIQUE INDEX "UQ_marketing_execution_jobs_active_connection"
  ON "marketing_execution_jobs"("connection_id")
  WHERE "status" IN ('CLAIMED', 'RUNNING');

ALTER TABLE "marketing_execution_jobs"
  ADD CONSTRAINT "CHK_marketing_execution_jobs_account_external_id"
  CHECK (length(btrim("account_external_id")) BETWEEN 1 AND 255);
