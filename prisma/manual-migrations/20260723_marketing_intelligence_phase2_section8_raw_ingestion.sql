-- Marketing Intelligence Phase 2, Section 8: categorize creative raw payloads.
ALTER TYPE "marketing_intelligence_run_status_enum" ADD VALUE IF NOT EXISTS 'PARTIAL_SUCCESS';

ALTER TABLE "marketing_ad_insights_raw"
  ADD COLUMN IF NOT EXISTS "payloadCategory" VARCHAR(64) NOT NULL DEFAULT 'CAMPAIGN_INSIGHT',
  ADD COLUMN IF NOT EXISTS "payloadKey" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "requestRangeStart" DATE,
  ADD COLUMN IF NOT EXISTS "requestRangeEnd" DATE,
  ADD COLUMN IF NOT EXISTS "providerRequestId" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "requestMetadata" JSON;

ALTER TABLE "marketing_creative_performance_snapshots"
  ALTER COLUMN "providerConversions" TYPE DECIMAL(18,6)
  USING "providerConversions"::DECIMAL(18,6);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_marketing_ad_insights_raw_payloadKey"
  ON "marketing_ad_insights_raw" ("payloadKey");
