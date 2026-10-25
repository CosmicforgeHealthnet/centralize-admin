-- Rollback for 20261025_add_admin_sessions_mfa.sql (manual, reviewed use only).
--
-- The migration only ADDED tables, so rollback only drops them.
-- ORDER: set AUTH_SESSION_MODE=legacy, run this script, then RESTART the API.
-- Schema readiness is cached as "ready" for the life of the process; after the
-- restart the probe sees the tables are gone and serves the pre-release legacy
-- login (tokens bound to a session are refused; users sign in again).
-- Effects: every session-based login ends (users sign in again); every MFA
-- enrollment, recovery code and auth event is DELETED. admin_users and
-- admin_refresh_tokens are untouched (twoFactorEnabled may stay true for users
-- who had enrolled; it is a compatibility flag and is never MFA evidence).
-- Take a backup first (see docs/hq-auth-sessions-and-mfa.md).

BEGIN;

DROP TABLE IF EXISTS "admin_session_refresh_tokens";
DROP TABLE IF EXISTS "admin_sessions";
DROP TABLE IF EXISTS "admin_mfa_challenges";
DROP TABLE IF EXISTS "admin_mfa_recovery_codes";
DROP TABLE IF EXISTS "admin_mfa_enrollments";
DROP TABLE IF EXISTS "admin_auth_events";

DELETE FROM "social_manual_migrations" WHERE "file" = '20261025_add_admin_sessions_mfa.sql';

COMMIT;
