-- CosmicForge Mail M9: operational hardening.
-- Additive only. Retention runs (dry-run first; execution is disabled by
-- default and needs a step-up), daily usage counters split by purpose (counts
-- only, no prices), per-brand quota limits, and evaluated ops alerts.
-- No legal retention durations are defined here: policies and system
-- retention periods are configured by authorised operators.
-- Rollback: docs/sql/cosmicforge-mail-m7-m10-rollback.sql (section M9).

-- CreateEnum
CREATE TYPE "MailRetentionRunMode" AS ENUM ('DRY_RUN', 'EXECUTE');

-- CreateEnum
CREATE TYPE "MailRetentionRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "mail_retention_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "policy_id" UUID,
    "category" VARCHAR(40) NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "mode" "MailRetentionRunMode" NOT NULL,
    "status" "MailRetentionRunStatus" NOT NULL DEFAULT 'QUEUED',
    "cutoff" TIMESTAMPTZ(6) NOT NULL,
    "dry_run_id" UUID,
    "requested_by" TEXT NOT NULL,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "cursor" JSONB,
    "error_code" VARCHAR(64),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_retention_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_usage_daily" (
    "organization_id" UUID NOT NULL,
    "purpose" VARCHAR(32) NOT NULL,
    "day" DATE NOT NULL,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "received" INTEGER NOT NULL DEFAULT 0,
    "provider_requests" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PK_mail_usage_daily" PRIMARY KEY ("organization_id","purpose","day")
);

-- CreateTable
CREATE TABLE "mail_quota_limits" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "purpose" VARCHAR(32) NOT NULL,
    "daily_soft_limit" INTEGER,
    "daily_hard_limit" INTEGER,
    "monthly_hard_limit" INTEGER,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_quota_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_ops_alerts" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "severity" VARCHAR(16) NOT NULL,
    "organization_id" UUID,
    "fingerprint" VARCHAR(200) NOT NULL,
    "detail" JSONB,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "notified_at" TIMESTAMPTZ(6),
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by" TEXT,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "mail_ops_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IDX_mail_retention_runs_org_created" ON "mail_retention_runs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "IDX_mail_retention_runs_status" ON "mail_retention_runs"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_retention_runs_dry_run" ON "mail_retention_runs"("dry_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_mail_quota_limits_org_purpose" ON "mail_quota_limits"("organization_id", "purpose");

-- CreateIndex
CREATE INDEX "IDX_mail_ops_alerts_open" ON "mail_ops_alerts"("resolved_at", "severity");

-- CreateIndex
CREATE INDEX "IDX_mail_ops_alerts_fingerprint" ON "mail_ops_alerts"("fingerprint", "resolved_at");


-- Integrity rules the ORM cannot express.
ALTER TABLE "mail_retention_runs"
  ADD CONSTRAINT "CHK_mail_retention_runs_category" CHECK ("category" IN ('POLICY', 'WEBHOOK_PAYLOADS', 'INTEGRATION_EVENTS', 'PRODUCT_DELIVERY_EVENTS')),
  ADD CONSTRAINT "CHK_mail_retention_runs_action" CHECK ("action" IN ('ARCHIVE', 'DELETE', 'REDACT')),
  ADD CONSTRAINT "CHK_mail_retention_runs_policy" CHECK (("category" = 'POLICY') = ("policy_id" IS NOT NULL)),
  ADD CONSTRAINT "CHK_mail_retention_runs_execute_from_dry_run" CHECK ("mode" = 'DRY_RUN' OR "dry_run_id" IS NOT NULL);
ALTER TABLE "mail_usage_daily"
  ADD CONSTRAINT "CHK_mail_usage_daily_purpose" CHECK ("purpose" IN ('STAFF_MAIL', 'SUPPORT', 'MARKETING_BROADCAST', 'MARKETING_AUTOMATION', 'MARKETING_CONFIRMATION', 'INBOUND')),
  ADD CONSTRAINT "CHK_mail_usage_daily_nonnegative" CHECK ("accepted" >= 0 AND "rejected" >= 0 AND "received" >= 0 AND "provider_requests" >= 0 AND "bytes" >= 0);
ALTER TABLE "mail_quota_limits"
  ADD CONSTRAINT "CHK_mail_quota_limits_purpose" CHECK ("purpose" IN ('STAFF_MAIL', 'SUPPORT', 'MARKETING_BROADCAST', 'MARKETING_AUTOMATION', 'MARKETING_CONFIRMATION')),
  ADD CONSTRAINT "CHK_mail_quota_limits_positive" CHECK (COALESCE("daily_soft_limit", 1) > 0 AND COALESCE("daily_hard_limit", 1) > 0 AND COALESCE("monthly_hard_limit", 1) > 0),
  ADD CONSTRAINT "CHK_mail_quota_limits_soft_le_hard" CHECK ("daily_soft_limit" IS NULL OR "daily_hard_limit" IS NULL OR "daily_soft_limit" <= "daily_hard_limit");
ALTER TABLE "mail_ops_alerts"
  ADD CONSTRAINT "CHK_mail_ops_alerts_severity" CHECK ("severity" IN ('info', 'warning', 'critical'));
-- At most one open alert per fingerprint.
CREATE UNIQUE INDEX "UQ_mail_ops_alerts_open_fingerprint" ON "mail_ops_alerts"("fingerprint") WHERE "resolved_at" IS NULL;
