ALTER TABLE "marketing_ad_platform_connections"
  ADD COLUMN IF NOT EXISTS "encryptedCredentials" TEXT,
  ADD COLUMN IF NOT EXISTS "credentialVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "connectionMetadata" JSON,
  ADD COLUMN IF NOT EXISTS "currency" VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "requiresReauthorization" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "marketing_performance_snapshots"
  ADD COLUMN IF NOT EXISTS "currency" VARCHAR(10) NOT NULL DEFAULT 'UNSPECIFIED';
