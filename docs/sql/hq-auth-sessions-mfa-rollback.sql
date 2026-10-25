-- Rollback for 20261025_add_admin_sessions_mfa.sql (manual, reviewed use only).
--
-- Run ONLY after the API is back on a build without server-side sessions
-- (or with AUTH_SESSION_MODE=legacy on a build that still tolerates the
-- columns being absent - i.e. the previous release). Effects:
--   * every session-based login ends (users sign in again);
--   * every MFA enrollment and recovery code is DELETED (users re-enroll);
--   * AuditAction values added by the migration stay (PostgreSQL cannot drop
--     enum values); they are unused afterwards and harmless.
-- Take a backup first (see docs/hq-auth-sessions-and-mfa.md).

BEGIN;

ALTER TABLE "admin_refresh_tokens" DROP CONSTRAINT IF EXISTS "admin_refresh_tokens_session_id_fkey";
DROP INDEX IF EXISTS "IDX_admin_refresh_tokens_session";
ALTER TABLE "admin_refresh_tokens" DROP COLUMN IF EXISTS "session_id", DROP COLUMN IF EXISTS "rotated_at";

DROP TABLE IF EXISTS "admin_mfa_challenges";
DROP TABLE IF EXISTS "admin_mfa_recovery_codes";
DROP TABLE IF EXISTS "admin_sessions";

-- Keep the compatibility flag honest: no verified enrollment survives rollback.
UPDATE "admin_users" SET "twoFactorEnabled" = false WHERE "mfa_enrolled_at" IS NOT NULL;

ALTER TABLE "admin_users"
  DROP COLUMN IF EXISTS "mfa_enrolled_at",
  DROP COLUMN IF EXISTS "mfa_secret_encrypted",
  DROP COLUMN IF EXISTS "mfa_pending_secret_encrypted",
  DROP COLUMN IF EXISTS "mfa_pending_expires_at",
  DROP COLUMN IF EXISTS "mfa_last_used_step",
  DROP COLUMN IF EXISTS "mfa_failed_attempts",
  DROP COLUMN IF EXISTS "mfa_locked_until";

DELETE FROM "social_manual_migrations" WHERE "file" = '20261025_add_admin_sessions_mfa.sql';

COMMIT;
