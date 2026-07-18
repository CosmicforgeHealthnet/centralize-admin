-- Correct Marketing Intelligence currency column width so the documented
-- UNSPECIFIED default fits safely. This is additive/non-destructive and is
-- required after 20260718 fails on VARCHAR(10) DEFAULT 'UNSPECIFIED'.

ALTER TABLE "marketing_ad_platform_connections"
  ALTER COLUMN "currency" TYPE VARCHAR(16);

ALTER TABLE "marketing_performance_snapshots"
  ADD COLUMN IF NOT EXISTS "currency" VARCHAR(16) NOT NULL DEFAULT 'UNSPECIFIED';

ALTER TABLE "marketing_performance_snapshots"
  ALTER COLUMN "currency" TYPE VARCHAR(16);
