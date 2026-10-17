-- Advertising Execution Sections 25-28 strict remediation.
-- Additive only: durable cancellation, retry linkage, complete policy history,
-- bounded emergency overrides, canonical audit actions, and append-only audit.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXECUTION_QUEUED';

ALTER TABLE "marketing_execution_jobs"
  ADD COLUMN "cancellation_requested_at" TIMESTAMP(6),
  ADD COLUMN "cancellation_requested_by_admin_user_id" TEXT,
  ADD COLUMN "cancellation_reason" VARCHAR(2000),
  ADD COLUMN "cancellation_observed_at" TIMESTAMP(6),
  ADD COLUMN "cancellation_outcome" VARCHAR(64),
  ADD CONSTRAINT "FK_marketing_execution_jobs_cancellation_requester"
    FOREIGN KEY ("cancellation_requested_by_admin_user_id") REFERENCES "admin_users"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE INDEX "IDX_marketing_execution_jobs_cancellation_request"
  ON "marketing_execution_jobs"("status", "cancellation_requested_at");

ALTER TABLE "marketing_execution_retry_reviews"
  ADD CONSTRAINT "FK_marketing_execution_retry_reviews_action_job"
    FOREIGN KEY ("action_job_id") REFERENCES "marketing_execution_jobs"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;

ALTER TABLE "marketing_execution_policy_history"
  ADD COLUMN "previous_version" INTEGER,
  ADD COLUMN "previous_value" JSON,
  ADD COLUMN "previous_enabled" BOOLEAN,
  ADD COLUMN "new_version" INTEGER,
  ADD COLUMN "new_value" JSON,
  ADD COLUMN "new_enabled" BOOLEAN,
  ADD COLUMN "correlation_id" VARCHAR(128),
  ADD COLUMN "effective_scope" JSON,
  ADD COLUMN "behavior_changed" BOOLEAN NOT NULL DEFAULT false;

-- Deterministic compatibility backfill. Existing rows already represent the
-- replacement side; the unavailable pre-change side remains explicitly null.
ALTER TABLE "marketing_execution_policy_history"
  DISABLE TRIGGER "TRG_marketing_execution_policy_history_append_only";
UPDATE "marketing_execution_policy_history"
SET "new_version" = "version",
    "new_value" = "value",
    "new_enabled" = "enabled",
    "effective_scope" = '{}'::json
WHERE "new_version" IS NULL;
ALTER TABLE "marketing_execution_policy_history"
  ENABLE TRIGGER "TRG_marketing_execution_policy_history_append_only";

ALTER TABLE "marketing_execution_policy_history"
  ALTER COLUMN "new_version" SET NOT NULL,
  ALTER COLUMN "new_value" SET NOT NULL,
  ALTER COLUMN "new_enabled" SET NOT NULL,
  ALTER COLUMN "effective_scope" SET NOT NULL;

CREATE TABLE "marketing_execution_emergency_overrides" (
  "id" UUID NOT NULL,
  "scope_type" VARCHAR(32) NOT NULL,
  "platform" "marketing_ad_platform_enum",
  "connection_id" TEXT,
  "account_external_id" VARCHAR(255),
  "plan_id" UUID,
  "run_id" UUID,
  "operation_id" UUID,
  "allowed_controls" JSON NOT NULL,
  "non_overridable_controls" JSON NOT NULL,
  "reason" VARCHAR(2000) NOT NULL,
  "requested_by_admin_user_id" TEXT NOT NULL,
  "approved_by_admin_user_id" TEXT,
  "mfa_evidence_reference" VARCHAR(255) NOT NULL,
  "starts_at" TIMESTAMP(6) NOT NULL,
  "expires_at" TIMESTAMP(6) NOT NULL,
  "revoked_at" TIMESTAMP(6),
  "status" VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  "use_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketing_execution_emergency_overrides_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CHK_marketing_execution_overrides_duration" CHECK ("expires_at" > "starts_at" AND "expires_at" <= "starts_at" + INTERVAL '2 hours'),
  CONSTRAINT "CHK_marketing_execution_overrides_scope" CHECK ("scope_type" IN ('CONNECTION','ACCOUNT','PLAN','RUN','OPERATION')),
  CONSTRAINT "CHK_marketing_execution_overrides_status" CHECK ("status" IN ('ACTIVE','EXPIRED','REVOKED')),
  CONSTRAINT "CHK_marketing_execution_overrides_use_count" CHECK ("use_count" >= 0),
  CONSTRAINT "FK_marketing_execution_overrides_requester" FOREIGN KEY ("requested_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_execution_overrides_approver" FOREIGN KEY ("approved_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_execution_overrides_connection" FOREIGN KEY ("connection_id") REFERENCES "marketing_ad_platform_connections"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_execution_overrides_plan" FOREIGN KEY ("plan_id") REFERENCES "marketing_execution_plans"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_execution_overrides_run" FOREIGN KEY ("run_id") REFERENCES "marketing_execution_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_execution_overrides_operation" FOREIGN KEY ("operation_id") REFERENCES "marketing_provider_operations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX "IDX_marketing_execution_overrides_active"
  ON "marketing_execution_emergency_overrides"("status", "expires_at");
CREATE INDEX "IDX_marketing_execution_overrides_scope"
  ON "marketing_execution_emergency_overrides"("platform", "connection_id", "account_external_id");

-- The shared application exposes AuditLog insertion and reads only. Protect
-- every historical central audit row from in-place correction or deletion.
CREATE TRIGGER "TRG_admin_audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "admin_audit_logs"
  FOR EACH ROW EXECUTE FUNCTION prevent_marketing_execution_evidence_mutation();

