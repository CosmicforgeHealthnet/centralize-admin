-- Expiring, single-use account setup / password links (P0 security fix,
-- specification section 3: "stop sending passwords in plaintext").
-- Replaces emailed temporary passwords for lab-admin approval, HR account
-- invitations and HR-approved password resets. Additive only. Only the
-- SHA-256 of each link secret is stored; the subject may be an Admin user or a
-- HealthNet product user, so no cross-database foreign key exists.
-- Rollback: docs/sql/account-setup-tokens-rollback.sql.

-- CreateTable
CREATE TABLE "account_setup_tokens" (
    "id" UUID NOT NULL,
    "purpose" VARCHAR(32) NOT NULL,
    "subject_kind" VARCHAR(32) NOT NULL,
    "subject_id" VARCHAR(64) NOT NULL,
    "email_domain" VARCHAR(253),
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_by" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_setup_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UQ_account_setup_tokens_hash" ON "account_setup_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "IDX_account_setup_tokens_subject" ON "account_setup_tokens"("subject_kind", "subject_id", "purpose");

-- CreateIndex
CREATE INDEX "IDX_account_setup_tokens_expires" ON "account_setup_tokens"("expires_at");

-- Integrity: known purposes/subjects, a real hash, expiry after creation and
-- at most one live (unused, unrevoked) link per subject and purpose.
ALTER TABLE "account_setup_tokens"
  ADD CONSTRAINT "CHK_account_setup_tokens_purpose" CHECK ("purpose" IN ('ADMIN_INVITE', 'ADMIN_PASSWORD_RESET', 'LAB_ADMIN_SETUP')),
  ADD CONSTRAINT "CHK_account_setup_tokens_subject_kind" CHECK ("subject_kind" IN ('ADMIN_USER', 'HEALTHNET_USER')),
  ADD CONSTRAINT "CHK_account_setup_tokens_hash" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "CHK_account_setup_tokens_expiry" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "CHK_account_setup_tokens_attempts" CHECK ("attempts" >= 0);
CREATE UNIQUE INDEX "UQ_account_setup_tokens_live" ON "account_setup_tokens"("subject_kind", "subject_id", "purpose") WHERE "used_at" IS NULL AND "revoked_at" IS NULL;
