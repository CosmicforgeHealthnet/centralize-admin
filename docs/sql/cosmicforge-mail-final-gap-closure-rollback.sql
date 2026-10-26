-- Rollback for prisma/manual-migrations/20261103_mail_final_gap_closure.sql.
-- Run only with Admin DB owner approval, after a verified backup. Code that
-- includes the final gap-closure features keeps working without these
-- tables: each feature answers 503 MAIL_FEATURE_NOT_READY or falls back to
-- its pre-migration behaviour (templates MARKETING, no cost estimates,
-- storage deletions attempted inline, no quarantine decisions recorded).
-- Dropping the tables discards template classifications, provider
-- subscription state, re-subscription requests, approved pricing, quota
-- observations, cost estimates, automation replay records, the deletion
-- queue (re-run the orphan sweep afterwards), quarantine decision records
-- and provider Message-ID aliases. No message content is stored in them.
-- Run before the preferences, gap-closure and M7-M10 rollbacks (the
-- rollback drill does this).
BEGIN;
DROP TABLE IF EXISTS "mail_message_provider_ids";
DROP TABLE IF EXISTS "mail_quarantine_decisions";
DROP TABLE IF EXISTS "mail_storage_deletions";
DROP TABLE IF EXISTS "marketing_automation_replays";
DROP TABLE IF EXISTS "marketing_dispatch_costs";
DROP TABLE IF EXISTS "mail_provider_quota_observations";
DROP TABLE IF EXISTS "mail_provider_pricing";
DROP TABLE IF EXISTS "marketing_provider_resubscriptions";
DROP TABLE IF EXISTS "marketing_contact_provider_states";
DROP TABLE IF EXISTS "marketing_template_version_policies";
DROP TABLE IF EXISTS "marketing_template_policies";
COMMIT;
