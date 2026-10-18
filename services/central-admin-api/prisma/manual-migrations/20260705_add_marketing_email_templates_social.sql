CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
BEGIN
  CREATE TYPE marketing_social_platform_enum AS ENUM ('Facebook', 'Instagram', 'Youtube', 'Twitter', 'Tiktok', 'LinkedIn');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE marketing_social_post_status_enum AS ENUM ('Published', 'Scheduled', 'Draft', 'Deleted');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "marketing_notification_events" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "eventCode" VARCHAR(20) NOT NULL,
  "event" VARCHAR(255) NOT NULL,
  "notifyEnabled" BOOLEAN NOT NULL DEFAULT true,
  "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
  "whatsappEnabled" BOOLEAN NOT NULL DEFAULT true,
  "smsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "recipients" JSON,
  "validToDate" DATE,
  "customerFullName" VARCHAR(255),
  "customerEmail" VARCHAR(255),
  "customerPhone" VARCHAR(50),
  "customerCountry" VARCHAR(100),
  "emailContent" JSON,
  "conditionalBlock" JSON,
  "whatsappContent" JSON,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_notification_events" PRIMARY KEY ("id"),
  CONSTRAINT "UQ_marketing_notification_events_eventCode" UNIQUE ("eventCode")
);

CREATE TABLE IF NOT EXISTS "marketing_email_templates" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "eventId" TEXT NOT NULL,
  "validFrom" DATE NOT NULL,
  "validTo" DATE NOT NULL,
  "language" VARCHAR(20) NOT NULL,
  "status" VARCHAR(100) NOT NULL DEFAULT 'Active',
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_email_templates" PRIMARY KEY ("id"),
  CONSTRAINT "FK_marketing_email_templates_eventId" FOREIGN KEY ("eventId") REFERENCES "marketing_notification_events"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "marketing_social_accounts" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "platform" marketing_social_platform_enum NOT NULL,
  "username" VARCHAR(255) NOT NULL,
  "connected" BOOLEAN NOT NULL DEFAULT true,
  "encryptedPassword" TEXT,
  "credentialsSaved" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_social_accounts" PRIMARY KEY ("id"),
  CONSTRAINT "UQ_marketing_social_accounts_platform_username" UNIQUE ("platform", "username")
);

CREATE TABLE IF NOT EXISTS "marketing_social_posts" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "platform" marketing_social_platform_enum NOT NULL,
  "caption" TEXT NOT NULL,
  "description" TEXT,
  "excerpt" TEXT,
  "attachmentUrl" VARCHAR(1000),
  "attachmentUrls" JSON,
  "thumbnailUrl" VARCHAR(1000),
  "imageUrl" VARCHAR(1000),
  "postedAt" TIMESTAMP(6),
  "scheduledFor" TIMESTAMP(6),
  "status" marketing_social_post_status_enum NOT NULL DEFAULT 'Draft',
  "followers" INTEGER NOT NULL DEFAULT 0,
  "views" INTEGER NOT NULL DEFAULT 0,
  "totalLikes" INTEGER NOT NULL DEFAULT 0,
  "comments" INTEGER NOT NULL DEFAULT 0,
  "locations" JSON,
  "performance" JSON,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_social_posts" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "marketing_social_analytics_snapshots" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "stats" JSON,
  "locations" JSON,
  "audience" JSON,
  "recentUpload" JSON,
  "weeklyEngagement" JSON,
  "totalEngagementChange" VARCHAR(50),
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_marketing_social_analytics_snapshots" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "IDX_marketing_notification_events_event" ON "marketing_notification_events"("event");
CREATE INDEX IF NOT EXISTS "IDX_marketing_notification_events_validToDate" ON "marketing_notification_events"("validToDate");
CREATE INDEX IF NOT EXISTS "IDX_marketing_notification_events_createdAt" ON "marketing_notification_events"("createdAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_email_templates_eventId" ON "marketing_email_templates"("eventId");
CREATE INDEX IF NOT EXISTS "IDX_marketing_email_templates_validTo" ON "marketing_email_templates"("validTo");
CREATE INDEX IF NOT EXISTS "IDX_marketing_email_templates_createdAt" ON "marketing_email_templates"("createdAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_social_accounts_platform" ON "marketing_social_accounts"("platform");
CREATE INDEX IF NOT EXISTS "IDX_marketing_social_accounts_connected" ON "marketing_social_accounts"("connected");
CREATE INDEX IF NOT EXISTS "IDX_marketing_social_posts_platform" ON "marketing_social_posts"("platform");
CREATE INDEX IF NOT EXISTS "IDX_marketing_social_posts_status" ON "marketing_social_posts"("status");
CREATE INDEX IF NOT EXISTS "IDX_marketing_social_posts_postedAt" ON "marketing_social_posts"("postedAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_social_posts_scheduledFor" ON "marketing_social_posts"("scheduledFor");
CREATE INDEX IF NOT EXISTS "IDX_marketing_social_posts_createdAt" ON "marketing_social_posts"("createdAt");
CREATE INDEX IF NOT EXISTS "IDX_marketing_social_analytics_snapshots_createdAt" ON "marketing_social_analytics_snapshots"("createdAt");
