CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS "marketing_attributions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "anonId" VARCHAR(255) NOT NULL,
  "userId" VARCHAR(255),
  "source" VARCHAR(100),
  "platform" marketing_ad_platform_enum,
  "campaignExternalId" VARCHAR(255),
  "campaignName" VARCHAR(512),
  "utmParams" JSONB,
  "firstCapturedAt" TIMESTAMP(6) NOT NULL,
  "lastSeenAt" TIMESTAMP(6) NOT NULL,
  "convertedAt" TIMESTAMP(6),
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_attributions" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_marketing_attributions_anonId" ON "marketing_attributions"("anonId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_attributions_userId" ON "marketing_attributions"("userId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_attributions_platform_campaign" ON "marketing_attributions"("platform", "campaignExternalId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_attributions_firstCapturedAt" ON "marketing_attributions"("firstCapturedAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_attributions_source" ON "marketing_attributions"("source");