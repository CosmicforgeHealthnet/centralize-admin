ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_CREATIVE_SYNCED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_CREATIVE_SCORED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_INTELLIGENCE_SYNCED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_INTELLIGENCE_SETTINGS_UPDATED';

ALTER TABLE "marketing_intelligence_settings"
  ADD COLUMN IF NOT EXISTS "currencyCode" VARCHAR(3);

DROP INDEX IF EXISTS "IDX_marketing_intelligence_settings_scope";
CREATE INDEX IF NOT EXISTS "IDX_marketing_intelligence_settings_scope"
  ON "marketing_intelligence_settings" ("scopeType", "platform", "connectionId", "currencyCode");
