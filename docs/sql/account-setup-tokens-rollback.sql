-- Rollback for prisma/manual-migrations/20261031_account_setup_tokens.sql.
-- Run only after deploying code that predates the account setup links, on a
-- backed-up database, by the database owner. Outstanding setup links stop
-- working; affected users need a new invitation/reset from HR once the table
-- is restored. Never run against production without written approval.
BEGIN;
DROP INDEX IF EXISTS "UQ_account_setup_tokens_live";
DROP TABLE IF EXISTS "account_setup_tokens";
COMMIT;
