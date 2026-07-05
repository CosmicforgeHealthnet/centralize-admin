CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$
BEGIN
  CREATE TYPE marketing_campaign_type_enum AS ENUM ('Email', 'Social', 'Events', 'Ads');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE marketing_campaign_status_enum AS ENUM ('Active', 'Drafts', 'Completed', 'Paused', 'Archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE marketing_content_status_enum AS ENUM ('Published', 'Draft');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "marketing_campaigns" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "title" VARCHAR(255) NOT NULL,
  "type" marketing_campaign_type_enum NOT NULL,
  "status" marketing_campaign_status_enum NOT NULL DEFAULT 'Drafts',
  "description" TEXT,
  "budget" DECIMAL(12, 2),
  "progress" INTEGER NOT NULL DEFAULT 0,
  "launchDate" DATE,
  "estCompletion" DATE,
  "targetAudience" TEXT,
  "duration" VARCHAR(100),
  "channels" JSON,
  "overview" TEXT,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_campaigns" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "marketing_campaign_performance" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "campaignId" UUID NOT NULL,
  "opens" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "conversions" INTEGER NOT NULL DEFAULT 0,
  "totalReach" INTEGER NOT NULL DEFAULT 0,
  "engagementRate" DECIMAL(8, 2) NOT NULL DEFAULT 0,
  "conversionRate" DECIMAL(8, 2) NOT NULL DEFAULT 0,
  "costPerClick" DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_campaign_performance" PRIMARY KEY ("id"),
  CONSTRAINT "UQ_marketing_campaign_performance_campaignId" UNIQUE ("campaignId"),
  CONSTRAINT "FK_marketing_campaign_performance_campaignId" FOREIGN KEY ("campaignId") REFERENCES "marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "marketing_campaign_timeline" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "campaignId" UUID NOT NULL,
  "label" VARCHAR(255) NOT NULL,
  "date" DATE NOT NULL,
  "done" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_campaign_timeline" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_campaign_timeline_campaignId" FOREIGN KEY ("campaignId") REFERENCES "marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "marketing_campaign_team_members" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "campaignId" UUID NOT NULL,
  "adminUserId" UUID,
  "role" VARCHAR(150) NOT NULL,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_campaign_team_members" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_campaign_team_members_campaignId" FOREIGN KEY ("campaignId") REFERENCES "marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "FK_marketing_campaign_team_members_adminUserId" FOREIGN KEY ("adminUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "marketing_content_items" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "title" VARCHAR(255) NOT NULL,
  "type" VARCHAR(100) NOT NULL,
  "authorId" UUID,
  "authorName" VARCHAR(255),
  "link" VARCHAR(1000),
  "description" TEXT,
  "status" marketing_content_status_enum NOT NULL DEFAULT 'Draft',
  "performance" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_content_items" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_content_items_authorId" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "marketing_content_monthly_performance" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "contentId" UUID NOT NULL,
  "month" VARCHAR(20) NOT NULL,
  "value" INTEGER NOT NULL DEFAULT 0,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_content_monthly_performance" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_content_monthly_performance_contentId" FOREIGN KEY ("contentId") REFERENCES "marketing_content_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "IDX_marketing_campaigns_status" ON "marketing_campaigns"("status");
CREATE INDEX IF NOT EXISTS "IDX_marketing_campaigns_type" ON "marketing_campaigns"("type");
CREATE INDEX IF NOT EXISTS "IDX_marketing_campaigns_launchDate" ON "marketing_campaigns"("launchDate");
CREATE INDEX IF NOT EXISTS "IDX_marketing_campaigns_createdAt" ON "marketing_campaigns"("createdAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_campaign_performance_campaignId" ON "marketing_campaign_performance"("campaignId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_campaign_timeline_campaignId" ON "marketing_campaign_timeline"("campaignId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_campaign_timeline_order" ON "marketing_campaign_timeline"("sortOrder", "date");
CREATE INDEX IF NOT EXISTS "IDX_marketing_campaign_team_members_campaignId" ON "marketing_campaign_team_members"("campaignId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_campaign_team_members_adminUserId" ON "marketing_campaign_team_members"("adminUserId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_content_items_status" ON "marketing_content_items"("status");
CREATE INDEX IF NOT EXISTS "IDX_marketing_content_items_authorId" ON "marketing_content_items"("authorId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_content_items_updatedAt" ON "marketing_content_items"("updatedAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_content_monthly_performance_contentId" ON "marketing_content_monthly_performance"("contentId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_content_monthly_performance_sortOrder" ON "marketing_content_monthly_performance"("sortOrder");