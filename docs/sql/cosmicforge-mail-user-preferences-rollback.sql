-- Rollback for prisma/manual-migrations/20261102_mail_user_preferences.sql.
-- Run only with Admin DB owner approval, after a verified backup. Code that
-- includes the preferences feature keeps working without the table: GET
-- /me/preferences answers the defaults (notifications on, no preferred
-- sender) and PUT answers 503 MAIL_FEATURE_NOT_READY. Dropping the table
-- deletes every staff member's preferred sender and Mail notification
-- opt-out (no message content). Run before the gap-closure and M7-M10
-- rollbacks (the rollback drill does this).
BEGIN;
DROP TABLE IF EXISTS "mail_user_preferences";
COMMIT;
