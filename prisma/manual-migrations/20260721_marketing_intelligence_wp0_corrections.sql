-- Marketing Intelligence WP0 mandatory Phase 1 corrections.
-- Additive and backward-compatible: no historical rows are guessed or rewritten
-- beyond defaulting new nullable/safe columns.

ALTER TYPE "marketing_funnel_stage_enum" ADD VALUE IF NOT EXISTS 'REFUND';
ALTER TYPE "marketing_funnel_stage_enum" ADD VALUE IF NOT EXISTS 'CHARGEBACK';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_INTELLIGENCE_VALIDATION_UPDATED';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_attribution_model_enum') THEN
    CREATE TYPE "marketing_attribution_model_enum" AS ENUM ('LAST_TOUCH');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_attribution_status_enum') THEN
    CREATE TYPE "marketing_attribution_status_enum" AS ENUM ('ATTRIBUTED', 'UNRESOLVED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_intelligence_run_type_enum') THEN
    CREATE TYPE "marketing_intelligence_run_type_enum" AS ENUM ('SYNC', 'CONNECTION_TEST', 'VALIDATION');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_intelligence_run_status_enum') THEN
    CREATE TYPE "marketing_intelligence_run_status_enum" AS ENUM (
      'STARTED',
      'SUCCEEDED',
      'PARTIALLY_SUCCEEDED',
      'FAILED',
      'SKIPPED_LOCKED',
      'LOCK_RENEWAL_FAILED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_provider_validation_status_enum') THEN
    CREATE TYPE "marketing_provider_validation_status_enum" AS ENUM (
      'NOT_VALIDATED',
      'MOCK_VERIFIED',
      'CONNECTION_TEST_PASSED',
      'BOUNDED_FETCH_PASSED',
      'METRIC_RECONCILED',
      'LIVE_VALIDATED',
      'CREDENTIAL_BLOCKED',
      'APPROVAL_BLOCKED',
      'FAILED'
    );
  END IF;
END $$;

ALTER TABLE "marketing_ad_platform_connections"
  ADD COLUMN IF NOT EXISTS "validationStatus" "marketing_provider_validation_status_enum" NOT NULL DEFAULT 'NOT_VALIDATED',
  ADD COLUMN IF NOT EXISTS "lastConnectionTestAt" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "lastSuccessfulFetchAt" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "lastMetricReconciliationAt" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "lastPaginationVerificationAt" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "lastRateLimitVerificationAt" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "lastTokenRefreshVerificationAt" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "sanitizedValidationError" TEXT;

ALTER TABLE "marketing_performance_snapshots"
  ADD COLUMN IF NOT EXISTS "refunds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "chargebacks" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "netRevenue" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "roas" DECIMAL(14, 2),
  ADD COLUMN IF NOT EXISTS "currencyCompatibility" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "marketing_attributions"
  ADD COLUMN IF NOT EXISTS "connectionId" TEXT,
  ADD COLUMN IF NOT EXISTS "accountExternalId" VARCHAR(255);

ALTER TABLE "marketing_funnel_events"
  ADD COLUMN IF NOT EXISTS "platform" "marketing_ad_platform_enum",
  ADD COLUMN IF NOT EXISTS "connectionId" TEXT,
  ADD COLUMN IF NOT EXISTS "accountExternalId" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "originalPaymentExternalEventId" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "monetaryStatus" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "attributionStatus" "marketing_attribution_status_enum",
  ADD COLUMN IF NOT EXISTS "unresolvedReason" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "attributedClickEventId" TEXT,
  ADD COLUMN IF NOT EXISTS "attributionModel" "marketing_attribution_model_enum",
  ADD COLUMN IF NOT EXISTS "attributionWindowDays" INTEGER,
  ADD COLUMN IF NOT EXISTS "attributionWindowStart" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "attributionWindowEnd" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(6);

CREATE INDEX IF NOT EXISTS "IDX_marketing_attributions_connectionId"
  ON "marketing_attributions" ("connectionId");

CREATE INDEX IF NOT EXISTS "IDX_marketing_attributions_platform_account_campaign"
  ON "marketing_attributions" ("platform", "accountExternalId", "campaignExternalId");

CREATE INDEX IF NOT EXISTS "IDX_mkt_funnel_platform_account_campaign_time"
  ON "marketing_funnel_events" ("platform", "accountExternalId", "campaignExternalId", "occurredAt");

CREATE INDEX IF NOT EXISTS "IDX_marketing_funnel_events_connection_campaign_occurredAt"
  ON "marketing_funnel_events" ("connectionId", "campaignExternalId", "occurredAt");

CREATE INDEX IF NOT EXISTS "IDX_marketing_funnel_events_anonId"
  ON "marketing_funnel_events" ("anonId");

CREATE INDEX IF NOT EXISTS "IDX_marketing_funnel_events_attributedClickEventId"
  ON "marketing_funnel_events" ("attributedClickEventId");

CREATE INDEX IF NOT EXISTS "IDX_marketing_funnel_events_originalPaymentExternalEventId"
  ON "marketing_funnel_events" ("originalPaymentExternalEventId");

CREATE TABLE IF NOT EXISTS "marketing_identity_links" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "anonIdHash" VARCHAR(128) NOT NULL,
  "userId" VARCHAR(255) NOT NULL,
  "sourceSignupEventId" VARCHAR(255),
  "status" VARCHAR(40) NOT NULL DEFAULT 'ACTIVE',
  "conflictReason" VARCHAR(100),
  "linkedAt" TIMESTAMP(6) NOT NULL,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_identity_links" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_marketing_identity_links_anonIdHash"
  ON "marketing_identity_links" ("anonIdHash");

CREATE INDEX IF NOT EXISTS "IDX_marketing_identity_links_userId"
  ON "marketing_identity_links" ("userId");

CREATE INDEX IF NOT EXISTS "IDX_marketing_identity_links_sourceSignupEventId"
  ON "marketing_identity_links" ("sourceSignupEventId");

CREATE TABLE IF NOT EXISTS "marketing_attribution_decisions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "conversionEventId" TEXT NOT NULL,
  "selectedClickEventId" TEXT,
  "model" "marketing_attribution_model_enum" NOT NULL DEFAULT 'LAST_TOUCH',
  "attributionWindowDays" INTEGER NOT NULL,
  "windowStart" TIMESTAMP(6) NOT NULL,
  "windowEnd" TIMESTAMP(6) NOT NULL,
  "platform" "marketing_ad_platform_enum",
  "connectionId" TEXT,
  "accountExternalId" VARCHAR(255),
  "campaignExternalId" VARCHAR(255),
  "status" "marketing_attribution_status_enum" NOT NULL,
  "unresolvedReason" VARCHAR(100),
  "resolvedAt" TIMESTAMP(6) NOT NULL,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_attribution_decisions" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'FK_marketing_attribution_decisions_conversionEventId'
  ) THEN
    ALTER TABLE "marketing_attribution_decisions"
      ADD CONSTRAINT "FK_marketing_attribution_decisions_conversionEventId"
      FOREIGN KEY ("conversionEventId")
      REFERENCES "marketing_funnel_events"("id")
      ON DELETE CASCADE
      ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'FK_marketing_attribution_decisions_selectedClickEventId'
  ) THEN
    ALTER TABLE "marketing_attribution_decisions"
      ADD CONSTRAINT "FK_marketing_attribution_decisions_selectedClickEventId"
      FOREIGN KEY ("selectedClickEventId")
      REFERENCES "marketing_funnel_events"("id")
      ON DELETE SET NULL
      ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_marketing_attribution_decisions_conversionEventId"
  ON "marketing_attribution_decisions" ("conversionEventId");

CREATE INDEX IF NOT EXISTS "IDX_marketing_attribution_decisions_selectedClickEventId"
  ON "marketing_attribution_decisions" ("selectedClickEventId");

CREATE INDEX IF NOT EXISTS "IDX_marketing_attribution_decisions_status_resolvedAt"
  ON "marketing_attribution_decisions" ("status", "resolvedAt");

CREATE INDEX IF NOT EXISTS "IDX_marketing_attribution_decisions_platform_account_campaign"
  ON "marketing_attribution_decisions" ("platform", "accountExternalId", "campaignExternalId");

CREATE TABLE IF NOT EXISTS "marketing_intelligence_settings" (
  "key" VARCHAR(100) NOT NULL,
  "value" JSON NOT NULL,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_intelligence_settings" PRIMARY KEY ("key")
);

CREATE TABLE IF NOT EXISTS "marketing_intelligence_evaluation_runs" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "runType" "marketing_intelligence_run_type_enum" NOT NULL,
  "status" "marketing_intelligence_run_status_enum" NOT NULL,
  "trigger" VARCHAR(100),
  "platform" "marketing_ad_platform_enum",
  "connectionId" TEXT,
  "accountExternalId" VARCHAR(255),
  "startedAt" TIMESTAMP(6) NOT NULL,
  "completedAt" TIMESTAMP(6),
  "lockKeyHash" VARCHAR(128),
  "lockOwnerHash" VARCHAR(128),
  "processedCount" INTEGER NOT NULL DEFAULT 0,
  "succeededCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "summary" JSON,
  "errorCode" VARCHAR(100),
  "sanitizedError" TEXT,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_intelligence_evaluation_runs" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'FK_marketing_intelligence_evaluation_runs_connectionId'
  ) THEN
    ALTER TABLE "marketing_intelligence_evaluation_runs"
      ADD CONSTRAINT "FK_marketing_intelligence_evaluation_runs_connectionId"
      FOREIGN KEY ("connectionId")
      REFERENCES "marketing_ad_platform_connections"("id")
      ON DELETE SET NULL
      ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "IDX_marketing_intelligence_runs_type_status_startedAt"
  ON "marketing_intelligence_evaluation_runs" ("runType", "status", "startedAt");

CREATE INDEX IF NOT EXISTS "IDX_marketing_intelligence_runs_platform_startedAt"
  ON "marketing_intelligence_evaluation_runs" ("platform", "startedAt");

CREATE INDEX IF NOT EXISTS "IDX_marketing_intelligence_runs_connectionId"
  ON "marketing_intelligence_evaluation_runs" ("connectionId");
