-- Operator template (Section 9.1 database ownership and role separation).
-- Run with psql as a database administrator, passing passwords as psql
-- variables chosen out of band (host secret manager); never commit them:
--   psql -v pic_migrator_password=... -v pic_runtime_password=... \
--        -v karryam_admin_migrator_password=... -v karryam_admin_runtime_password=... -f postgres-roles.example.sql
-- Applications never run this file and never create roles at startup.

-- ---------------------------------------------------------------------------
-- Headquarters: Product Integration Core inside the Central Admin-owned
-- database, isolated in schema hq_integration.
-- ---------------------------------------------------------------------------
CREATE ROLE pic_migrator LOGIN PASSWORD :'pic_migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
CREATE ROLE pic_runtime LOGIN PASSWORD :'pic_runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 20;

-- The migrator may create the dedicated schema in the admin database; the
-- runtime role only connects. Runtime table grants are applied, exactly and
-- atomically, by `PIC_RUNTIME_ROLE=pic_runtime npm run migrate` (DML only,
-- no DDL, no deletes except expired replay nonces, append-only evidence).
GRANT CONNECT, CREATE ON DATABASE cosmicforge_admin TO pic_migrator;
GRANT CONNECT ON DATABASE cosmicforge_admin TO pic_runtime;
-- Neither role receives anything on Mail, HealthNet, Marketing or Central
-- Admin authentication schemas.

-- ---------------------------------------------------------------------------
-- Karryam Admin: its OWN administrative database. It never shares the HQ
-- registry or any Karryam operational (Taxi, Dispatch, Vendor, Wallet, Fleet)
-- database, and no HQ role can connect to it.
-- ---------------------------------------------------------------------------
CREATE ROLE karryam_admin_migrator LOGIN PASSWORD :'karryam_admin_migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
CREATE ROLE karryam_admin_runtime LOGIN PASSWORD :'karryam_admin_runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 20;

CREATE DATABASE karryam_admin OWNER karryam_admin_migrator;
REVOKE ALL ON DATABASE karryam_admin FROM PUBLIC;
GRANT CONNECT ON DATABASE karryam_admin TO karryam_admin_runtime;

\connect karryam_admin
-- PostgreSQL 15+ already denies CREATE on schema public to PUBLIC; make it explicit.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- Runtime grants: `KARRYAM_ADMIN_RUNTIME_ROLE=karryam_admin_runtime npm run migrate`.

-- Verification (expected: all false):
--   SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname LIKE '%runtime';
--   SELECT has_database_privilege('pic_runtime', 'karryam_admin', 'CONNECT');
--   SELECT has_database_privilege('karryam_admin_runtime', 'cosmicforge_admin', 'CONNECT');
-- The last check is true while PUBLIC still holds CONNECT on cosmicforge_admin
-- (the PostgreSQL default). Karryam Admin still has no USAGE on
-- hq_integration and cannot read it, but to close the connection path the
-- operator should first GRANT CONNECT explicitly to every existing Central
-- Admin role that needs it and then:
--   REVOKE CONNECT ON DATABASE cosmicforge_admin FROM PUBLIC;
-- (Not automated here: revoking PUBLIC without those grants would cut off
-- existing services.)
-- Then `npm run migrate -- --preview` for each service must report ok: true.
