ALTER TABLE "marketing_ad_platform_connections" ADD COLUMN IF NOT EXISTS "accessTokenExpiresAt" TIMESTAMP(6);
ALTER TABLE "marketing_ad_platform_connections" ADD COLUMN IF NOT EXISTS "refreshTokenExpiresAt" TIMESTAMP(6);
