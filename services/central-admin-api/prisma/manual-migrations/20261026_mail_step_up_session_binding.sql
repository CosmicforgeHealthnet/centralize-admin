-- CosmicForge Mail: bind Mail MFA step-ups to the shared HQ session (Stage A3).
-- Additive only. Requires 20261025_add_admin_sessions_mfa.sql (order 28).
-- Existing rows keep session_id NULL; NULL rows can never be consumed again
-- because consumption now requires the caller's current session id.
-- Rollback: docs/sql/cosmicforge-mail-m7-m10-rollback.sql (section A3).

-- AlterTable
ALTER TABLE "mail_step_up_verifications" ADD COLUMN     "session_id" UUID;

-- CreateIndex
CREATE INDEX "IDX_mail_step_up_session" ON "mail_step_up_verifications"("session_id");
