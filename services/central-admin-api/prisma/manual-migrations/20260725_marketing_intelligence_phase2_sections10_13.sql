-- Phase 2 Sections 10-13: additive lifecycle foundations.

ALTER TYPE "marketing_recommendation_type_enum" ADD VALUE IF NOT EXISTS 'PAUSE';
ALTER TYPE "marketing_recommendation_type_enum" ADD VALUE IF NOT EXISTS 'SCALE';
ALTER TYPE "marketing_recommendation_type_enum" ADD VALUE IF NOT EXISTS 'CREATE_CONTENT';
ALTER TYPE "marketing_recommendation_status_enum" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "marketing_recommendation_status_enum" ADD VALUE IF NOT EXISTS 'CONVERTED_TO_TASK';

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_RECOMMENDATION_EVALUATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_RECOMMENDATION_ACCEPTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_RECOMMENDATION_DISMISSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_ALERT_EVALUATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_ALERT_ACKNOWLEDGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_ALERT_RESOLVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_RECOMMENDATION_TASK_CONVERTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_EXPERIMENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_EXPERIMENT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_EXPERIMENT_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_EXPERIMENT_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MARKETING_EXPERIMENT_CANCELLED';

ALTER TYPE "marketing_alert_type_enum" ADD VALUE IF NOT EXISTS 'CPA_TARGET_BREACH';
ALTER TYPE "marketing_alert_type_enum" ADD VALUE IF NOT EXISTS 'SPEND_WITHOUT_CONVERSION';
ALTER TYPE "marketing_alert_type_enum" ADD VALUE IF NOT EXISTS 'CONVERSION_RATE_DROP';
ALTER TYPE "marketing_alert_type_enum" ADD VALUE IF NOT EXISTS 'SYNC_STALE';
ALTER TYPE "marketing_alert_type_enum" ADD VALUE IF NOT EXISTS 'CAMPAIGN_PERFORMANCE_DROP';
ALTER TYPE "marketing_alert_type_enum" ADD VALUE IF NOT EXISTS 'HIGH_PERFORMING_CAMPAIGN';
ALTER TYPE "marketing_alert_type_enum" ADD VALUE IF NOT EXISTS 'TOKEN_REFRESH_FAILED';
ALTER TYPE "marketing_alert_type_enum" ADD VALUE IF NOT EXISTS 'CONNECTION_DEGRADED';
ALTER TYPE "marketing_alert_type_enum" ADD VALUE IF NOT EXISTS 'PLATFORM_PERMISSION_ERROR';

ALTER TABLE "marketing_recommendations"
  ADD COLUMN IF NOT EXISTS "materialEvidenceFingerprint" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "lastEvaluatedAt" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "expirationReason" VARCHAR(255);

CREATE INDEX IF NOT EXISTS "IDX_marketing_recommendations_evidence_fingerprint"
  ON "marketing_recommendations" ("materialEvidenceFingerprint");

ALTER TABLE "marketing_alerts"
  ADD COLUMN IF NOT EXISTS "conditionKey" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "lifecycle" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "currencyCode" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "recoveryStreak" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "acknowledgedAt" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "acknowledgedByAdminUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryFailure" VARCHAR(500);

UPDATE "marketing_alerts"
SET "conditionKey" = encode(digest("dedupeKey", 'sha256'), 'hex')
WHERE "conditionKey" IS NULL;

ALTER TABLE "marketing_alerts" ALTER COLUMN "conditionKey" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "IDX_marketing_alerts_condition_status"
  ON "marketing_alerts" ("conditionKey", "status");

DO $$ BEGIN
  ALTER TABLE "marketing_alerts"
    ADD CONSTRAINT "FK_marketing_alerts_acknowledgedByAdminUserId"
    FOREIGN KEY ("acknowledgedByAdminUserId") REFERENCES "admin_users"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_marketing_recommendations_convertedToTaskId"
  ON "marketing_recommendations" ("convertedToTaskId")
  WHERE "convertedToTaskId" IS NOT NULL;

ALTER TABLE "marketing_experiments"
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "cancellationReason" TEXT;
