-- Marketing Intelligence Phase 2, Section 7: creative-domain data model.
-- Additive except for widening the WP0 settings primary key into a scoped key;
-- existing settings rows are retained as GLOBAL JSON settings.

ALTER TYPE "marketing_intelligence_run_type_enum" ADD VALUE IF NOT EXISTS 'CREATIVE_SYNC';
ALTER TYPE "marketing_intelligence_run_type_enum" ADD VALUE IF NOT EXISTS 'SCORE';
ALTER TYPE "marketing_intelligence_run_type_enum" ADD VALUE IF NOT EXISTS 'RECOMMEND';
ALTER TYPE "marketing_intelligence_run_type_enum" ADD VALUE IF NOT EXISTS 'ALERT';
ALTER TYPE "marketing_intelligence_run_type_enum" ADD VALUE IF NOT EXISTS 'FULL_EVALUATION';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_creative_type_enum') THEN
    CREATE TYPE "marketing_creative_type_enum" AS ENUM ('IMAGE', 'VIDEO', 'CAROUSEL', 'TEXT', 'RESPONSIVE', 'OTHER', 'UNKNOWN');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_creative_data_sufficiency_enum') THEN
    CREATE TYPE "marketing_creative_data_sufficiency_enum" AS ENUM ('INSUFFICIENT', 'LIMITED', 'SUFFICIENT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_creative_fatigue_status_enum') THEN
    CREATE TYPE "marketing_creative_fatigue_status_enum" AS ENUM ('UNKNOWN', 'HEALTHY', 'WATCH', 'FATIGUED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_recommendation_type_enum') THEN
    CREATE TYPE "marketing_recommendation_type_enum" AS ENUM ('REFRESH_CREATIVE', 'SCALE_CREATIVE', 'REDUCE_SPEND', 'REALLOCATE_BUDGET', 'REVIEW_CAMPAIGN', 'OTHER');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_recommendation_status_enum') THEN
    CREATE TYPE "marketing_recommendation_status_enum" AS ENUM ('OPEN', 'ACCEPTED', 'DISMISSED', 'EXPIRED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_alert_type_enum') THEN
    CREATE TYPE "marketing_alert_type_enum" AS ENUM ('CREATIVE_FATIGUE', 'PERFORMANCE_DROP', 'SPEND_ANOMALY', 'DATA_QUALITY', 'CONNECTION_FAILURE', 'OTHER');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_alert_severity_enum') THEN
    CREATE TYPE "marketing_alert_severity_enum" AS ENUM ('INFO', 'WARNING', 'CRITICAL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_alert_status_enum') THEN
    CREATE TYPE "marketing_alert_status_enum" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_experiment_status_enum') THEN
    CREATE TYPE "marketing_experiment_status_enum" AS ENUM ('DRAFT', 'RUNNING', 'COMPLETED', 'CANCELLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_experiment_metric_enum') THEN
    CREATE TYPE "marketing_experiment_metric_enum" AS ENUM ('CTR', 'CPC', 'CPM', 'CONVERSION_RATE', 'CPA', 'ROAS');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_intelligence_setting_scope_type_enum') THEN
    CREATE TYPE "marketing_intelligence_setting_scope_type_enum" AS ENUM ('GLOBAL', 'PLATFORM', 'CONNECTION');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'marketing_intelligence_setting_value_type_enum') THEN
    CREATE TYPE "marketing_intelligence_setting_value_type_enum" AS ENUM ('BOOLEAN', 'INTEGER', 'DECIMAL', 'STRING', 'JSON');
  END IF;
END $$;

ALTER TABLE "marketing_intelligence_evaluation_runs"
  ADD COLUMN IF NOT EXISTS "requestedByAdminUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "windowStart" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "windowEnd" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "createdCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "updatedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_marketing_intel_runs_requested_admin') THEN
    ALTER TABLE "marketing_intelligence_evaluation_runs"
      ADD CONSTRAINT "FK_marketing_intel_runs_requested_admin"
      FOREIGN KEY ("requestedByAdminUserId") REFERENCES "admin_users"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

DROP INDEX IF EXISTS "IDX_marketing_intelligence_runs_connectionId";
CREATE INDEX IF NOT EXISTS "IDX_marketing_intelligence_runs_connection_startedAt"
  ON "marketing_intelligence_evaluation_runs" ("connectionId", "startedAt");

ALTER TABLE "marketing_intelligence_settings"
  ADD COLUMN IF NOT EXISTS "id" TEXT DEFAULT gen_random_uuid()::text,
  ADD COLUMN IF NOT EXISTS "scopeType" "marketing_intelligence_setting_scope_type_enum" NOT NULL DEFAULT 'GLOBAL',
  ADD COLUMN IF NOT EXISTS "platform" "marketing_ad_platform_enum",
  ADD COLUMN IF NOT EXISTS "connectionId" TEXT,
  ADD COLUMN IF NOT EXISTS "scopeFingerprint" VARCHAR(255) NOT NULL DEFAULT 'GLOBAL',
  ADD COLUMN IF NOT EXISTS "valueType" "marketing_intelligence_setting_value_type_enum" NOT NULL DEFAULT 'JSON',
  ADD COLUMN IF NOT EXISTS "valueJson" JSON,
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "updatedByAdminUserId" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'marketing_intelligence_settings'
      AND column_name = 'value'
  ) THEN
    UPDATE "marketing_intelligence_settings"
    SET "id" = COALESCE("id", gen_random_uuid()::text),
        "valueJson" = COALESCE("valueJson", "value"),
        "scopeFingerprint" = COALESCE(NULLIF("scopeFingerprint", ''), 'GLOBAL');
  ELSE
    UPDATE "marketing_intelligence_settings"
    SET "id" = COALESCE("id", gen_random_uuid()::text),
        "scopeFingerprint" = COALESCE(NULLIF("scopeFingerprint", ''), 'GLOBAL');
  END IF;
END $$;

ALTER TABLE "marketing_intelligence_settings"
  ALTER COLUMN "id" SET NOT NULL,
  ALTER COLUMN "valueJson" SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'marketing_intelligence_settings'
      AND column_name = 'value'
  ) THEN
    ALTER TABLE "marketing_intelligence_settings" ALTER COLUMN "value" DROP NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PK_marketing_intelligence_settings') THEN
    ALTER TABLE "marketing_intelligence_settings" DROP CONSTRAINT "PK_marketing_intelligence_settings";
  END IF;
  ALTER TABLE "marketing_intelligence_settings"
    ADD CONSTRAINT "PK_marketing_intelligence_settings" PRIMARY KEY ("id");
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_marketing_intelligence_settings_connectionId') THEN
    ALTER TABLE "marketing_intelligence_settings"
      ADD CONSTRAINT "FK_marketing_intelligence_settings_connectionId"
      FOREIGN KEY ("connectionId") REFERENCES "marketing_ad_platform_connections"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_marketing_intelligence_settings_updatedByAdminUserId') THEN
    ALTER TABLE "marketing_intelligence_settings"
      ADD CONSTRAINT "FK_marketing_intelligence_settings_updatedByAdminUserId"
      FOREIGN KEY ("updatedByAdminUserId") REFERENCES "admin_users"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_marketing_intelligence_settings_key_scopeFingerprint"
  ON "marketing_intelligence_settings" ("key", "scopeFingerprint");
CREATE INDEX IF NOT EXISTS "IDX_marketing_intelligence_settings_scope"
  ON "marketing_intelligence_settings" ("scopeType", "platform", "connectionId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_intelligence_settings_key_scopeType"
  ON "marketing_intelligence_settings" ("key", "scopeType");

CREATE TABLE IF NOT EXISTS "marketing_creative_assets" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "platform" "marketing_ad_platform_enum" NOT NULL,
  "connectionId" TEXT NOT NULL,
  "accountExternalId" VARCHAR(255) NOT NULL,
  "campaignExternalId" VARCHAR(255) NOT NULL,
  "adGroupExternalId" VARCHAR(255),
  "adExternalId" VARCHAR(255),
  "creativeExternalId" VARCHAR(512) NOT NULL,
  "sourceKey" VARCHAR(512) NOT NULL,
  "name" VARCHAR(512),
  "type" "marketing_creative_type_enum" NOT NULL,
  "status" VARCHAR(100),
  "durationSeconds" INTEGER,
  "hasHumanPresence" BOOLEAN,
  "ctaType" VARCHAR(100),
  "headline" TEXT,
  "bodyText" TEXT,
  "sourceUrl" TEXT,
  "thumbnailUrl" TEXT,
  "creativeHash" VARCHAR(128),
  "sourceSocialMediaAssetId" UUID,
  "nativeIdentifiers" JSON,
  "metadata" JSON,
  "firstSeenAt" TIMESTAMP(6) NOT NULL,
  "lastSeenAt" TIMESTAMP(6) NOT NULL,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_creative_assets" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_creative_assets_connectionId" FOREIGN KEY ("connectionId") REFERENCES "marketing_ad_platform_connections"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_creative_assets_sourceSocialMediaAssetId" FOREIGN KEY ("sourceSocialMediaAssetId") REFERENCES "social_media_assets"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_marketing_creative_assets_connection_sourceKey" ON "marketing_creative_assets" ("connectionId", "sourceKey");
CREATE INDEX IF NOT EXISTS "IDX_marketing_creative_assets_platform_account_campaign" ON "marketing_creative_assets" ("platform", "accountExternalId", "campaignExternalId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_creative_assets_platform_creative" ON "marketing_creative_assets" ("platform", "creativeExternalId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_creative_assets_connection_campaign" ON "marketing_creative_assets" ("connectionId", "campaignExternalId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_creative_assets_lastSeenAt" ON "marketing_creative_assets" ("lastSeenAt");

CREATE TABLE IF NOT EXISTS "marketing_creative_performance_snapshots" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "creativeAssetId" TEXT NOT NULL,
  "platform" "marketing_ad_platform_enum" NOT NULL,
  "connectionId" TEXT NOT NULL,
  "accountExternalId" VARCHAR(255) NOT NULL,
  "campaignExternalId" VARCHAR(255) NOT NULL,
  "adGroupExternalId" VARCHAR(255),
  "adExternalId" VARCHAR(255),
  "creativeExternalId" VARCHAR(512) NOT NULL,
  "sourceMetricKey" VARCHAR(512) NOT NULL,
  "date" DATE NOT NULL,
  "currencyCode" VARCHAR(16),
  "spend" DECIMAL(18,2),
  "revenue" DECIMAL(18,2),
  "impressions" BIGINT,
  "reach" BIGINT,
  "clicks" BIGINT,
  "providerConversions" BIGINT,
  "attributedSignups" BIGINT,
  "attributedPayments" BIGINT,
  "ctr" DECIMAL(18,6),
  "cpc" DECIMAL(18,6),
  "cpm" DECIMAL(18,6),
  "conversionRate" DECIMAL(18,6),
  "cpa" DECIMAL(18,6),
  "roas" DECIMAL(18,6),
  "rawInsightId" TEXT,
  "metadata" JSON,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_creative_performance_snapshots" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_creative_perf_snapshots_creativeAssetId" FOREIGN KEY ("creativeAssetId") REFERENCES "marketing_creative_assets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_creative_perf_snapshots_connectionId" FOREIGN KEY ("connectionId") REFERENCES "marketing_ad_platform_connections"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_creative_perf_snapshots_rawInsightId" FOREIGN KEY ("rawInsightId") REFERENCES "marketing_ad_insights_raw"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_marketing_creative_perf_snapshots_connection_metric_date" ON "marketing_creative_performance_snapshots" ("connectionId", "sourceMetricKey", "date");
CREATE INDEX IF NOT EXISTS "IDX_marketing_creative_perf_platform_account_campaign_date" ON "marketing_creative_performance_snapshots" ("platform", "accountExternalId", "campaignExternalId", "date");
CREATE INDEX IF NOT EXISTS "IDX_marketing_creative_perf_asset_date" ON "marketing_creative_performance_snapshots" ("creativeAssetId", "date");
CREATE INDEX IF NOT EXISTS "IDX_marketing_creative_perf_connection_date" ON "marketing_creative_performance_snapshots" ("connectionId", "date");
CREATE INDEX IF NOT EXISTS "IDX_marketing_creative_perf_platform_creative_date" ON "marketing_creative_performance_snapshots" ("platform", "creativeExternalId", "date");

CREATE TABLE IF NOT EXISTS "marketing_creative_score_snapshots" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "creativeAssetId" TEXT NOT NULL,
  "analysisWindowStart" TIMESTAMP(6) NOT NULL,
  "analysisWindowEnd" TIMESTAMP(6) NOT NULL,
  "comparisonWindowStart" TIMESTAMP(6),
  "comparisonWindowEnd" TIMESTAMP(6),
  "score" DECIMAL(5,2) NOT NULL CHECK ("score" >= 0 AND "score" <= 100),
  "dataSufficiency" "marketing_creative_data_sufficiency_enum" NOT NULL,
  "fatigueStatus" "marketing_creative_fatigue_status_enum" NOT NULL,
  "components" JSON NOT NULL,
  "evidence" JSON NOT NULL,
  "ruleVersion" VARCHAR(64) NOT NULL,
  "settingsVersion" VARCHAR(128),
  "generatedAt" TIMESTAMP(6) NOT NULL,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_creative_score_snapshots" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_creative_score_snapshots_creativeAssetId" FOREIGN KEY ("creativeAssetId") REFERENCES "marketing_creative_assets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_marketing_creative_scores_asset_window_rule" ON "marketing_creative_score_snapshots" ("creativeAssetId", "analysisWindowStart", "analysisWindowEnd", "ruleVersion");
CREATE INDEX IF NOT EXISTS "IDX_marketing_creative_scores_score_generatedAt" ON "marketing_creative_score_snapshots" ("score", "generatedAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_creative_scores_fatigue_generatedAt" ON "marketing_creative_score_snapshots" ("fatigueStatus", "generatedAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_creative_scores_asset_generatedAt" ON "marketing_creative_score_snapshots" ("creativeAssetId", "generatedAt");

CREATE TABLE IF NOT EXISTS "marketing_recommendations" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "type" "marketing_recommendation_type_enum" NOT NULL,
  "status" "marketing_recommendation_status_enum" NOT NULL DEFAULT 'OPEN',
  "platform" "marketing_ad_platform_enum",
  "connectionId" TEXT,
  "targetCampaignExternalId" VARCHAR(255) NOT NULL,
  "sourceCampaignExternalId" VARCHAR(255),
  "destinationCampaignExternalId" VARCHAR(255),
  "currencyCode" VARCHAR(16),
  "reasoning" TEXT NOT NULL,
  "confidence" DECIMAL(5,4) NOT NULL CHECK ("confidence" >= 0 AND "confidence" <= 1),
  "evidence" JSON NOT NULL,
  "suggestedAction" JSON,
  "ruleCode" VARCHAR(100) NOT NULL,
  "ruleVersion" VARCHAR(64) NOT NULL,
  "dedupeKey" VARCHAR(512) NOT NULL,
  "analysisWindowStart" TIMESTAMP(6) NOT NULL,
  "analysisWindowEnd" TIMESTAMP(6) NOT NULL,
  "generatedAt" TIMESTAMP(6) NOT NULL,
  "expiresAt" TIMESTAMP(6),
  "acceptedAt" TIMESTAMP(6),
  "acceptedByAdminUserId" TEXT,
  "dismissedAt" TIMESTAMP(6),
  "dismissedByAdminUserId" TEXT,
  "dismissalReason" TEXT,
  "convertedToTaskId" TEXT,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_recommendations" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_recommendations_connectionId" FOREIGN KEY ("connectionId") REFERENCES "marketing_ad_platform_connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_recommendations_acceptedByAdminUserId" FOREIGN KEY ("acceptedByAdminUserId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_recommendations_dismissedByAdminUserId" FOREIGN KEY ("dismissedByAdminUserId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_recommendations_convertedToTaskId" FOREIGN KEY ("convertedToTaskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_marketing_recommendations_dedupeKey" ON "marketing_recommendations" ("dedupeKey");
CREATE INDEX IF NOT EXISTS "IDX_marketing_recommendations_status_generatedAt" ON "marketing_recommendations" ("status", "generatedAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_recommendations_platform_campaign_status" ON "marketing_recommendations" ("platform", "targetCampaignExternalId", "status");
CREATE INDEX IF NOT EXISTS "IDX_marketing_recommendations_convertedToTaskId" ON "marketing_recommendations" ("convertedToTaskId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_recommendations_connection_status" ON "marketing_recommendations" ("connectionId", "status");

CREATE TABLE IF NOT EXISTS "marketing_alerts" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "type" "marketing_alert_type_enum" NOT NULL,
  "severity" "marketing_alert_severity_enum" NOT NULL,
  "status" "marketing_alert_status_enum" NOT NULL DEFAULT 'OPEN',
  "platform" "marketing_ad_platform_enum",
  "connectionId" TEXT,
  "campaignExternalId" VARCHAR(255),
  "creativeAssetId" TEXT,
  "message" TEXT NOT NULL,
  "evidence" JSON NOT NULL,
  "dedupeKey" VARCHAR(512) NOT NULL,
  "triggeredAt" TIMESTAMP(6) NOT NULL,
  "lastTriggeredAt" TIMESTAMP(6) NOT NULL,
  "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
  "cooldownUntil" TIMESTAMP(6),
  "resolvedAt" TIMESTAMP(6),
  "resolvedByAdminUserId" TEXT,
  "resolutionReason" TEXT,
  "notificationId" TEXT,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_alerts" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_alerts_connectionId" FOREIGN KEY ("connectionId") REFERENCES "marketing_ad_platform_connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_alerts_creativeAssetId" FOREIGN KEY ("creativeAssetId") REFERENCES "marketing_creative_assets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_alerts_resolvedByAdminUserId" FOREIGN KEY ("resolvedByAdminUserId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_alerts_notificationId" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_marketing_alerts_dedupeKey" ON "marketing_alerts" ("dedupeKey");
CREATE INDEX IF NOT EXISTS "IDX_marketing_alerts_status_severity_lastTriggeredAt" ON "marketing_alerts" ("status", "severity", "lastTriggeredAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_alerts_connection_status" ON "marketing_alerts" ("connectionId", "status");
CREATE INDEX IF NOT EXISTS "IDX_marketing_alerts_creative_status" ON "marketing_alerts" ("creativeAssetId", "status");

CREATE TABLE IF NOT EXISTS "marketing_experiments" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "name" VARCHAR(255) NOT NULL,
  "hypothesis" TEXT NOT NULL,
  "platform" "marketing_ad_platform_enum",
  "connectionId" TEXT,
  "campaignExternalId" VARCHAR(255),
  "variantAConfig" JSON NOT NULL,
  "variantBConfig" JSON NOT NULL,
  "metric" "marketing_experiment_metric_enum" NOT NULL,
  "status" "marketing_experiment_status_enum" NOT NULL DEFAULT 'DRAFT',
  "result" JSON,
  "conclusion" TEXT,
  "startedAt" TIMESTAMP(6),
  "endedAt" TIMESTAMP(6),
  "createdByAdminUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_experiments" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_experiments_connectionId" FOREIGN KEY ("connectionId") REFERENCES "marketing_ad_platform_connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_experiments_createdByAdminUserId" FOREIGN KEY ("createdByAdminUserId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "IDX_marketing_experiments_status_createdAt" ON "marketing_experiments" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_experiments_platform_campaign" ON "marketing_experiments" ("platform", "campaignExternalId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_experiments_connection_status" ON "marketing_experiments" ("connectionId", "status");
