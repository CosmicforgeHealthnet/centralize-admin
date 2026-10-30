-- Operator template: separate migration and runtime credentials for the
-- Product Integration Core registry inside the Central Admin-owned database.
-- Run as a database administrator. Choose passwords out of band and store
-- them in the host secret manager; never commit them.

CREATE ROLE pic_migrator LOGIN PASSWORD :'pic_migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE pic_runtime  LOGIN PASSWORD :'pic_runtime_password'  NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- The migrator may create the dedicated schema in the admin database; the
-- runtime role only connects. Runtime table grants are applied by
-- `PIC_RUNTIME_ROLE=pic_runtime npm run migrate` (DML only, no DDL, no
-- deletes except replay nonces, append-only audit/inbox/lineage/approvals).
GRANT CONNECT, CREATE ON DATABASE cosmicforge_admin TO pic_migrator;
GRANT CONNECT ON DATABASE cosmicforge_admin TO pic_runtime;

-- Karryam Admin has its OWN administrative database; it never shares the
-- HQ registry or any Karryam operational database.
-- CREATE DATABASE karryam_admin;
-- CREATE ROLE karryam_admin_migrator LOGIN PASSWORD :'karryam_admin_migrator_password';
-- CREATE ROLE karryam_admin_runtime  LOGIN PASSWORD :'karryam_admin_runtime_password';
