-- Rollback for prisma/manual-migrations/20261101_mail_spec_gap_closure.sql.
-- Run only with Admin DB owner approval, after a verified backup, and after
-- deploying code that predates the gap-closure features (or with them off:
-- MAIL_BODY_SEARCH_ENABLED=false, MAIL_ARCHIVE_* off). Dropping these tables
-- deletes body-search terms (rebuildable), forwarding rules and their audit
-- state, campaign reply attribution and archive pointers. Archived objects in
-- private storage are NOT deleted; remove them through retention first if
-- required. Run before the M7-M10 rollback (replies reference M7 tables).
BEGIN;
DROP TABLE IF EXISTS "marketing_campaign_replies";
DROP TABLE IF EXISTS "mail_rate_limit_buckets";
DROP TABLE IF EXISTS "mail_forwarding_rules";
DROP TABLE IF EXISTS "mail_message_archives";
DROP TABLE IF EXISTS "mail_message_search_index";
COMMIT;
