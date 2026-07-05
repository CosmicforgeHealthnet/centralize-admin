CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$
BEGIN
  CREATE TYPE marketing_promotion_status_enum AS ENUM ('Upcoming', 'Active', 'Completed', 'Ended');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE marketing_banner_status_enum AS ENUM ('Active', 'Inactive', 'Expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "marketing_promotions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "title" VARCHAR(255) NOT NULL,
  "discountType" VARCHAR(255) NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "grossSales" INTEGER NOT NULL DEFAULT 0,
  "averageRate" DECIMAL(8, 2) NOT NULL DEFAULT 0,
  "grossRevenue" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "status" marketing_promotion_status_enum NOT NULL DEFAULT 'Upcoming',
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_promotions" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "marketing_banners" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "mediaType" VARCHAR(100) NOT NULL,
  "fileName" VARCHAR(255),
  "fileUrl" VARCHAR(1000),
  "imageUrl" VARCHAR(1000),
  "cloudinaryId" VARCHAR(255),
  "title" VARCHAR(255) NOT NULL,
  "description" TEXT NOT NULL,
  "display" JSON,
  "placement" JSON,
  "externalLink" VARCHAR(1000) NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "status" marketing_banner_status_enum NOT NULL DEFAULT 'Inactive',
  "totalImpressions" INTEGER NOT NULL DEFAULT 0,
  "impressionsChange" DECIMAL(8, 2) NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "clicksChange" DECIMAL(8, 2) NOT NULL DEFAULT 0,
  "signup" INTEGER NOT NULL DEFAULT 0,
  "signupChange" DECIMAL(8, 2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_banners" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "marketing_analytics_snapshots" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "overviewStats" JSON,
  "socialStats" JSON,
  "adsPerformance" JSON,
  "locations" JSON,
  "audienceBreakdown" JSON,
  "conversionFunnel" JSON,
  "weeklyEngagement" JSON,
  "performanceData" JSON,
  "platformIntegrations" JSON,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_analytics_snapshots" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "IDX_marketing_promotions_status" ON "marketing_promotions"("status");
CREATE INDEX IF NOT EXISTS "IDX_marketing_promotions_startDate" ON "marketing_promotions"("startDate");
CREATE INDEX IF NOT EXISTS "IDX_marketing_promotions_endDate" ON "marketing_promotions"("endDate");
CREATE INDEX IF NOT EXISTS "IDX_marketing_promotions_createdAt" ON "marketing_promotions"("createdAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_banners_status" ON "marketing_banners"("status");
CREATE INDEX IF NOT EXISTS "IDX_marketing_banners_startDate" ON "marketing_banners"("startDate");
CREATE INDEX IF NOT EXISTS "IDX_marketing_banners_endDate" ON "marketing_banners"("endDate");
CREATE INDEX IF NOT EXISTS "IDX_marketing_banners_createdAt" ON "marketing_banners"("createdAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_analytics_snapshots_createdAt" ON "marketing_analytics_snapshots"("createdAt");