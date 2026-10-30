-- CosmicForge Mail: per-user preferences (spec section 15 "Profiles").
-- Additive only; ONE NEW TABLE. No existing table gains a column, so code
-- deployed before this migration never selects anything that is missing.
-- Until it is applied, GET /me/preferences answers the defaults (Mail
-- notifications on, no preferred sender), PUT /me/preferences answers 503
-- MAIL_FEATURE_NOT_READY and every other Mail feature keeps working.
--   mail_user_preferences  preferred sender identity + Mail notification opt-out
-- The preferred sender is re-authorized against live memberships and sender
-- grants on every use; deleting the address clears it (ON DELETE SET NULL).
-- Rollback: docs/sql/cosmicforge-mail-user-preferences-rollback.sql.
-- CreateTable
CREATE TABLE "mail_user_preferences" (
    "admin_user_id" TEXT NOT NULL,
    "default_sender_address_id" UUID,
    "notifications_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_user_preferences_pkey" PRIMARY KEY ("admin_user_id")
);

-- CreateIndex
CREATE INDEX "IDX_mail_user_preferences_default_sender" ON "mail_user_preferences"("default_sender_address_id");

-- AddForeignKey
ALTER TABLE "mail_user_preferences" ADD CONSTRAINT "FK_mail_user_preferences_admin_user" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mail_user_preferences" ADD CONSTRAINT "FK_mail_user_preferences_default_sender" FOREIGN KEY ("default_sender_address_id") REFERENCES "mail_addresses"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
