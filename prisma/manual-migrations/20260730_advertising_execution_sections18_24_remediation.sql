-- Advertising Execution Phase 3, Sections 18-24 remediation.
-- Durable creative validation, account discovery/locking, recovery,
-- reconciliation work, dead-letter review, and relational compensation.

CREATE TYPE "MarketingCreativeReuseClassification" AS ENUM (
  'ACCOUNT_REUSABLE', 'IDENTITY_SCOPED', 'CAMPAIGN_SCOPED', 'GROUP_SCOPED',
  'MUST_RECREATE', 'BLOCKED_REVIEW', 'BLOCKED_EXPIRED', 'BLOCKED_IDENTITY_CHANGED'
);
CREATE TYPE "MarketingMalwareScanStatus" AS ENUM ('NOT_CONFIGURED', 'PENDING', 'CLEAN', 'INFECTED', 'ERROR', 'UNKNOWN');
CREATE TYPE "MarketingTargetingAvailability" AS ENUM ('AVAILABLE', 'UNAVAILABLE', 'EXPIRED', 'UNKNOWN');
CREATE TYPE "MarketingExecutionRecoveryOutcome" AS ENUM ('SAFE_TO_RETRY', 'RECONCILIATION_REQUIRED', 'NON_RETRYABLE', 'ATTEMPTS_EXHAUSTED');
CREATE TYPE "MarketingDeadLetterReviewStatus" AS ENUM ('PENDING_REVIEW', 'REVIEWED');
CREATE TYPE "MarketingDeadLetterDecision" AS ENUM ('KEEP_DEAD_LETTER', 'CREATE_RETRY_JOB', 'CREATE_COMPENSATION_DRAFT', 'MARK_RECONCILIATION_ONLY');
CREATE TYPE "MarketingReconciliationJobStatus" AS ENUM ('PENDING', 'CLAIMED', 'RUNNING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'ESCALATED', 'FAILED');
CREATE TYPE "MarketingReconciliationReason" AS ENUM ('UNKNOWN_PROVIDER_OUTCOME', 'PROVIDER_SUCCESS_LOCAL_PERSISTENCE_FAILED', 'POST_WRITE_VERIFICATION', 'EXTERNAL_CHANGE_CHECK', 'COMPENSATION_VERIFICATION');
ALTER TYPE "MarketingExecutionJobStatus" ADD VALUE IF NOT EXISTS 'RECONCILING';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_CREATIVE_REVISION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_CREATIVE_REVISION_REUSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_CREATIVE_REVIEW_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_RECOMMENDATION_EXECUTION_DRAFT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_EXECUTION_QUEUED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_EXECUTION_LEASE_RECOVERED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_EXECUTION_DEAD_LETTER_REVIEWED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_EXECUTION_POLICY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_EXECUTION_KILL_SWITCH_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_RECONCILIATION_VERIFIED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_RECONCILIATION_EXTERNAL_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_RECONCILIATION_DRIFTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_RECONCILIATION_UNKNOWN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_RECONCILIATION_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_RECONCILIATION_COMPENSATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_COMPENSATION_DRAFT_CREATED';

DROP INDEX IF EXISTS "UQ_marketing_execution_plans_source_recommendation";
CREATE UNIQUE INDEX "UQ_marketing_execution_plans_active_source_recommendation"
  ON "marketing_execution_plans"("source_recommendation_id")
  WHERE "source_recommendation_id" IS NOT NULL
    AND "status" IN ('DRAFT', 'VALIDATING', 'VALIDATED', 'PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'EXECUTING');

ALTER TABLE "marketing_execution_runs" ADD COLUMN "approved_plan_version" INTEGER;
UPDATE "marketing_execution_runs" AS run
SET "approved_plan_version" = plan."version"
FROM "marketing_execution_plans" AS plan
WHERE plan."id" = run."plan_id";
ALTER TABLE "marketing_execution_runs" ALTER COLUMN "approved_plan_version" SET NOT NULL;

ALTER TABLE "marketing_execution_jobs"
  ADD COLUMN "submission_identity" CHAR(64),
  ADD COLUMN "recovery_reason" VARCHAR(255),
  ADD COLUMN "previous_lease_owner" VARCHAR(255),
  ADD COLUMN "recovered_at" TIMESTAMP(6),
  ADD COLUMN "recovery_outcome" "MarketingExecutionRecoveryOutcome",
  ADD COLUMN "reconciliation_required" BOOLEAN NOT NULL DEFAULT false;
UPDATE "marketing_execution_jobs"
SET "submission_identity" = encode(digest("run_id"::text || ':PRIMARY', 'sha256'), 'hex');
ALTER TABLE "marketing_execution_jobs" ALTER COLUMN "submission_identity" SET NOT NULL;
CREATE UNIQUE INDEX "UQ_marketing_execution_jobs_submission_identity" ON "marketing_execution_jobs"("submission_identity");

-- Replace the earlier connection-only guard with the exact provider/account boundary.
DROP INDEX IF EXISTS "UQ_marketing_execution_jobs_active_connection";
CREATE UNIQUE INDEX "UQ_marketing_execution_jobs_active_account"
  ON "marketing_execution_jobs"("platform", "connection_id", "account_external_id")
  WHERE "status" IN ('CLAIMED', 'RUNNING');

ALTER TABLE "marketing_provider_operations" ADD COLUMN "idempotency_identity" JSON;
UPDATE "marketing_provider_operations" AS operation
SET "idempotency_identity" = json_build_object(
  'version', 2,
  'provider', plan."platform"::text,
  'connectionId', plan."connection_id",
  'accountExternalId', plan."account_external_id",
  'approvedPlanId', plan."id"::text,
  'approvedPlanVersion', run."approved_plan_version",
  'itemId', item."id"::text,
  'operationType', item."operation_type"::text,
  'resourceType', item."resource_type"::text,
  'materialHash', item."material_hash"
)
FROM "marketing_execution_runs" AS run
JOIN "marketing_execution_plans" AS plan ON plan."id" = run."plan_id"
JOIN "marketing_execution_plan_items" AS item ON item."plan_id" = plan."id"
WHERE run."id" = operation."run_id" AND item."id" = operation."item_id";
ALTER TABLE "marketing_provider_operations" ALTER COLUMN "idempotency_identity" SET NOT NULL;
ALTER TABLE "marketing_provider_operation_attempts" ADD COLUMN "retry_decision" JSON;

ALTER TABLE "marketing_execution_reconciliations"
  ADD COLUMN "previous_verified_hash" CHAR(64),
  ADD COLUMN "current_hash" CHAR(64),
  ADD COLUMN "provider_version" VARCHAR(64),
  ADD COLUMN "external_actor" VARCHAR(255);

ALTER TABLE "marketing_creative_publications"
  ADD COLUMN "account_external_id" VARCHAR(255),
  ADD COLUMN "api_version" VARCHAR(64),
  ADD COLUMN "creative_format" VARCHAR(100),
  ADD COLUMN "identity_reference" VARCHAR(512),
  ADD COLUMN "instagram_identity_reference" VARCHAR(512),
  ADD COLUMN "campaign_external_id" VARCHAR(512),
  ADD COLUMN "group_external_id" VARCHAR(512),
  ADD COLUMN "review_code" VARCHAR(100),
  ADD COLUMN "review_message" VARCHAR(1000),
  ADD COLUMN "review_checked_at" TIMESTAMP(6),
  ADD COLUMN "review_provider_version" VARCHAR(64),
  ADD COLUMN "content_projection" JSON,
  ADD COLUMN "reuse_classification" "MarketingCreativeReuseClassification",
  ADD COLUMN "source_media_checksum" CHAR(64),
  ADD COLUMN "malware_status" "MarketingMalwareScanStatus",
  ADD COLUMN "created_by_admin_user_id" TEXT;

UPDATE "marketing_creative_publications" AS publication
SET
  "account_external_id" = asset."accountExternalId",
  "api_version" = COALESCE(publication."publication_metadata"->>'apiVersion', 'LEGACY_UNKNOWN'),
  "creative_format" = COALESCE(publication."publication_metadata"->>'format', asset."type"::text),
  "identity_reference" = publication."publication_metadata"->>'identityReference',
  "content_projection" = json_build_object('legacyContentHash', publication."content_hash"),
  "reuse_classification" = 'MUST_RECREATE',
  "source_media_checksum" = COALESCE(NULLIF(publication."publication_metadata"->>'sourceMediaChecksum', ''), publication."content_hash"),
  "malware_status" = 'NOT_CONFIGURED',
  "created_by_admin_user_id" = (
    SELECT plan."created_by_admin_user_id"
    FROM "marketing_execution_plans" AS plan
    WHERE plan."connection_id" = publication."connection_id"
    ORDER BY plan."created_at"
    LIMIT 1
  )
FROM "marketing_creative_assets" AS asset
WHERE asset."id" = publication."creative_asset_id";

UPDATE "marketing_creative_publications"
SET "created_by_admin_user_id" = (
  SELECT admin."id" FROM "admin_users" AS admin ORDER BY admin."createdAt" LIMIT 1
)
WHERE "created_by_admin_user_id" IS NULL;

-- Empty databases need no backfill fallback. Existing publications without an execution
-- plan are intentionally blocked until an accountable Admin author can be assigned.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "marketing_creative_publications" WHERE "created_by_admin_user_id" IS NULL) THEN
    RAISE EXCEPTION 'Creative publication author backfill requires an Admin actor';
  END IF;
END $$;

ALTER TABLE "marketing_creative_publications"
  ALTER COLUMN "account_external_id" SET NOT NULL,
  ALTER COLUMN "api_version" SET NOT NULL,
  ALTER COLUMN "creative_format" SET NOT NULL,
  ALTER COLUMN "content_projection" SET NOT NULL,
  ALTER COLUMN "reuse_classification" SET NOT NULL,
  ALTER COLUMN "source_media_checksum" SET NOT NULL,
  ALTER COLUMN "malware_status" SET NOT NULL,
  ALTER COLUMN "created_by_admin_user_id" SET NOT NULL;
ALTER TABLE "marketing_creative_publications"
  ADD CONSTRAINT "FK_marketing_creative_publications_created_by"
  FOREIGN KEY ("created_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
DROP INDEX IF EXISTS "IDX_marketing_creative_publications_content_hash";
CREATE INDEX "IDX_marketing_creative_publications_scoped_hash" ON "marketing_creative_publications"("platform", "connection_id", "account_external_id", "content_hash");
CREATE INDEX "IDX_marketing_creative_publications_media_dedupe" ON "marketing_creative_publications"("source_media_checksum", "platform", "connection_id", "account_external_id");

CREATE TABLE "marketing_creative_media_validation_evidence" (
  "id" UUID NOT NULL, "creative_asset_id" TEXT NOT NULL,
  "publication_id" UUID NOT NULL, "checksum_sha256" CHAR(64) NOT NULL,
  "detected_mime" VARCHAR(100) NOT NULL, "byte_size" INTEGER NOT NULL,
  "width" INTEGER, "height" INTEGER, "duration_ms" INTEGER, "frame_count" INTEGER,
  "codec" VARCHAR(100), "container" VARCHAR(100), "has_audio" BOOLEAN,
  "has_transparency" BOOLEAN, "malware_status" "MarketingMalwareScanStatus" NOT NULL,
  "scanner_evidence" JSON NOT NULL, "validated_at" TIMESTAMP(6) NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketing_creative_media_validation_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_creative_media_evidence_asset" FOREIGN KEY ("creative_asset_id") REFERENCES "marketing_creative_assets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_creative_media_evidence_publication" FOREIGN KEY ("publication_id") REFERENCES "marketing_creative_publications"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "IDX_marketing_creative_media_evidence_checksum" ON "marketing_creative_media_validation_evidence"("checksum_sha256", "publication_id");

CREATE TABLE "marketing_creative_publication_review_events" (
  "id" UUID NOT NULL, "publication_id" UUID NOT NULL,
  "previous_status" "MarketingCreativePublicationReviewStatus" NOT NULL,
  "status" "MarketingCreativePublicationReviewStatus" NOT NULL,
  "provider_code" VARCHAR(100), "provider_message" VARCHAR(1000),
  "provider_version" VARCHAR(64) NOT NULL, "checked_at" TIMESTAMP(6) NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketing_creative_publication_review_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_creative_review_events_publication" FOREIGN KEY ("publication_id") REFERENCES "marketing_creative_publications"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "IDX_marketing_creative_review_events_timeline" ON "marketing_creative_publication_review_events"("publication_id", "checked_at");

CREATE TABLE "marketing_targeting_discovery" (
  "id" UUID NOT NULL, "platform" "marketing_ad_platform_enum" NOT NULL,
  "api_version" VARCHAR(64) NOT NULL, "connection_id" TEXT NOT NULL,
  "account_external_id" VARCHAR(255) NOT NULL, "targeting_type" VARCHAR(64) NOT NULL,
  "normalized_identifier" VARCHAR(512) NOT NULL, "native_identifier" VARCHAR(512) NOT NULL,
  "display_name" VARCHAR(512) NOT NULL, "parent_identifier" VARCHAR(512),
  "metadata" JSON NOT NULL, "availability" "MarketingTargetingAvailability" NOT NULL,
  "content_hash" CHAR(64) NOT NULL, "resolved_at" TIMESTAMP(6) NOT NULL,
  "expires_at" TIMESTAMP(6) NOT NULL, "last_validated_at" TIMESTAMP(6) NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketing_targeting_discovery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_targeting_discovery_connection" FOREIGN KEY ("connection_id") REFERENCES "marketing_ad_platform_connections"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "UQ_marketing_targeting_discovery_scope_identifier" ON "marketing_targeting_discovery"("platform", "api_version", "connection_id", "account_external_id", "targeting_type", "normalized_identifier");
CREATE INDEX "IDX_marketing_targeting_discovery_lookup" ON "marketing_targeting_discovery"("platform", "connection_id", "account_external_id", "targeting_type", "expires_at");
CREATE INDEX "IDX_marketing_targeting_discovery_expiry" ON "marketing_targeting_discovery"("expires_at", "availability");

CREATE TABLE "marketing_execution_account_locks" (
  "key" VARCHAR(900) NOT NULL, "platform" "marketing_ad_platform_enum" NOT NULL,
  "connection_id" TEXT NOT NULL, "account_external_id" VARCHAR(255) NOT NULL,
  "owner" VARCHAR(255) NOT NULL, "expires_at" TIMESTAMP(6) NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketing_execution_account_locks_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "FK_marketing_execution_account_locks_connection" FOREIGN KEY ("connection_id") REFERENCES "marketing_ad_platform_connections"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "UQ_marketing_execution_account_locks_scope" ON "marketing_execution_account_locks"("platform", "connection_id", "account_external_id");
CREATE INDEX "IDX_marketing_execution_account_locks_expiry" ON "marketing_execution_account_locks"("expires_at");

CREATE TABLE "marketing_execution_dead_letter_reviews" (
  "id" UUID NOT NULL, "job_id" UUID NOT NULL,
  "status" "MarketingDeadLetterReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "reviewer_admin_user_id" TEXT, "reason" VARCHAR(2000), "decision" "MarketingDeadLetterDecision",
  "action_job_id" UUID, "reviewed_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketing_execution_dead_letter_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_execution_dead_letter_reviews_job" FOREIGN KEY ("job_id") REFERENCES "marketing_execution_jobs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_execution_dead_letter_reviews_reviewer" FOREIGN KEY ("reviewer_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "UQ_marketing_execution_dead_letter_reviews_job" ON "marketing_execution_dead_letter_reviews"("job_id");
CREATE INDEX "IDX_marketing_execution_dead_letter_reviews_status" ON "marketing_execution_dead_letter_reviews"("status", "created_at");

CREATE TABLE "marketing_execution_reconciliation_jobs" (
  "id" UUID NOT NULL, "operation_id" UUID NOT NULL,
  "run_id" UUID NOT NULL, "plan_id" UUID NOT NULL, "reason" "MarketingReconciliationReason" NOT NULL,
  "status" "MarketingReconciliationJobStatus" NOT NULL DEFAULT 'PENDING', "priority" INTEGER NOT NULL DEFAULT 0,
  "attempt_count" INTEGER NOT NULL DEFAULT 0, "next_attempt_at" TIMESTAMP(6),
  "lease_owner" VARCHAR(255), "lease_expires_at" TIMESTAMP(6),
  "last_error_category" VARCHAR(100), "provider_identity" JSON NOT NULL,
  "escalated_at" TIMESTAMP(6), "completed_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketing_execution_reconciliation_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_reconciliation_jobs_operation" FOREIGN KEY ("operation_id") REFERENCES "marketing_provider_operations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_reconciliation_jobs_run" FOREIGN KEY ("run_id") REFERENCES "marketing_execution_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_reconciliation_jobs_plan" FOREIGN KEY ("plan_id") REFERENCES "marketing_execution_plans"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "UQ_marketing_reconciliation_jobs_operation_reason_status" ON "marketing_execution_reconciliation_jobs"("operation_id", "reason", "status");
CREATE INDEX "IDX_marketing_reconciliation_jobs_claim" ON "marketing_execution_reconciliation_jobs"("status", "next_attempt_at", "priority", "created_at");
CREATE INDEX "IDX_marketing_reconciliation_jobs_lease" ON "marketing_execution_reconciliation_jobs"("status", "lease_expires_at");

CREATE TABLE "marketing_execution_compensation_links" (
  "id" UUID NOT NULL, "original_plan_id" UUID NOT NULL,
  "original_run_id" UUID NOT NULL, "original_operation_id" UUID NOT NULL,
  "compensation_plan_id" UUID NOT NULL, "compensation_run_id" UUID,
  "compensation_operation_id" UUID, "reconciliation_id" UUID,
  "authored_by_admin_user_id" TEXT NOT NULL, "reason" VARCHAR(2000) NOT NULL,
  "current_provider_state" JSON NOT NULL, "proposed_safe_state" JSON NOT NULL,
  "irreversible_warning" VARCHAR(2000) NOT NULL,
  "spend_already_incurred" DECIMAL(18,2) NOT NULL, "verified_safe_state_hash" CHAR(64),
  "compensated_at" TIMESTAMP(6), "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketing_execution_compensation_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_compensation_links_original_plan" FOREIGN KEY ("original_plan_id") REFERENCES "marketing_execution_plans"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_compensation_links_original_run" FOREIGN KEY ("original_run_id") REFERENCES "marketing_execution_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_compensation_links_original_operation" FOREIGN KEY ("original_operation_id") REFERENCES "marketing_provider_operations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_compensation_links_plan" FOREIGN KEY ("compensation_plan_id") REFERENCES "marketing_execution_plans"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_compensation_links_run" FOREIGN KEY ("compensation_run_id") REFERENCES "marketing_execution_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_compensation_links_operation" FOREIGN KEY ("compensation_operation_id") REFERENCES "marketing_provider_operations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_compensation_links_reconciliation" FOREIGN KEY ("reconciliation_id") REFERENCES "marketing_execution_reconciliations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_compensation_links_author" FOREIGN KEY ("authored_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "UQ_marketing_compensation_links_plan" ON "marketing_execution_compensation_links"("compensation_plan_id");
CREATE UNIQUE INDEX "UQ_marketing_compensation_links_run" ON "marketing_execution_compensation_links"("compensation_run_id");
CREATE UNIQUE INDEX "UQ_marketing_compensation_links_operation" ON "marketing_execution_compensation_links"("compensation_operation_id");
CREATE INDEX "IDX_marketing_compensation_links_original" ON "marketing_execution_compensation_links"("original_plan_id", "original_run_id", "original_operation_id");
CREATE INDEX "IDX_marketing_compensation_links_reconciliation" ON "marketing_execution_compensation_links"("reconciliation_id");
