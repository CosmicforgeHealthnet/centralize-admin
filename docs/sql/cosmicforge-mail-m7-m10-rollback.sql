-- CosmicForge Mail rollback for manual migrations 29+ (Stage A3, M7, M8, M9, M10).
-- Run ONLY with Admin DB owner approval, after a verified backup, and only
-- when the matching code is not running (or its flags are off). Sections run
-- newest-first. Each section is idempotent (IF EXISTS).
-- Dropping these tables deletes their data (dispatch history, automation
-- history, integration events). Export what must be kept first.
-- Enum values added with ALTER TYPE ... ADD VALUE cannot be dropped in
-- PostgreSQL; they are harmless when unused and are left in place.

BEGIN;

-- ===================================================================== M10
-- 20261030_mail_m10_rollout.sql. After this the code falls back to the M9
-- environment flags only; set MAIL_ROLLOUT_ENFORCED=false first, or the
-- (already deployed) code will deny every gated capability.
DROP TABLE IF EXISTS "mail_emergency_stops";
DROP TABLE IF EXISTS "mail_rollout_rules";
DROP TABLE IF EXISTS "mail_rollout_cohort_members";
DROP TABLE IF EXISTS "mail_rollout_cohorts";

-- ===================================================================== M9
-- 20261029_mail_m9_operations.sql. Retention run history and ops alerts are
-- evidence: export them first if they must be kept.
DROP TABLE IF EXISTS "mail_ops_alerts";
DROP TABLE IF EXISTS "mail_quota_limits";
DROP TABLE IF EXISTS "mail_usage_daily";
DROP TABLE IF EXISTS "mail_retention_runs";
DROP TYPE IF EXISTS "MailRetentionRunStatus";
DROP TYPE IF EXISTS "MailRetentionRunMode";
-- Queued M9 jobs are cancelled (rows kept for evidence).
UPDATE "mail_outbox_jobs" SET "status" = 'CANCELLED', "completed_at" = now(), "last_error_code" = 'ROLLED_BACK' WHERE "kind" IN ('RETENTION_RUN', 'OPS_EVALUATE') AND "status"::text IN ('PENDING', 'RETRY_SCHEDULED', 'RECONCILING', 'LEASED');

-- ===================================================================== M8
DROP TABLE IF EXISTS "mail_product_delivery_events";
DROP TABLE IF EXISTS "mail_product_integration_events";
DROP TABLE IF EXISTS "mail_product_sender_authorizations";
DROP TABLE IF EXISTS "mail_product_integrations";
DROP TYPE IF EXISTS "MailProductIntegrationStatus";
DROP FUNCTION IF EXISTS mail_guard_append_only();

-- ===================================================================== M7
DROP TRIGGER IF EXISTS "TRG_marketing_automation_versions_immutable" ON "marketing_automation_versions";
DROP TRIGGER IF EXISTS "TRG_marketing_campaign_approved_contacts_immutable" ON "marketing_campaign_approved_contacts";
DROP FUNCTION IF EXISTS prevent_marketing_automation_version_mutation();
DROP TABLE IF EXISTS "marketing_automation_step_runs";
DROP TABLE IF EXISTS "marketing_automation_enrollments";
DROP TABLE IF EXISTS "marketing_automation_versions";
DROP TABLE IF EXISTS "marketing_automations";
DROP TABLE IF EXISTS "marketing_trigger_events";
DROP TABLE IF EXISTS "marketing_broadcast_recipients";
DROP TABLE IF EXISTS "marketing_broadcast_dispatches";
DROP TABLE IF EXISTS "marketing_campaign_approved_contacts";
DROP TABLE IF EXISTS "marketing_brand_settings";
DROP TYPE IF EXISTS "MarketingTriggerEventStatus";
DROP TYPE IF EXISTS "MarketingAutomationStepRunStatus";
DROP TYPE IF EXISTS "MarketingAutomationEnrollmentStatus";
DROP TYPE IF EXISTS "MarketingAutomationVersionStatus";
DROP TYPE IF EXISTS "MarketingAutomationStatus";
DROP TYPE IF EXISTS "MarketingBroadcastRecipientStatus";
DROP TYPE IF EXISTS "MarketingBroadcastStatus";
-- Campaigns left in M7-only states are returned to a safe M6 state.
UPDATE "marketing_email_campaigns" SET "status" = 'CANCELLED' WHERE "status"::text IN ('SCHEDULED', 'QUEUED', 'SENDING', 'OUTCOME_UNKNOWN');
-- Queued MARKETING jobs are cancelled (rows kept for evidence).
UPDATE "mail_outbox_jobs" SET "status" = 'CANCELLED', "completed_at" = now(), "last_error_code" = 'ROLLED_BACK' WHERE "queue"::text = 'MARKETING' AND "status"::text IN ('PENDING', 'RETRY_SCHEDULED', 'RECONCILING', 'LEASED');

-- ===================================================================== A3
DROP INDEX IF EXISTS "IDX_mail_step_up_session";
ALTER TABLE "mail_step_up_verifications" DROP COLUMN IF EXISTS "session_id";

-- Finally remove the ledger rows for the rolled-back files so
-- db:admin:prepare sees them as unapplied. Keep only the sections you ran.
DO $$
BEGIN
  IF to_regclass('public.social_manual_migrations') IS NOT NULL THEN
    DELETE FROM public.social_manual_migrations WHERE "file" IN (
      '20261030_mail_m10_rollout.sql',
      '20261029_mail_m9_operations.sql',
      '20261028_mail_m8_product_integration.sql',
      '20261027_mail_m7_broadcasts_automation.sql',
      '20261026_mail_step_up_session_binding.sql'
    );
  END IF;
END $$;

COMMIT;
