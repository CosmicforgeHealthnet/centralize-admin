-- CreateEnum
CREATE TYPE "MarketingExecutionSourceType" AS ENUM ('MANUAL', 'RECOMMENDATION', 'TEMPLATE', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "MarketingExecutionPlanStatus" AS ENUM ('DRAFT', 'VALIDATING', 'VALIDATED', 'PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'EXECUTING', 'PARTIAL_SUCCESS', 'SUCCEEDED', 'FAILED', 'ROLLBACK_PENDING', 'ROLLED_BACK', 'ROLLBACK_FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MarketingExecutionOperationType" AS ENUM ('CREATE', 'UPDATE', 'PAUSE', 'RESUME', 'ARCHIVE', 'REMOVE_LINK');

-- CreateEnum
CREATE TYPE "MarketingExecutionResourceType" AS ENUM ('BUDGET', 'CAMPAIGN', 'GROUP', 'TARGETING', 'CREATIVE', 'AD', 'ASSET_LINK');

-- CreateEnum
CREATE TYPE "MarketingExecutionApprovalDecision" AS ENUM ('APPROVED', 'REJECTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "MarketingExecutionRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'PARTIAL_SUCCESS', 'SUCCEEDED', 'FAILED', 'RECONCILING');

-- CreateEnum
CREATE TYPE "MarketingExecutionRunTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'RETRY', 'COMPENSATION');

-- CreateEnum
CREATE TYPE "MarketingExecutionJobStatus" AS ENUM ('PENDING', 'CLAIMED', 'RUNNING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "MarketingExecutionOperationStatus" AS ENUM ('PENDING', 'VALIDATED', 'READY', 'EXECUTING', 'SUCCEEDED', 'VERIFYING', 'VERIFIED', 'FAILED', 'UNKNOWN', 'RETRY_SCHEDULED', 'DRIFTED');

-- CreateEnum
CREATE TYPE "MarketingExecutionOutcomeCertainty" AS ENUM ('KNOWN_SUCCESS', 'KNOWN_FAILURE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MarketingExecutionSnapshotKind" AS ENUM ('BEFORE', 'DESIRED', 'AFTER');

-- CreateEnum
CREATE TYPE "MarketingExecutionReconciliationStatus" AS ENUM ('VERIFIED', 'DRIFTED', 'UNKNOWN', 'EXTERNAL_CHANGE', 'COMPENSATED');

-- CreateEnum
CREATE TYPE "MarketingExecutionPolicyScope" AS ENUM ('GLOBAL', 'PLATFORM', 'CONNECTION');

-- CreateEnum
CREATE TYPE "MarketingExecutionPolicyValueType" AS ENUM ('BOOLEAN', 'INTEGER', 'DECIMAL', 'STRING', 'JSON');

-- CreateEnum
CREATE TYPE "MarketingExecutionValidationSeverity" AS ENUM ('ERROR', 'WARNING');

-- CreateEnum
CREATE TYPE "MarketingCreativePublicationReviewStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "marketing_execution_plans" (
    "id" UUID NOT NULL,
    "plan_number" VARCHAR(64) NOT NULL,
    "source_type" "MarketingExecutionSourceType" NOT NULL,
    "source_recommendation_id" TEXT,
    "platform" "marketing_ad_platform_enum" NOT NULL,
    "connection_id" TEXT NOT NULL,
    "account_external_id" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "status" "MarketingExecutionPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "currency_code" CHAR(3) NOT NULL,
    "desired_state" JSON NOT NULL,
    "validation_fingerprint" CHAR(64),
    "validated_at" TIMESTAMP(6),
    "expires_at" TIMESTAMP(6),
    "created_by_admin_user_id" TEXT NOT NULL,
    "updated_by_admin_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_execution_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_execution_plan_items" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "operation_type" "MarketingExecutionOperationType" NOT NULL,
    "resource_type" "MarketingExecutionResourceType" NOT NULL,
    "provider_resource_id" VARCHAR(512),
    "client_reference" VARCHAR(128) NOT NULL,
    "depends_on_item_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "intent" JSON NOT NULL,
    "before_state" JSON,
    "material_hash" CHAR(64) NOT NULL,
    "status" "MarketingExecutionOperationStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_execution_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_execution_approvals" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "plan_version" INTEGER NOT NULL,
    "validation_fingerprint" CHAR(64) NOT NULL,
    "decision" "MarketingExecutionApprovalDecision" NOT NULL,
    "approver_admin_user_id" TEXT NOT NULL,
    "reason" TEXT,
    "approval_scope" JSON NOT NULL,
    "decided_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_execution_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_execution_approval_events" (
    "id" UUID NOT NULL,
    "approval_id" UUID NOT NULL,
    "decision" "MarketingExecutionApprovalDecision" NOT NULL,
    "reason" TEXT,
    "decided_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_execution_approval_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_execution_runs" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "MarketingExecutionRunStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "MarketingExecutionRunTrigger" NOT NULL,
    "approval_fingerprint" CHAR(64) NOT NULL,
    "started_at" TIMESTAMP(6),
    "completed_at" TIMESTAMP(6),
    "summary" JSON,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_execution_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_execution_jobs" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "status" "MarketingExecutionJobStatus" NOT NULL DEFAULT 'PENDING',
    "lease_owner" VARCHAR(255),
    "lease_expires_at" TIMESTAMP(6),
    "next_attempt_at" TIMESTAMP(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_execution_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_provider_operations" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "provider_operation_key" VARCHAR(128) NOT NULL,
    "provider_request_id" VARCHAR(255),
    "native_resource_id" VARCHAR(512),
    "native_resource_name" VARCHAR(512),
    "status" "MarketingExecutionOperationStatus" NOT NULL DEFAULT 'PENDING',
    "safe_to_retry" BOOLEAN NOT NULL DEFAULT false,
    "outcome_certainty" "MarketingExecutionOutcomeCertainty" NOT NULL DEFAULT 'UNKNOWN',
    "normalized_result" JSON,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_provider_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_provider_operation_attempts" (
    "id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "error_code" VARCHAR(100),
    "error_category" VARCHAR(100),
    "retry_after_at" TIMESTAMP(6),
    "started_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(6),
    "normalized_error" JSON,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_provider_operation_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_execution_state_snapshots" (
    "id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "kind" "MarketingExecutionSnapshotKind" NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "normalized_state" JSON NOT NULL,
    "hash" CHAR(64) NOT NULL,
    "captured_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "marketing_execution_state_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_execution_validation_issues" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "item_id" UUID,
    "plan_version" INTEGER NOT NULL,
    "validation_fingerprint" CHAR(64) NOT NULL,
    "severity" "MarketingExecutionValidationSeverity" NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "field_path" VARCHAR(500) NOT NULL,
    "message" VARCHAR(2000) NOT NULL,
    "provider_code" VARCHAR(100),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_execution_validation_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_execution_reconciliations" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "status" "MarketingExecutionReconciliationStatus" NOT NULL,
    "differences" JSON NOT NULL,
    "checked_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_execution_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_execution_policies" (
    "id" UUID NOT NULL,
    "scope" "MarketingExecutionPolicyScope" NOT NULL,
    "platform" "marketing_ad_platform_enum",
    "connection_id" TEXT,
    "key" VARCHAR(100) NOT NULL,
    "value_type" "MarketingExecutionPolicyValueType" NOT NULL,
    "value" JSON NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_admin_user_id" TEXT NOT NULL,
    "updated_by_admin_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_execution_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_creative_publications" (
    "id" UUID NOT NULL,
    "creative_asset_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "platform" "marketing_ad_platform_enum" NOT NULL,
    "connection_id" TEXT NOT NULL,
    "provider_media_id" VARCHAR(512),
    "provider_creative_id" VARCHAR(512),
    "provider_ad_id" VARCHAR(512),
    "review_status" "MarketingCreativePublicationReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "content_hash" CHAR(64) NOT NULL,
    "publication_metadata" JSON NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_creative_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_execution_plans_plan_number" ON "marketing_execution_plans"("plan_number");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_plans_connection_status_created" ON "marketing_execution_plans"("connection_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_plans_recommendation_status" ON "marketing_execution_plans"("source_recommendation_id", "status");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_plan_items_plan_status" ON "marketing_execution_plan_items"("plan_id", "status");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_plan_items_resource_provider" ON "marketing_execution_plan_items"("resource_type", "provider_resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_execution_plan_items_plan_sequence" ON "marketing_execution_plan_items"("plan_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_execution_plan_items_plan_client_ref" ON "marketing_execution_plan_items"("plan_id", "client_reference");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_approvals_current" ON "marketing_execution_approvals"("plan_id", "plan_version", "validation_fingerprint", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_execution_approvals_plan_version_approver" ON "marketing_execution_approvals"("plan_id", "plan_version", "approver_admin_user_id");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_approval_events_timeline" ON "marketing_execution_approval_events"("approval_id", "decided_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_execution_approval_events_decision" ON "marketing_execution_approval_events"("approval_id", "decision");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_runs_plan_status_created" ON "marketing_execution_runs"("plan_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_jobs_claim" ON "marketing_execution_jobs"("status", "next_attempt_at", "priority", "created_at");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_jobs_expired_lease" ON "marketing_execution_jobs"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_jobs_run_status" ON "marketing_execution_jobs"("run_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_provider_operations_key" ON "marketing_provider_operations"("provider_operation_key");

-- CreateIndex
CREATE INDEX "IDX_marketing_provider_operations_run_status" ON "marketing_provider_operations"("run_id", "status");

-- CreateIndex
CREATE INDEX "IDX_marketing_provider_operations_item_status" ON "marketing_provider_operations"("item_id", "status");

-- CreateIndex
CREATE INDEX "IDX_marketing_provider_operations_request" ON "marketing_provider_operations"("provider_request_id");

-- CreateIndex
CREATE INDEX "IDX_marketing_provider_operations_resource_name" ON "marketing_provider_operations"("native_resource_name");

-- CreateIndex
CREATE INDEX "IDX_marketing_provider_operation_attempts_started" ON "marketing_provider_operation_attempts"("operation_id", "started_at");

-- CreateIndex
CREATE INDEX "IDX_marketing_provider_operation_attempts_error_category" ON "marketing_provider_operation_attempts"("error_category");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_provider_operation_attempts_number" ON "marketing_provider_operation_attempts"("operation_id", "number");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_snapshots_lookup" ON "marketing_execution_state_snapshots"("operation_id", "kind", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_execution_snapshots_operation_kind_sequence" ON "marketing_execution_state_snapshots"("operation_id", "kind", "sequence");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_validation_issues_packet" ON "marketing_execution_validation_issues"("plan_id", "plan_version", "validation_fingerprint");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_validation_issues_item" ON "marketing_execution_validation_issues"("item_id", "severity", "code");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_reconciliations_run" ON "marketing_execution_reconciliations"("run_id", "status", "checked_at");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_reconciliations_operation" ON "marketing_execution_reconciliations"("operation_id", "checked_at");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_policies_scope_key" ON "marketing_execution_policies"("scope", "key");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_policies_connection_key" ON "marketing_execution_policies"("connection_id", "key");

-- CreateIndex
CREATE INDEX "IDX_marketing_execution_policies_platform_key" ON "marketing_execution_policies"("platform", "key");

-- CreateIndex
CREATE INDEX "IDX_marketing_creative_publications_asset_status" ON "marketing_creative_publications"("creative_asset_id", "review_status");

-- CreateIndex
CREATE INDEX "IDX_marketing_creative_publications_provider_connection" ON "marketing_creative_publications"("platform", "connection_id");

-- CreateIndex
CREATE INDEX "IDX_marketing_creative_publications_content_hash" ON "marketing_creative_publications"("content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_creative_publications_revision" ON "marketing_creative_publications"("creative_asset_id", "platform", "connection_id", "revision");

-- Prisma cannot represent PostgreSQL partial unique indexes. These indexes
-- prevent duplicate effective policies across nullable scope columns.
CREATE UNIQUE INDEX "UQ_marketing_execution_policies_global_key"
ON "marketing_execution_policies"("key")
WHERE "scope" = 'GLOBAL' AND "platform" IS NULL AND "connection_id" IS NULL;

CREATE UNIQUE INDEX "UQ_marketing_execution_policies_platform_key"
ON "marketing_execution_policies"("platform", "key")
WHERE "scope" = 'PLATFORM' AND "platform" IS NOT NULL AND "connection_id" IS NULL;

CREATE UNIQUE INDEX "UQ_marketing_execution_policies_connection_key"
ON "marketing_execution_policies"("connection_id", "key")
WHERE "scope" = 'CONNECTION' AND "connection_id" IS NOT NULL;

-- Fixed-width hashes and scope checks are expressed in SQL because Prisma
-- does not currently model CHECK constraints.
ALTER TABLE "marketing_execution_plans"
  ADD CONSTRAINT "CHK_marketing_execution_plans_version" CHECK ("version" >= 1),
  ADD CONSTRAINT "CHK_marketing_execution_plans_currency" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "CHK_marketing_execution_plans_fingerprint" CHECK ("validation_fingerprint" IS NULL OR "validation_fingerprint" ~ '^[a-f0-9]{64}$');

ALTER TABLE "marketing_execution_plan_items"
  ADD CONSTRAINT "CHK_marketing_execution_plan_items_sequence" CHECK ("sequence" >= 0),
  ADD CONSTRAINT "CHK_marketing_execution_plan_items_hash" CHECK ("material_hash" ~ '^[a-f0-9]{64}$');

ALTER TABLE "marketing_execution_approvals"
  ADD CONSTRAINT "CHK_marketing_execution_approvals_fingerprint" CHECK ("validation_fingerprint" ~ '^[a-f0-9]{64}$');

ALTER TABLE "marketing_execution_runs"
  ADD CONSTRAINT "CHK_marketing_execution_runs_fingerprint" CHECK ("approval_fingerprint" ~ '^[a-f0-9]{64}$');

ALTER TABLE "marketing_provider_operation_attempts"
  ADD CONSTRAINT "CHK_marketing_provider_operation_attempts_number" CHECK ("number" >= 1);

ALTER TABLE "marketing_execution_state_snapshots"
  ADD CONSTRAINT "CHK_marketing_execution_snapshots_sequence" CHECK ("sequence" >= 1),
  ADD CONSTRAINT "CHK_marketing_execution_snapshots_hash" CHECK ("hash" ~ '^[a-f0-9]{64}$');

ALTER TABLE "marketing_execution_validation_issues"
  ADD CONSTRAINT "CHK_marketing_execution_validation_fingerprint" CHECK ("validation_fingerprint" ~ '^[a-f0-9]{64}$');

ALTER TABLE "marketing_execution_policies"
  ADD CONSTRAINT "CHK_marketing_execution_policies_version" CHECK ("version" >= 1),
  ADD CONSTRAINT "CHK_marketing_execution_policies_scope" CHECK (
    ("scope" = 'GLOBAL' AND "platform" IS NULL AND "connection_id" IS NULL) OR
    ("scope" = 'PLATFORM' AND "platform" IS NOT NULL AND "connection_id" IS NULL) OR
    ("scope" = 'CONNECTION' AND "connection_id" IS NOT NULL)
  );

ALTER TABLE "marketing_creative_publications"
  ADD CONSTRAINT "CHK_marketing_creative_publications_revision" CHECK ("revision" >= 1),
  ADD CONSTRAINT "CHK_marketing_creative_publications_hash" CHECK ("content_hash" ~ '^[a-f0-9]{64}$');

-- AddForeignKey
ALTER TABLE "marketing_execution_plans" ADD CONSTRAINT "FK_marketing_execution_plans_source_recommendation" FOREIGN KEY ("source_recommendation_id") REFERENCES "marketing_recommendations"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_plans" ADD CONSTRAINT "FK_marketing_execution_plans_connection" FOREIGN KEY ("connection_id") REFERENCES "marketing_ad_platform_connections"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_plans" ADD CONSTRAINT "FK_marketing_execution_plans_created_by" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_plans" ADD CONSTRAINT "FK_marketing_execution_plans_updated_by" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_plan_items" ADD CONSTRAINT "FK_marketing_execution_plan_items_plan" FOREIGN KEY ("plan_id") REFERENCES "marketing_execution_plans"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_approvals" ADD CONSTRAINT "FK_marketing_execution_approvals_plan" FOREIGN KEY ("plan_id") REFERENCES "marketing_execution_plans"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_approvals" ADD CONSTRAINT "FK_marketing_execution_approvals_approver" FOREIGN KEY ("approver_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_approval_events" ADD CONSTRAINT "FK_marketing_execution_approval_events_approval" FOREIGN KEY ("approval_id") REFERENCES "marketing_execution_approvals"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_runs" ADD CONSTRAINT "FK_marketing_execution_runs_plan" FOREIGN KEY ("plan_id") REFERENCES "marketing_execution_plans"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_jobs" ADD CONSTRAINT "FK_marketing_execution_jobs_run" FOREIGN KEY ("run_id") REFERENCES "marketing_execution_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_provider_operations" ADD CONSTRAINT "FK_marketing_provider_operations_run" FOREIGN KEY ("run_id") REFERENCES "marketing_execution_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_provider_operations" ADD CONSTRAINT "FK_marketing_provider_operations_item" FOREIGN KEY ("item_id") REFERENCES "marketing_execution_plan_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_provider_operation_attempts" ADD CONSTRAINT "FK_marketing_provider_operation_attempts_operation" FOREIGN KEY ("operation_id") REFERENCES "marketing_provider_operations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_state_snapshots" ADD CONSTRAINT "FK_marketing_execution_snapshots_operation" FOREIGN KEY ("operation_id") REFERENCES "marketing_provider_operations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_validation_issues" ADD CONSTRAINT "FK_marketing_execution_validation_issues_plan" FOREIGN KEY ("plan_id") REFERENCES "marketing_execution_plans"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_validation_issues" ADD CONSTRAINT "FK_marketing_execution_validation_issues_item" FOREIGN KEY ("item_id") REFERENCES "marketing_execution_plan_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_reconciliations" ADD CONSTRAINT "FK_marketing_execution_reconciliations_run" FOREIGN KEY ("run_id") REFERENCES "marketing_execution_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_reconciliations" ADD CONSTRAINT "FK_marketing_execution_reconciliations_operation" FOREIGN KEY ("operation_id") REFERENCES "marketing_provider_operations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_policies" ADD CONSTRAINT "FK_marketing_execution_policies_connection" FOREIGN KEY ("connection_id") REFERENCES "marketing_ad_platform_connections"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_policies" ADD CONSTRAINT "FK_marketing_execution_policies_created_by" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_execution_policies" ADD CONSTRAINT "FK_marketing_execution_policies_updated_by" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_creative_publications" ADD CONSTRAINT "FK_marketing_creative_publications_asset" FOREIGN KEY ("creative_asset_id") REFERENCES "marketing_creative_assets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_creative_publications" ADD CONSTRAINT "FK_marketing_creative_publications_connection" FOREIGN KEY ("connection_id") REFERENCES "marketing_ad_platform_connections"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
