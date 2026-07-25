-- Sections 10-13 compliance audit corrections.
-- Additive state used to prove consecutive recommendation recovery before expiry.

ALTER TABLE "marketing_recommendations"
  ADD COLUMN IF NOT EXISTS "recoveryStreak" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "IDX_marketing_recommendations_pending_recovery"
  ON "marketing_recommendations" ("status", "recoveryStreak", "expiresAt");
