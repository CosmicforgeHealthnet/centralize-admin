-- CF Meet Admin database (dedicated server, cf-product-admin-staging-cfmeet-admin-db-1):
-- the CF Meet Admin database and its migration/runtime roles. Operator runs it
-- once as the cfmeet-admin-db superuser (password file from the secrets directory):
--   psql -v cfmeet_admin_migrator_password=... -v cfmeet_admin_runtime_password=... -d postgres -f cfmeet-admin-db-roles.sql
-- The CI rehearsal runs this exact file against a disposable cfmeet-admin-db.
-- No HQ role and no Karryam Admin role exists on this server.

CREATE ROLE cfmeet_admin_migrator LOGIN PASSWORD :'cfmeet_admin_migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
CREATE ROLE cfmeet_admin_runtime LOGIN PASSWORD :'cfmeet_admin_runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 20;

CREATE DATABASE cfmeet_admin OWNER cfmeet_admin_migrator;
REVOKE ALL ON DATABASE cfmeet_admin FROM PUBLIC;
GRANT CONNECT ON DATABASE cfmeet_admin TO cfmeet_admin_runtime;

\connect cfmeet_admin
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- Runtime grants: `CFMEET_ADMIN_RUNTIME_ROLE=cfmeet_admin_runtime node scripts/migrate.js`.
