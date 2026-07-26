-- Advertising Execution Phase 3, Sections 25-28.
-- Additive API evidence, cancellation states, append-only enforcement, and
-- query indexes. Earlier Advertising Execution migrations remain unchanged.

ALTER TYPE "MarketingExecutionRunStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "MarketingExecutionJobStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_PLAN_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_PLAN_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_PLAN_VALIDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_PLAN_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROVIDER_OPERATION_ATTEMPTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_DRIFT_DETECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_COMPENSATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_OVERRIDE_USED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_DRIFT_ACKNOWLEDGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_OPERATION_RETRY_REVIEWED';

CREATE TABLE "marketing_execution_policy_history" (
  "id" UUID NOT NULL,
  "policy_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "value_type" "MarketingExecutionPolicyValueType" NOT NULL,
  "value" JSON NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "reason" VARCHAR(2000) NOT NULL,
  "changed_fields" JSON NOT NULL,
  "changed_by_admin_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketing_execution_policy_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_execution_policy_history_policy" FOREIGN KEY ("policy_id") REFERENCES "marketing_execution_policies"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_execution_policy_history_actor" FOREIGN KEY ("changed_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "UQ_marketing_execution_policy_history_version" ON "marketing_execution_policy_history"("policy_id", "version");
CREATE INDEX "IDX_marketing_execution_policy_history_timeline" ON "marketing_execution_policy_history"("policy_id", "created_at");

CREATE TABLE "marketing_execution_validation_packets" (
  "id" UUID NOT NULL,
  "plan_id" UUID NOT NULL,
  "plan_version" INTEGER NOT NULL,
  "validation_fingerprint" CHAR(64) NOT NULL,
  "valid" BOOLEAN NOT NULL,
  "provider_api_version" VARCHAR(64),
  "before_state_hash" CHAR(64),
  "before_state_summary" JSON NOT NULL,
  "capability_summary" JSON NOT NULL,
  "budget_exposure" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "activation_exposure" BOOLEAN NOT NULL DEFAULT false,
  "issue_count" INTEGER NOT NULL DEFAULT 0,
  "warning_count" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMP(6) NOT NULL,
  "validated_by_admin_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketing_execution_validation_packets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_execution_validation_packets_plan" FOREIGN KEY ("plan_id") REFERENCES "marketing_execution_plans"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_execution_validation_packets_actor" FOREIGN KEY ("validated_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "UQ_marketing_execution_validation_packets_identity" ON "marketing_execution_validation_packets"("plan_id", "plan_version", "validation_fingerprint");
CREATE INDEX "IDX_marketing_execution_validation_packets_current" ON "marketing_execution_validation_packets"("plan_id", "plan_version", "created_at");
CREATE INDEX "IDX_marketing_execution_validation_packets_expiry" ON "marketing_execution_validation_packets"("expires_at", "valid");

CREATE TABLE "marketing_execution_drift_acknowledgments" (
  "id" UUID NOT NULL,
  "reconciliation_id" UUID NOT NULL,
  "acknowledged_by_admin_user_id" TEXT NOT NULL,
  "reason" VARCHAR(2000) NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketing_execution_drift_acknowledgments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_execution_drift_ack_reconciliation" FOREIGN KEY ("reconciliation_id") REFERENCES "marketing_execution_reconciliations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_execution_drift_ack_actor" FOREIGN KEY ("acknowledged_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "IDX_marketing_execution_drift_ack_timeline" ON "marketing_execution_drift_acknowledgments"("reconciliation_id", "created_at");

CREATE TABLE "marketing_execution_retry_reviews" (
  "id" UUID NOT NULL,
  "operation_id" UUID NOT NULL,
  "reviewed_by_admin_user_id" TEXT NOT NULL,
  "reason" VARCHAR(2000) NOT NULL,
  "decision" VARCHAR(64) NOT NULL,
  "idempotency_key" CHAR(64) NOT NULL,
  "action_job_id" UUID,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketing_execution_retry_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_execution_retry_reviews_operation" FOREIGN KEY ("operation_id") REFERENCES "marketing_provider_operations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_execution_retry_reviews_actor" FOREIGN KEY ("reviewed_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "UQ_marketing_execution_retry_reviews_key" ON "marketing_execution_retry_reviews"("idempotency_key");
CREATE INDEX "IDX_marketing_execution_retry_reviews_operation" ON "marketing_execution_retry_reviews"("operation_id", "created_at");
CREATE INDEX "IDX_marketing_execution_retry_reviews_action_job" ON "marketing_execution_retry_reviews"("action_job_id");

CREATE INDEX "IDX_marketing_execution_plans_status_created" ON "marketing_execution_plans"("status", "created_at");
CREATE INDEX "IDX_marketing_execution_plans_provider_account_status" ON "marketing_execution_plans"("platform", "account_external_id", "status", "created_at");
CREATE INDEX "IDX_marketing_execution_plans_author_created" ON "marketing_execution_plans"("created_by_admin_user_id", "created_at");
CREATE INDEX "IDX_marketing_execution_plans_fingerprint_version" ON "marketing_execution_plans"("validation_fingerprint", "version");
CREATE INDEX "IDX_marketing_execution_policies_effective" ON "marketing_execution_policies"("scope", "platform", "connection_id", "enabled");
CREATE INDEX "IDX_marketing_execution_reconciliations_status_checked" ON "marketing_execution_reconciliations"("status", "checked_at");
CREATE INDEX "IDX_marketing_creative_publications_list" ON "marketing_creative_publications"("creative_asset_id", "platform", "connection_id", "review_status", "created_at");
CREATE INDEX "IDX_marketing_creative_publications_reuse_created" ON "marketing_creative_publications"("reuse_classification", "created_at");

CREATE OR REPLACE FUNCTION prevent_marketing_execution_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Advertising Execution evidence is append-only';
END;
$$;

CREATE TRIGGER "TRG_marketing_execution_policy_history_append_only" BEFORE UPDATE OR DELETE ON "marketing_execution_policy_history" FOR EACH ROW EXECUTE FUNCTION prevent_marketing_execution_evidence_mutation();
CREATE TRIGGER "TRG_marketing_execution_validation_packets_append_only" BEFORE UPDATE OR DELETE ON "marketing_execution_validation_packets" FOR EACH ROW EXECUTE FUNCTION prevent_marketing_execution_evidence_mutation();
CREATE TRIGGER "TRG_marketing_execution_drift_ack_append_only" BEFORE UPDATE OR DELETE ON "marketing_execution_drift_acknowledgments" FOR EACH ROW EXECUTE FUNCTION prevent_marketing_execution_evidence_mutation();
CREATE TRIGGER "TRG_marketing_execution_retry_reviews_append_only" BEFORE UPDATE OR DELETE ON "marketing_execution_retry_reviews" FOR EACH ROW EXECUTE FUNCTION prevent_marketing_execution_evidence_mutation();
CREATE TRIGGER "TRG_marketing_execution_approvals_append_only" BEFORE UPDATE OR DELETE ON "marketing_execution_approvals" FOR EACH ROW EXECUTE FUNCTION prevent_marketing_execution_evidence_mutation();
CREATE TRIGGER "TRG_marketing_execution_approval_events_append_only" BEFORE UPDATE OR DELETE ON "marketing_execution_approval_events" FOR EACH ROW EXECUTE FUNCTION prevent_marketing_execution_evidence_mutation();
CREATE TRIGGER "TRG_marketing_execution_validation_issues_append_only" BEFORE UPDATE OR DELETE ON "marketing_execution_validation_issues" FOR EACH ROW EXECUTE FUNCTION prevent_marketing_execution_evidence_mutation();
CREATE TRIGGER "TRG_marketing_execution_snapshots_append_only" BEFORE UPDATE OR DELETE ON "marketing_execution_state_snapshots" FOR EACH ROW EXECUTE FUNCTION prevent_marketing_execution_evidence_mutation();
CREATE TRIGGER "TRG_marketing_execution_reconciliations_append_only" BEFORE UPDATE OR DELETE ON "marketing_execution_reconciliations" FOR EACH ROW EXECUTE FUNCTION prevent_marketing_execution_evidence_mutation();
