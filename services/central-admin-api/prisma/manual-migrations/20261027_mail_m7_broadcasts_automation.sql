-- CosmicForge Mail M7: controlled marketing broadcasts and automation.
-- Additive only: new enums/tables, two enum values, no existing column is
-- changed or dropped. Nothing here sends mail; dispatch stays behind
-- MAIL_BROADCAST_DISPATCH_ENABLED / MAIL_AUTOMATION_ENABLED (default off).
-- New enum values (MailJobQueue.MARKETING, campaign OUTCOME_UNKNOWN) are not
-- referenced elsewhere in this file, so the file is safe in one transaction
-- on PostgreSQL 12+.
-- Rollback: docs/sql/cosmicforge-mail-m7-m10-rollback.sql (section M7).

-- CreateEnum
CREATE TYPE "MarketingBroadcastStatus" AS ENUM ('SCHEDULED', 'QUEUED', 'PREPARING', 'SENDING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN', 'PAUSED');

-- CreateEnum
CREATE TYPE "MarketingBroadcastRecipientStatus" AS ENUM ('PENDING', 'EXCLUDED', 'SYNCED', 'PROVIDER_ACCEPTED', 'DELIVERED', 'DELAYED', 'BOUNCED', 'COMPLAINED', 'FAILED', 'SUPPRESSED', 'UNSUBSCRIBED', 'CANCELLED', 'OUTCOME_UNKNOWN');

-- CreateEnum
CREATE TYPE "MarketingAutomationStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MarketingAutomationVersionStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'SUPERSEDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MarketingAutomationEnrollmentStatus" AS ENUM ('ACTIVE', 'WAITING', 'COMPLETED', 'EXITED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MarketingAutomationStepRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED', 'OUTCOME_UNKNOWN');

-- CreateEnum
CREATE TYPE "MarketingTriggerEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- AlterEnum
ALTER TYPE "MailJobQueue" ADD VALUE IF NOT EXISTS 'MARKETING';

-- AlterEnum
ALTER TYPE "MarketingEmailCampaignStatus" ADD VALUE IF NOT EXISTS 'OUTCOME_UNKNOWN';

-- CreateTable
CREATE TABLE "marketing_brand_settings" (
    "organization_id" UUID NOT NULL,
    "confirmation_sender_address_id" UUID,
    "default_time_zone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "postal_address" VARCHAR(500),
    "daily_broadcast_cap" INTEGER NOT NULL DEFAULT 1000,
    "daily_automation_cap" INTEGER NOT NULL DEFAULT 500,
    "max_broadcast_recipients" INTEGER NOT NULL DEFAULT 1000,
    "dispatch_paused" BOOLEAN NOT NULL DEFAULT false,
    "paused_reason" VARCHAR(500),
    "paused_at" TIMESTAMPTZ(6),
    "paused_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_brand_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "marketing_campaign_approved_contacts" (
    "snapshot_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PK_marketing_campaign_approved_contacts" PRIMARY KEY ("snapshot_id","contact_id")
);

-- CreateTable
CREATE TABLE "marketing_broadcast_dispatches" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "approval_snapshot_id" UUID NOT NULL,
    "status" "MarketingBroadcastStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "time_zone" VARCHAR(64) NOT NULL,
    "local_send_time" VARCHAR(32),
    "provider" VARCHAR(32) NOT NULL DEFAULT 'resend',
    "provider_segment_id" VARCHAR(128),
    "provider_broadcast_id" VARCHAR(128),
    "provider_status" VARCHAR(32),
    "provider_create_attempted_at" TIMESTAMPTZ(6),
    "provider_send_attempted_at" TIMESTAMPTZ(6),
    "provider_sent_at" TIMESTAMPTZ(6),
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "excluded_count" INTEGER NOT NULL DEFAULT 0,
    "eligibility_sha256" CHAR(64),
    "content_sha256" CHAR(64) NOT NULL,
    "scheduled_by_admin_user_id" TEXT NOT NULL,
    "cancel_requested_at" TIMESTAMPTZ(6),
    "cancel_requested_by" TEXT,
    "paused_at" TIMESTAMPTZ(6),
    "paused_by" TEXT,
    "last_error_code" VARCHAR(64),
    "last_error_message" VARCHAR(500),
    "completed_at" TIMESTAMPTZ(6),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_broadcast_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_broadcast_recipients" (
    "id" UUID NOT NULL,
    "dispatch_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "status" "MarketingBroadcastRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "exclusion_reason" VARCHAR(64),
    "provider_contact_id" VARCHAR(128),
    "provider_email_id" VARCHAR(255),
    "synced_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "last_event_type" VARCHAR(32),
    "last_event_at" TIMESTAMPTZ(6),
    "opened_at" TIMESTAMPTZ(6),
    "clicked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_broadcast_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_automations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "status" "MarketingAutomationStatus" NOT NULL DEFAULT 'DRAFT',
    "trigger_type" VARCHAR(32) NOT NULL,
    "active_version_id" UUID,
    "enrollment_limit" INTEGER NOT NULL DEFAULT 1,
    "max_active_enrollments" INTEGER NOT NULL DEFAULT 5000,
    "frequency_cap_hours" INTEGER NOT NULL DEFAULT 24,
    "created_by_admin_user_id" TEXT NOT NULL,
    "updated_by_admin_user_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "last_scheduled_run_at" TIMESTAMPTZ(6),
    "activated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_automation_versions" (
    "id" UUID NOT NULL,
    "automation_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "MarketingAutomationVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "definition" JSONB NOT NULL,
    "trigger_config" JSONB NOT NULL,
    "definition_sha256" CHAR(64) NOT NULL,
    "created_by_admin_user_id" TEXT NOT NULL,
    "submitted_by_admin_user_id" TEXT,
    "submitted_at" TIMESTAMPTZ(6),
    "reviewed_by_admin_user_id" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_comment" TEXT,
    "step_up_id" UUID,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_automation_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_automation_enrollments" (
    "id" UUID NOT NULL,
    "automation_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" "MarketingAutomationEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "dedupe_key" VARCHAR(200) NOT NULL,
    "trigger_event_id" UUID,
    "current_step_id" VARCHAR(64),
    "step_count" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMPTZ(6),
    "exit_reason" VARCHAR(64),
    "context" JSONB,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_automation_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_automation_step_runs" (
    "id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "step_id" VARCHAR(64) NOT NULL,
    "step_type" VARCHAR(32) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "MarketingAutomationStepRunStatus" NOT NULL DEFAULT 'RUNNING',
    "idempotency_key" VARCHAR(160),
    "recipient_email" VARCHAR(320),
    "template_version_id" UUID,
    "provider_message_id" VARCHAR(255),
    "first_attempt_at" TIMESTAMPTZ(6),
    "delivery_status" VARCHAR(32),
    "outcome" JSONB,
    "error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_automation_step_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_trigger_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "event_type" VARCHAR(96) NOT NULL,
    "event_id" VARCHAR(160) NOT NULL,
    "contact_id" UUID,
    "payload" JSONB,
    "status" "MarketingTriggerEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "error" VARCHAR(500),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "marketing_trigger_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_broadcast_dispatches_campaign" ON "marketing_broadcast_dispatches"("campaign_id");

-- CreateIndex
CREATE INDEX "IDX_marketing_broadcast_dispatches_org_status" ON "marketing_broadcast_dispatches"("organization_id", "status");

-- CreateIndex
CREATE INDEX "IDX_marketing_broadcast_dispatches_provider_broadcast" ON "marketing_broadcast_dispatches"("provider_broadcast_id");

-- CreateIndex
CREATE INDEX "IDX_marketing_broadcast_recipients_dispatch_status" ON "marketing_broadcast_recipients"("dispatch_id", "status");

-- CreateIndex
CREATE INDEX "IDX_marketing_broadcast_recipients_org_email" ON "marketing_broadcast_recipients"("organization_id", "email", "accepted_at");

-- CreateIndex
CREATE INDEX "IDX_marketing_broadcast_recipients_provider_contact" ON "marketing_broadcast_recipients"("provider_contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_broadcast_recipients_dispatch_contact" ON "marketing_broadcast_recipients"("dispatch_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_automations_org_name" ON "marketing_automations"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_automation_versions_automation_version" ON "marketing_automation_versions"("automation_id", "version");

-- CreateIndex
CREATE INDEX "IDX_marketing_automation_enrollments_due" ON "marketing_automation_enrollments"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "IDX_marketing_automation_enrollments_contact" ON "marketing_automation_enrollments"("automation_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_automation_enrollments_dedupe" ON "marketing_automation_enrollments"("automation_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_automation_step_runs_idempotency" ON "marketing_automation_step_runs"("idempotency_key");

-- CreateIndex
CREATE INDEX "IDX_marketing_automation_step_runs_provider_message" ON "marketing_automation_step_runs"("provider_message_id");

-- CreateIndex
CREATE INDEX "IDX_marketing_automation_step_runs_org_email" ON "marketing_automation_step_runs"("organization_id", "recipient_email", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_automation_step_runs_sequence" ON "marketing_automation_step_runs"("enrollment_id", "sequence");

-- CreateIndex
CREATE INDEX "IDX_marketing_trigger_events_status" ON "marketing_trigger_events"("status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_marketing_trigger_events_source_event" ON "marketing_trigger_events"("organization_id", "source", "event_id");

-- AddForeignKey
ALTER TABLE "marketing_brand_settings" ADD CONSTRAINT "FK_marketing_brand_settings_organization" FOREIGN KEY ("organization_id") REFERENCES "mail_organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_campaign_approved_contacts" ADD CONSTRAINT "FK_marketing_campaign_approved_contacts_snapshot" FOREIGN KEY ("snapshot_id") REFERENCES "marketing_email_campaign_snapshots"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_broadcast_dispatches" ADD CONSTRAINT "FK_marketing_broadcast_dispatches_campaign" FOREIGN KEY ("campaign_id") REFERENCES "marketing_email_campaigns"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_broadcast_recipients" ADD CONSTRAINT "FK_marketing_broadcast_recipients_dispatch" FOREIGN KEY ("dispatch_id") REFERENCES "marketing_broadcast_dispatches"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_broadcast_recipients" ADD CONSTRAINT "FK_marketing_broadcast_recipients_contact" FOREIGN KEY ("contact_id") REFERENCES "marketing_email_contacts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_automations" ADD CONSTRAINT "FK_marketing_automations_organization" FOREIGN KEY ("organization_id") REFERENCES "mail_organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_automation_versions" ADD CONSTRAINT "FK_marketing_automation_versions_automation" FOREIGN KEY ("automation_id") REFERENCES "marketing_automations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_automation_enrollments" ADD CONSTRAINT "FK_marketing_automation_enrollments_automation" FOREIGN KEY ("automation_id") REFERENCES "marketing_automations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_automation_enrollments" ADD CONSTRAINT "FK_marketing_automation_enrollments_version" FOREIGN KEY ("version_id") REFERENCES "marketing_automation_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_automation_enrollments" ADD CONSTRAINT "FK_marketing_automation_enrollments_contact" FOREIGN KEY ("contact_id") REFERENCES "marketing_email_contacts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketing_automation_step_runs" ADD CONSTRAINT "FK_marketing_automation_step_runs_enrollment" FOREIGN KEY ("enrollment_id") REFERENCES "marketing_automation_enrollments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Defence in depth for the M7 state machines.
ALTER TABLE "marketing_automations"
  ADD CONSTRAINT "CHK_marketing_automations_trigger_type" CHECK ("trigger_type" IN ('CONSENT_GRANTED', 'PRODUCT_EVENT', 'SCHEDULE')),
  ADD CONSTRAINT "CHK_marketing_automations_limits" CHECK ("enrollment_limit" >= 1 AND "max_active_enrollments" >= 1 AND "frequency_cap_hours" >= 0);
ALTER TABLE "marketing_brand_settings"
  ADD CONSTRAINT "CHK_marketing_brand_settings_caps" CHECK ("daily_broadcast_cap" >= 0 AND "daily_automation_cap" >= 0 AND "max_broadcast_recipients" >= 0);
-- A published automation version needs a distinct reviewer and an MFA step-up.
ALTER TABLE "marketing_automation_versions"
  ADD CONSTRAINT "CHK_marketing_automation_versions_published" CHECK (
    "status" NOT IN ('PUBLISHED', 'SUPERSEDED') OR "published_at" IS NULL
    OR ("step_up_id" IS NOT NULL AND "reviewed_by_admin_user_id" IS NOT NULL
        AND "reviewed_by_admin_user_id" <> "created_by_admin_user_id"
        AND "reviewed_by_admin_user_id" <> COALESCE("submitted_by_admin_user_id", ''))
  );
-- A broadcast only reaches the provider-sent states with a provider broadcast id.
ALTER TABLE "marketing_broadcast_dispatches"
  ADD CONSTRAINT "CHK_marketing_broadcast_dispatches_provider" CHECK ("status" NOT IN ('SENDING', 'COMPLETED') OR "provider_broadcast_id" IS NOT NULL);

-- Automation definitions are immutable once submitted; versions are never deleted.
CREATE OR REPLACE FUNCTION prevent_marketing_automation_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'marketing automation versions are append-only' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (
       NEW."definition" IS DISTINCT FROM OLD."definition"
    OR NEW."trigger_config" IS DISTINCT FROM OLD."trigger_config"
    OR NEW."definition_sha256" IS DISTINCT FROM OLD."definition_sha256"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."automation_id" IS DISTINCT FROM OLD."automation_id") THEN
    RAISE EXCEPTION 'submitted marketing automation versions are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "TRG_marketing_automation_versions_immutable"
  BEFORE UPDATE OR DELETE ON "marketing_automation_versions"
  FOR EACH ROW EXECUTE FUNCTION prevent_marketing_automation_version_mutation();

-- The approved recipient set is evidence of what was approved.
CREATE TRIGGER "TRG_marketing_campaign_approved_contacts_immutable"
  BEFORE UPDATE OR DELETE ON "marketing_campaign_approved_contacts"
  FOR EACH ROW EXECUTE FUNCTION prevent_mail_evidence_mutation();
