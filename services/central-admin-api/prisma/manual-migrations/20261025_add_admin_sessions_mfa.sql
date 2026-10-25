-- HQ secure sessions + MFA lifecycle (Workstreams A/B).
-- Additive only: new columns are nullable or defaulted, new tables are empty,
-- AuditAction gains values. No existing row is rewritten.
-- Rollback: docs/sql/hq-auth-sessions-mfa-rollback.sql (enum values cannot be
-- removed in PostgreSQL and are left in place; they are harmless).

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SESSION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SESSION_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SESSIONS_REVOKED_ALL';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REFRESH_TOKEN_REUSE_DETECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CSRF_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MFA_ENROLLMENT_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MFA_ENROLLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MFA_CHALLENGE_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MFA_VERIFIED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MFA_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MFA_LOCKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MFA_RECOVERY_CODE_USED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MFA_RECOVERY_CODES_REGENERATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MFA_DISABLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MFA_ADMIN_RESET';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MFA_STEP_UP';

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "mfa_enrolled_at" TIMESTAMP(3),
ADD COLUMN     "mfa_failed_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfa_last_used_step" INTEGER,
ADD COLUMN     "mfa_locked_until" TIMESTAMP(3),
ADD COLUMN     "mfa_pending_expires_at" TIMESTAMP(3),
ADD COLUMN     "mfa_pending_secret_encrypted" TEXT,
ADD COLUMN     "mfa_secret_encrypted" TEXT;

-- AlterTable
ALTER TABLE "admin_refresh_tokens" ADD COLUMN     "rotated_at" TIMESTAMP(3),
ADD COLUMN     "session_id" UUID;

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" UUID NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "mode" VARCHAR(16) NOT NULL,
    "auth_method" VARCHAR(32) NOT NULL,
    "csrf_nonce" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMP(3) NOT NULL,
    "absolute_expires_at" TIMESTAMP(3) NOT NULL,
    "mfa_verified_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoke_reason" VARCHAR(64),
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_mfa_recovery_codes" (
    "id" UUID NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "salt" VARCHAR(64) NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "admin_mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_mfa_challenges" (
    "id" UUID NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "auth_method" VARCHAR(32) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),

    CONSTRAINT "admin_mfa_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IDX_admin_sessions_user_active" ON "admin_sessions"("admin_user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "IDX_admin_mfa_recovery_codes_user" ON "admin_mfa_recovery_codes"("admin_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_admin_mfa_challenges_token" ON "admin_mfa_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "IDX_admin_mfa_challenges_user" ON "admin_mfa_challenges"("admin_user_id");

-- CreateIndex
CREATE INDEX "IDX_admin_refresh_tokens_session" ON "admin_refresh_tokens"("session_id");

-- AddForeignKey
ALTER TABLE "admin_refresh_tokens" ADD CONSTRAINT "admin_refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "admin_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_mfa_recovery_codes" ADD CONSTRAINT "admin_mfa_recovery_codes_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_mfa_challenges" ADD CONSTRAINT "admin_mfa_challenges_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defence in depth for the session state machine.
ALTER TABLE "admin_sessions" ADD CONSTRAINT "CHK_admin_sessions_mode" CHECK ("mode" IN ('legacy', 'dual', 'cookie'));
ALTER TABLE "admin_sessions" ADD CONSTRAINT "CHK_admin_sessions_expiry_order" CHECK ("idle_expires_at" <= "absolute_expires_at");
ALTER TABLE "admin_mfa_challenges" ADD CONSTRAINT "CHK_admin_mfa_challenges_attempts" CHECK ("attempts" >= 0 AND "attempts" <= 10);
