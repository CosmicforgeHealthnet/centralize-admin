-- DB-A (existing HQ database server, admin-server-staging-db-1): roles for the
-- Product Integration Core only. Operator runs it once as the database
-- administrator, with passwords chosen out of band (never committed):
--   psql -v pic_migrator_password=... -v pic_runtime_password=... -d cosmicforge_admin -f db-a-roles.sql
-- The CI rehearsal runs this exact file against a disposable server.
-- Karryam Admin has no role here: its database is a different server (DB-B).

CREATE ROLE pic_migrator LOGIN PASSWORD :'pic_migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
CREATE ROLE pic_runtime LOGIN PASSWORD :'pic_runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 20;

-- The migrator may create schema hq_integration; the runtime role only
-- connects. Exact runtime table grants come from
-- `PIC_RUNTIME_ROLE=pic_runtime node scripts/migrate.js` (DML only).
GRANT CONNECT, CREATE ON DATABASE cosmicforge_admin TO pic_migrator;
GRANT CONNECT ON DATABASE cosmicforge_admin TO pic_runtime;

-- Verification (expected: f f f f for both):
--   SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname LIKE 'pic_%';
-- PUBLIC CONNECT on cosmicforge_admin is NOT revoked here: first grant
-- CONNECT explicitly to every existing Central Admin role, then revoke
-- (database-migration-runbook.md). Until then db-audit reports it pending.
