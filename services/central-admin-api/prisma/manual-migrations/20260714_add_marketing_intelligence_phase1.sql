CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
BEGIN
  CREATE TYPE marketing_ad_platform_enum AS ENUM ('META', 'TIKTOK');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE marketing_ad_connection_status_enum AS ENUM ('ACTIVE', 'DISABLED', 'ERROR');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE marketing_funnel_stage_enum AS ENUM ('CLICK', 'SIGNUP', 'ACTIVE', 'PAYMENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "marketing_ad_platform_connections" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "platform" marketing_ad_platform_enum NOT NULL,
  "accountId" VARCHAR(255) NOT NULL,
  "accessToken" TEXT NOT NULL,
  "refreshToken" TEXT,
  "status" marketing_ad_connection_status_enum NOT NULL DEFAULT 'ACTIVE',
  "lastSyncedAt" TIMESTAMP(6),
  "lastSyncError" TEXT,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_ad_platform_connections" PRIMARY KEY ("id"),
  CONSTRAINT "UQ_marketing_ad_platform_connections_platform_accountId" UNIQUE ("platform", "accountId")
);

CREATE TABLE IF NOT EXISTS "marketing_ad_insights_raw" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "platform" marketing_ad_platform_enum NOT NULL,
  "campaignExternalId" VARCHAR(255) NOT NULL,
  "date" DATE NOT NULL,
  "rawJson" JSON NOT NULL,
  "fetchedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_ad_insights_raw" PRIMARY KEY ("id"),
  CONSTRAINT "UQ_marketing_ad_insights_raw_platform_campaign_date" UNIQUE ("platform", "campaignExternalId", "date")
);

CREATE TABLE IF NOT EXISTS "marketing_performance_snapshots" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "platform" marketing_ad_platform_enum NOT NULL,
  "campaignExternalId" VARCHAR(255) NOT NULL,
  "campaignName" VARCHAR(512) NOT NULL,
  "date" DATE NOT NULL,
  "spend" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "signups" INTEGER NOT NULL DEFAULT 0,
  "activeUsers" INTEGER NOT NULL DEFAULT 0,
  "payments" INTEGER NOT NULL DEFAULT 0,
  "revenue" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  "cpa" DECIMAL(14, 2) NOT NULL DEFAULT 0,
  "conversionRate" DECIMAL(8, 2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_performance_snapshots" PRIMARY KEY ("id"),
  CONSTRAINT "UQ_marketing_performance_snapshots_platform_campaign_date" UNIQUE ("platform", "campaignExternalId", "date")
);

CREATE TABLE IF NOT EXISTS "marketing_funnel_events" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId" VARCHAR(255),
  "anonId" VARCHAR(255),
  "stage" marketing_funnel_stage_enum NOT NULL,
  "source" VARCHAR(100),
  "campaignExternalId" VARCHAR(255),
  "utmParams" JSON,
  "value" DECIMAL(14, 2),
  "currency" VARCHAR(10),
  "externalEventId" VARCHAR(255),
  "occurredAt" TIMESTAMP(6) NOT NULL,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_funnel_events" PRIMARY KEY ("id"),
  CONSTRAINT "UQ_marketing_funnel_events_externalEventId" UNIQUE ("externalEventId")
);

CREATE TABLE IF NOT EXISTS "marketing_sync_locks" (
  "key" VARCHAR(255) NOT NULL,
  "owner" VARCHAR(255) NOT NULL,
  "expiresAt" TIMESTAMP(6) NOT NULL,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_sync_locks" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "IDX_marketing_ad_platform_connections_platform_status" ON "marketing_ad_platform_connections"("platform", "status");
CREATE INDEX IF NOT EXISTS "IDX_marketing_ad_insights_raw_platform_date" ON "marketing_ad_insights_raw"("platform", "date");
CREATE INDEX IF NOT EXISTS "IDX_marketing_ad_insights_raw_campaignExternalId" ON "marketing_ad_insights_raw"("campaignExternalId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_performance_snapshots_date" ON "marketing_performance_snapshots"("date");
CREATE INDEX IF NOT EXISTS "IDX_marketing_performance_snapshots_platform_date" ON "marketing_performance_snapshots"("platform", "date");
CREATE INDEX IF NOT EXISTS "IDX_marketing_performance_snapshots_campaignExternalId" ON "marketing_performance_snapshots"("campaignExternalId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_funnel_events_campaign_stage_occurredAt" ON "marketing_funnel_events"("campaignExternalId", "stage", "occurredAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_funnel_events_stage_occurredAt" ON "marketing_funnel_events"("stage", "occurredAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_funnel_events_source" ON "marketing_funnel_events"("source");
CREATE INDEX IF NOT EXISTS "IDX_marketing_funnel_events_userId" ON "marketing_funnel_events"("userId");
