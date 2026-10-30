-- HQ secure sessions + MFA (Workstreams A/B).
-- NEW TABLES ONLY. No existing table, column or enum is altered, so the API
-- built from this commit can be deployed BEFORE this migration is applied:
-- until the tables exist, src/shared/auth/schema-readiness.js keeps the
-- pre-release login behaviour (admin_refresh_tokens only, no sessions, no MFA).
-- Rollback: docs/sql/hq-auth-sessions-mfa-rollback.sql (drops these tables).

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
CREATE TABLE "admin_session_refresh_tokens" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "rotated_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),

    CONSTRAINT "admin_session_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_mfa_enrollments" (
    "admin_user_id" TEXT NOT NULL,
    "enrolled_at" TIMESTAMP(3),
    "secret_encrypted" TEXT,
    "pending_secret_encrypted" TEXT,
    "pending_expires_at" TIMESTAMP(3),
    "last_used_step" INTEGER,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_mfa_enrollments_pkey" PRIMARY KEY ("admin_user_id")
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

-- CreateTable
CREATE TABLE "admin_auth_events" (
    "id" UUID NOT NULL,
    "admin_user_id" TEXT,
    "action" VARCHAR(64) NOT NULL,
    "target_type" VARCHAR(64),
    "target_id" VARCHAR(128),
    "metadata" JSONB,
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_auth_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IDX_admin_sessions_user_active" ON "admin_sessions"("admin_user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_admin_session_refresh_tokens_hash" ON "admin_session_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "IDX_admin_session_refresh_tokens_session" ON "admin_session_refresh_tokens"("session_id");

-- CreateIndex
CREATE INDEX "IDX_admin_session_refresh_tokens_user" ON "admin_session_refresh_tokens"("admin_user_id");

-- CreateIndex
CREATE INDEX "IDX_admin_mfa_recovery_codes_user" ON "admin_mfa_recovery_codes"("admin_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_admin_mfa_challenges_token" ON "admin_mfa_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "IDX_admin_mfa_challenges_user" ON "admin_mfa_challenges"("admin_user_id");

-- CreateIndex
CREATE INDEX "IDX_admin_auth_events_user_time" ON "admin_auth_events"("admin_user_id", "created_at");

-- CreateIndex
CREATE INDEX "IDX_admin_auth_events_action_time" ON "admin_auth_events"("action", "created_at");

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_session_refresh_tokens" ADD CONSTRAINT "admin_session_refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "admin_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_mfa_enrollments" ADD CONSTRAINT "admin_mfa_enrollments_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_mfa_recovery_codes" ADD CONSTRAINT "admin_mfa_recovery_codes_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_mfa_challenges" ADD CONSTRAINT "admin_mfa_challenges_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_auth_events" ADD CONSTRAINT "admin_auth_events_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Defence in depth for the session/MFA state machines.
ALTER TABLE "admin_sessions" ADD CONSTRAINT "CHK_admin_sessions_mode" CHECK ("mode" IN ('legacy', 'dual', 'cookie'));
ALTER TABLE "admin_sessions" ADD CONSTRAINT "CHK_admin_sessions_expiry_order" CHECK ("idle_expires_at" <= "absolute_expires_at");
ALTER TABLE "admin_mfa_challenges" ADD CONSTRAINT "CHK_admin_mfa_challenges_attempts" CHECK ("attempts" >= 0 AND "attempts" <= 10);
ALTER TABLE "admin_mfa_enrollments" ADD CONSTRAINT "CHK_admin_mfa_enrollments_verified" CHECK ("enrolled_at" IS NULL OR "secret_encrypted" IS NOT NULL);
ALTER TABLE "admin_mfa_enrollments" ADD CONSTRAINT "CHK_admin_mfa_enrollments_failures" CHECK ("failed_attempts" >= 0);
