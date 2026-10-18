-- Finalize Marketing Intelligence account-aware persistence and OAuth state.
-- Safe for existing data: adds account/connection metadata, backfills existing
-- insight rows to UNKNOWN account, and replaces platform-only campaign/day
-- uniqueness with platform + account + campaign/day uniqueness.

ALTER TABLE "marketing_ad_insights_raw"
  ADD COLUMN IF NOT EXISTS "connectionId" TEXT,
  ADD COLUMN IF NOT EXISTS "accountId" VARCHAR(255) NOT NULL DEFAULT 'UNKNOWN';

ALTER TABLE "marketing_performance_snapshots"
  ADD COLUMN IF NOT EXISTS "connectionId" TEXT,
  ADD COLUMN IF NOT EXISTS "accountId" VARCHAR(255) NOT NULL DEFAULT 'UNKNOWN';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'FK_marketing_ad_insights_raw_connectionId'
  ) THEN
    ALTER TABLE "marketing_ad_insights_raw"
      ADD CONSTRAINT "FK_marketing_ad_insights_raw_connectionId"
      FOREIGN KEY ("connectionId")
      REFERENCES "marketing_ad_platform_connections"("id")
      ON DELETE SET NULL
      ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'FK_marketing_performance_snapshots_connectionId'
  ) THEN
    ALTER TABLE "marketing_performance_snapshots"
      ADD CONSTRAINT "FK_marketing_performance_snapshots_connectionId"
      FOREIGN KEY ("connectionId")
      REFERENCES "marketing_ad_platform_connections"("id")
      ON DELETE SET NULL
      ON UPDATE NO ACTION;
  END IF;
END $$;

ALTER TABLE "marketing_ad_insights_raw"
  DROP CONSTRAINT IF EXISTS "UQ_marketing_ad_insights_raw_platform_campaign_date";

ALTER TABLE "marketing_performance_snapshots"
  DROP CONSTRAINT IF EXISTS "UQ_marketing_performance_snapshots_platform_campaign_date";

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_marketing_ad_insights_raw_platform_account_campaign_date"
  ON "marketing_ad_insights_raw" ("platform", "accountId", "campaignExternalId", "date");

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_marketing_perf_snapshots_platform_account_campaign_date"
  ON "marketing_performance_snapshots" ("platform", "accountId", "campaignExternalId", "date");

CREATE INDEX IF NOT EXISTS "IDX_marketing_ad_insights_raw_connectionId"
  ON "marketing_ad_insights_raw" ("connectionId");

CREATE INDEX IF NOT EXISTS "IDX_marketing_ad_insights_raw_platform_account_date"
  ON "marketing_ad_insights_raw" ("platform", "accountId", "date");

CREATE INDEX IF NOT EXISTS "IDX_marketing_performance_snapshots_connectionId"
  ON "marketing_performance_snapshots" ("connectionId");

CREATE INDEX IF NOT EXISTS "IDX_marketing_performance_snapshots_platform_account_date"
  ON "marketing_performance_snapshots" ("platform", "accountId", "date");

CREATE TABLE IF NOT EXISTS "marketing_oauth_states" (
  "id" TEXT NOT NULL,
  "stateHash" VARCHAR(128) NOT NULL,
  "platform" "marketing_ad_platform_enum" NOT NULL,
  "adminUserId" VARCHAR(255) NOT NULL,
  "connectionId" TEXT,
  "accountId" VARCHAR(255),
  "encryptedVerifier" TEXT,
  "encryptedSecret" TEXT,
  "metadata" JSON,
  "expiresAt" TIMESTAMP(6) NOT NULL,
  "usedAt" TIMESTAMP(6),
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_oauth_states" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'FK_marketing_oauth_states_connectionId'
  ) THEN
    ALTER TABLE "marketing_oauth_states"
      ADD CONSTRAINT "FK_marketing_oauth_states_connectionId"
      FOREIGN KEY ("connectionId")
      REFERENCES "marketing_ad_platform_connections"("id")
      ON DELETE SET NULL
      ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_marketing_oauth_states_stateHash"
  ON "marketing_oauth_states" ("stateHash");

CREATE INDEX IF NOT EXISTS "IDX_marketing_oauth_states_platform_expiresAt"
  ON "marketing_oauth_states" ("platform", "expiresAt");

CREATE INDEX IF NOT EXISTS "IDX_marketing_oauth_states_adminUserId"
  ON "marketing_oauth_states" ("adminUserId");

CREATE INDEX IF NOT EXISTS "IDX_marketing_oauth_states_connectionId"
  ON "marketing_oauth_states" ("connectionId");
