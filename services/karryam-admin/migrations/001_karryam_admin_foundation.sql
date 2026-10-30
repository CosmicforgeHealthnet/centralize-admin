-- Karryam Admin foundation schema (forward-only).
-- Dedicated Karryam Admin database objects only. No Karryam operational or
-- source tables, no HQ tables. Roles and passwords are provisioned by the
-- operator, never here; runtime grants are applied by scripts/migrate.js.

CREATE SCHEMA IF NOT EXISTS karryam_admin;

-- Append-only integration and security audit.
CREATE TABLE karryam_admin.integration_audit (
  id             bigserial PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  correlation_id text,
  request_id     text,
  endpoint       text,
  method         text,
  service_id     text,
  staff_ref      text,
  action         text,
  operation_id   uuid,
  outcome        text NOT NULL CHECK (outcome ~ '^[A-Z][A-Z0-9_]{1,47}$'),
  reason_code    text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX integration_audit_operation_idx ON karryam_admin.integration_audit (operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX integration_audit_occurred_idx ON karryam_admin.integration_audit (occurred_at);

CREATE FUNCTION karryam_admin.reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'karryam_admin.integration_audit is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER integration_audit_no_update_delete
  BEFORE UPDATE OR DELETE ON karryam_admin.integration_audit
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.reject_audit_mutation();
CREATE TRIGGER integration_audit_no_truncate
  BEFORE TRUNCATE ON karryam_admin.integration_audit
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_audit_mutation();

-- Durable replay protection for service nonces and delegation JTIs.
CREATE TABLE karryam_admin.request_nonces (
  namespace  text NOT NULL,
  nonce      text NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, nonce)
);
CREATE INDEX request_nonces_expiry_idx ON karryam_admin.request_nonces (expires_at);

-- Operation submissions. In this phase nothing executes: the only status the
-- database accepts is REJECTED.
CREATE TABLE karryam_admin.operation_requests (
  id              uuid PRIMARY KEY,
  service_id      text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest  text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  capability_id   text NOT NULL,
  staff_ref       text NOT NULL,
  status          text NOT NULL CHECK (status = 'REJECTED'),
  reason_code     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operation_requests_idempotency_unique UNIQUE (service_id, idempotency_key)
);
