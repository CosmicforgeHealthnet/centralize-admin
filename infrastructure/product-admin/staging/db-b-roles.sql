-- DB-B (dedicated Karryam Admin server, cf-product-admin-staging-karryam-admin-db-1):
-- the Karryam Admin database and its migration/runtime roles. Operator runs it
-- once as the DB-B superuser (password file from the secrets directory):
--   psql -v karryam_admin_migrator_password=... -v karryam_admin_runtime_password=... -d postgres -f db-b-roles.sql
-- The CI rehearsal runs this exact file against a disposable DB-B.
-- No HQ role exists on this server.

CREATE ROLE karryam_admin_migrator LOGIN PASSWORD :'karryam_admin_migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
CREATE ROLE karryam_admin_runtime LOGIN PASSWORD :'karryam_admin_runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 20;

CREATE DATABASE karryam_admin OWNER karryam_admin_migrator;
REVOKE ALL ON DATABASE karryam_admin FROM PUBLIC;
GRANT CONNECT ON DATABASE karryam_admin TO karryam_admin_runtime;

\connect karryam_admin
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- Runtime grants: `KARRYAM_ADMIN_RUNTIME_ROLE=karryam_admin_runtime node scripts/migrate.js`.
