-- Product Integration Core: Headquarters Product Admin registry (v001).
--
-- Dedicated, logically isolated schema inside the Central Admin-owned
-- PostgreSQL. It does not touch admin_ops_service_registry, Mail, HealthNet
-- or any product/operational database. Forward-only: corrections are new
-- migrations. No roles or passwords are created here; runtime grants are
-- applied by scripts/migrate.js to an operator-provisioned role.

CREATE SCHEMA IF NOT EXISTS hq_integration;

-- Shared guards -----------------------------------------------------------

CREATE OR REPLACE FUNCTION hq_integration.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Product Admin registrations ----------------------------------------------

CREATE TABLE hq_integration.hq_product_admins (
  id uuid PRIMARY KEY,
  product_id text NOT NULL CHECK (product_id ~ '^[a-z][a-z0-9-]{1,31}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 64),
  service_instance_id text NOT NULL CHECK (service_instance_id ~ '^[a-z0-9][a-z0-9.-]{2,63}$'),
  environment text NOT NULL CHECK (environment IN ('test', 'development', 'staging', 'production')),
  -- Reference into the operator-controlled endpoint allowlist. The address,
  -- TLS material and keys live there, never in this table.
  endpoint_ref text NOT NULL CHECK (endpoint_ref ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  workload_identity text NOT NULL CHECK (workload_identity ~ '^(spiffe|cf)://[a-z0-9.-]{1,63}(/[A-Za-z0-9._-]{1,63}){1,6}$'),
  identity_fingerprint_ref text NULL CHECK (identity_fingerprint_ref IS NULL OR identity_fingerprint_ref ~ '^sha256:[0-9a-f]{64}$'),
  approved_signer_kid text NOT NULL CHECK (approved_signer_kid ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  supported_protocol_major integer NOT NULL DEFAULT 1 CHECK (supported_protocol_major = 1),
  allowed_scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(allowed_scope) = 'object'),
  lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('DRAFT', 'REQUESTED', 'IDENTITY_VERIFIED', 'CONTRACT_VALIDATED', 'POLICY_REVIEWED', 'CERTIFIED_STAGING', 'ENABLED', 'REJECTED', 'SUSPENDED', 'REVOKED')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  current_contract_id uuid NULL,
  manifest_digest text NULL CHECK (manifest_digest IS NULL OR manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  manifest_revision integer NULL CHECK (manifest_revision IS NULL OR manifest_revision >= 1),
  manifest_expires_at timestamptz NULL,
  identity_verified_at timestamptz NULL,
  operations_enabled boolean NOT NULL DEFAULT false,
  requested_by text NOT NULL,
  health_status text NOT NULL DEFAULT 'UNKNOWN' CHECK (health_status IN ('UNKNOWN', 'REACHABLE', 'UNREACHABLE', 'DEGRADED')),
  health_checked_at timestamptz NULL,
  sync_status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (sync_status IN ('NOT_STARTED', 'HEALTHY', 'LAGGING', 'GAP_DETECTED', 'FAILING', 'STOPPED')),
  drift_status text NOT NULL DEFAULT 'NONE' CHECK (drift_status IN ('NONE', 'ADDITIVE_PENDING_REVIEW', 'BREAKING_DETECTED', 'IDENTITY_MISMATCH', 'MANIFEST_INVALID', 'MANIFEST_EXPIRED')),
  drift_detected_at timestamptz NULL,
  activated_at timestamptz NULL,
  activated_by text NULL,
  suspended_at timestamptz NULL,
  suspended_by text NULL,
  suspension_reason text NULL,
  revoked_at timestamptz NULL,
  revoked_by text NULL,
  revocation_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_product_admins_revoked_metadata CHECK (lifecycle_status <> 'REVOKED' OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IS NOT NULL)),
  CONSTRAINT hq_product_admins_suspended_metadata CHECK (lifecycle_status <> 'SUSPENDED' OR (suspended_at IS NOT NULL AND suspended_by IS NOT NULL)),
  CONSTRAINT hq_product_admins_enabled_requirements CHECK (lifecycle_status <> 'ENABLED' OR (current_contract_id IS NOT NULL AND activated_at IS NOT NULL AND activated_by IS NOT NULL AND identity_verified_at IS NOT NULL))
);

CREATE UNIQUE INDEX hq_product_admins_service_instance_uq ON hq_integration.hq_product_admins (service_instance_id);
-- One live registration per product and environment.
CREATE UNIQUE INDEX hq_product_admins_live_product_uq ON hq_integration.hq_product_admins (product_id, environment)
  WHERE lifecycle_status NOT IN ('REJECTED', 'REVOKED');

-- Identity, destination and signer are fixed at registration; a manifest or
-- runtime update can never change them. REVOKED and REJECTED are terminal.
CREATE OR REPLACE FUNCTION hq_integration.guard_product_admin_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.service_instance_id IS DISTINCT FROM OLD.service_instance_id
     OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.endpoint_ref IS DISTINCT FROM OLD.endpoint_ref
     OR NEW.workload_identity IS DISTINCT FROM OLD.workload_identity OR NEW.approved_signer_kid IS DISTINCT FROM OLD.approved_signer_kid
     OR NEW.identity_fingerprint_ref IS DISTINCT FROM OLD.identity_fingerprint_ref OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'registered product admin identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.lifecycle_status IN ('REVOKED', 'REJECTED') THEN
    RAISE EXCEPTION 'product admin registration % is terminal', OLD.lifecycle_status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'registry revision cannot decrease' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.lifecycle_status IS DISTINCT FROM OLD.lifecycle_status AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'lifecycle transitions must advance the revision by one' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER hq_product_admins_guard BEFORE UPDATE ON hq_integration.hq_product_admins
  FOR EACH ROW EXECUTE FUNCTION hq_integration.guard_product_admin_update();
CREATE TRIGGER hq_product_admins_no_delete BEFORE DELETE ON hq_integration.hq_product_admins
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();

-- Reviewed contract revisions ----------------------------------------------

CREATE TABLE hq_integration.hq_product_admin_contracts (
  id uuid PRIMARY KEY,
  product_admin_id uuid NOT NULL REFERENCES hq_integration.hq_product_admins (id),
  revision integer NOT NULL CHECK (revision >= 1),
  protocol_major integer NOT NULL CHECK (protocol_major = 1),
  protocol_minor integer NOT NULL CHECK (protocol_minor >= 0),
  manifest_revision integer NOT NULL CHECK (manifest_revision >= 1),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  catalog_digest text NOT NULL CHECK (catalog_digest ~ '^sha256:[0-9a-f]{64}$'),
  build_sha text NOT NULL CHECK (build_sha ~ '^[0-9a-f]{7,64}$'),
  catalog jsonb NOT NULL CHECK (jsonb_typeof(catalog) = 'object'),
  compatibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  migration_plan jsonb NULL,
  status text NOT NULL CHECK (status IN ('VALIDATED', 'CERTIFIED', 'ACTIVE', 'SUPERSEDED', 'REJECTED')),
  validated_by text NOT NULL,
  validated_at timestamptz NOT NULL DEFAULT now(),
  certified_by text NULL,
  certified_at timestamptz NULL,
  certification_evidence_ref text NULL,
  activated_at timestamptz NULL,
  CONSTRAINT hq_product_admin_contracts_revision_uq UNIQUE (product_admin_id, revision),
  CONSTRAINT hq_product_admin_contracts_catalog_uq UNIQUE (product_admin_id, catalog_digest),
  CONSTRAINT hq_product_admin_contracts_certified CHECK (status NOT IN ('CERTIFIED', 'ACTIVE', 'SUPERSEDED') OR (certified_by IS NOT NULL AND certified_at IS NOT NULL AND certified_by <> validated_by)),
  CONSTRAINT hq_product_admin_contracts_active CHECK (status NOT IN ('ACTIVE', 'SUPERSEDED') OR activated_at IS NOT NULL)
);
-- One active certified contract per product registration (and therefore per
-- product/environment, given hq_product_admins_live_product_uq).
CREATE UNIQUE INDEX hq_product_admin_contracts_one_active ON hq_integration.hq_product_admin_contracts (product_admin_id) WHERE status = 'ACTIVE';

ALTER TABLE hq_integration.hq_product_admins
  ADD CONSTRAINT hq_product_admins_current_contract_fk FOREIGN KEY (current_contract_id)
  REFERENCES hq_integration.hq_product_admin_contracts (id) DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION hq_integration.guard_contract_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product_admin_id IS DISTINCT FROM OLD.product_admin_id OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.protocol_major IS DISTINCT FROM OLD.protocol_major OR NEW.protocol_minor IS DISTINCT FROM OLD.protocol_minor
     OR NEW.manifest_revision IS DISTINCT FROM OLD.manifest_revision OR NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest
     OR NEW.catalog_digest IS DISTINCT FROM OLD.catalog_digest OR NEW.build_sha IS DISTINCT FROM OLD.build_sha
     OR NEW.catalog IS DISTINCT FROM OLD.catalog OR NEW.compatibility IS DISTINCT FROM OLD.compatibility
     OR NEW.validated_by IS DISTINCT FROM OLD.validated_by OR NEW.validated_at IS DISTINCT FROM OLD.validated_at
     OR (OLD.certified_by IS NOT NULL AND NEW.certified_by IS DISTINCT FROM OLD.certified_by)
     OR (OLD.migration_plan IS NOT NULL AND NEW.migration_plan IS DISTINCT FROM OLD.migration_plan) THEN
    RAISE EXCEPTION 'reviewed contract revisions are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'VALIDATED' AND NEW.status IN ('CERTIFIED', 'REJECTED')) OR
       (OLD.status = 'CERTIFIED' AND NEW.status IN ('ACTIVE', 'REJECTED')) OR
       (OLD.status = 'ACTIVE' AND NEW.status = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'contract status % -> % is not permitted', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hq_product_admin_contracts_guard BEFORE UPDATE ON hq_integration.hq_product_admin_contracts
  FOR EACH ROW EXECUTE FUNCTION hq_integration.guard_contract_update();
CREATE TRIGGER hq_product_admin_contracts_no_delete BEFORE DELETE ON hq_integration.hq_product_admin_contracts
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();

-- Staff grants (product-scoped and platform-scoped) ------------------------

CREATE TABLE hq_integration.hq_product_admin_grants (
  id uuid PRIMARY KEY,
  grant_kind text NOT NULL CHECK (grant_kind IN ('PRODUCT', 'PLATFORM')),
  product_id text NULL CHECK (product_id IS NULL OR product_id ~ '^[a-z][a-z0-9-]{1,31}$'),
  staff_id text NOT NULL CHECK (staff_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'),
  role text NULL CHECK (role IS NULL OR role ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  effect text NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
  actions text[] NOT NULL CHECK (cardinality(actions) BETWEEN 1 AND 32 AND NOT ('*' = ANY (actions))),
  datasets text[] NOT NULL DEFAULT '{}' CHECK (cardinality(datasets) <= 64 AND NOT ('*' = ANY (datasets))),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scope) = 'object' AND scope::text NOT LIKE '%"*"%'),
  expires_at timestamptz NULL,
  granted_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL,
  revoked_by text NULL,
  revocation_reason text NULL,
  CONSTRAINT hq_product_admin_grants_kind_product CHECK ((grant_kind = 'PRODUCT') = (product_id IS NOT NULL)),
  CONSTRAINT hq_product_admin_grants_no_self_grant CHECK (granted_by <> staff_id),
  CONSTRAINT hq_product_admin_grants_revocation CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX hq_product_admin_grants_staff_idx ON hq_integration.hq_product_admin_grants (staff_id) WHERE revoked_at IS NULL;

-- Grants are append-only except a one-time revocation.
CREATE OR REPLACE FUNCTION hq_integration.guard_grant_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by', 'revocation_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by', 'revocation_reason']) THEN
    RAISE EXCEPTION 'grants are immutable except a single revocation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hq_product_admin_grants_guard BEFORE UPDATE ON hq_integration.hq_product_admin_grants
  FOR EACH ROW EXECUTE FUNCTION hq_integration.guard_grant_update();
CREATE TRIGGER hq_product_admin_grants_no_delete BEFORE DELETE ON hq_integration.hq_product_admin_grants
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();

-- Dataset definitions from validated contracts -----------------------------

CREATE TABLE hq_integration.hq_product_admin_datasets (
  id uuid PRIMARY KEY,
  product_admin_id uuid NOT NULL REFERENCES hq_integration.hq_product_admins (id),
  contract_id uuid NOT NULL REFERENCES hq_integration.hq_product_admin_contracts (id),
  dataset_id text NOT NULL CHECK (dataset_id ~ '^[a-z][a-z0-9_.-]{1,95}$'),
  version text NOT NULL CHECK (version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'),
  schema_id text NOT NULL,
  schema_digest text NOT NULL CHECK (schema_digest ~ '^sha256:[0-9a-f]{64}$'),
  privacy_class text NOT NULL CHECK (privacy_class IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED_PII')),
  scope_dimensions text[] NOT NULL,
  authorized_departments text[] NOT NULL,
  semantic_grain text NOT NULL,
  units text[] NOT NULL,
  currency text NULL CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  freshness_target_seconds integer NOT NULL CHECK (freshness_target_seconds BETWEEN 60 AND 2678400),
  lineage jsonb NOT NULL,
  allowed_fields jsonb NOT NULL,
  metrics jsonb NOT NULL,
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  approval_status text NOT NULL CHECK (approval_status IN ('PROPOSED', 'APPROVED', 'REJECTED', 'RETIRED')),
  approved_by text NULL,
  approved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_product_admin_datasets_version_uq UNIQUE (product_admin_id, dataset_id, version),
  -- Restricted personal data can never be approved for HQ synchronization.
  CONSTRAINT hq_product_admin_datasets_no_restricted CHECK (NOT (privacy_class = 'RESTRICTED_PII' AND approval_status = 'APPROVED')),
  CONSTRAINT hq_product_admin_datasets_approval CHECK (approval_status <> 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION hq_integration.guard_dataset_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['approval_status', 'approved_by', 'approved_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['approval_status', 'approved_by', 'approved_at']) THEN
    RAISE EXCEPTION 'dataset definitions are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.approval_status IS DISTINCT FROM OLD.approval_status AND NOT (
       (OLD.approval_status = 'PROPOSED' AND NEW.approval_status IN ('APPROVED', 'REJECTED')) OR
       (OLD.approval_status = 'APPROVED' AND NEW.approval_status = 'RETIRED')) THEN
    RAISE EXCEPTION 'dataset approval % -> % is not permitted', OLD.approval_status, NEW.approval_status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hq_product_admin_datasets_guard BEFORE UPDATE ON hq_integration.hq_product_admin_datasets
  FOR EACH ROW EXECUTE FUNCTION hq_integration.guard_dataset_update();
CREATE TRIGGER hq_product_admin_datasets_no_delete BEFORE DELETE ON hq_integration.hq_product_admin_datasets
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();

-- Dataset subscriptions -----------------------------------------------------

CREATE TABLE hq_integration.hq_product_admin_subscriptions (
  id uuid PRIMARY KEY,
  product_admin_id uuid NOT NULL REFERENCES hq_integration.hq_product_admins (id),
  dataset_row_id uuid NOT NULL REFERENCES hq_integration.hq_product_admin_datasets (id),
  consumer_department text NOT NULL CHECK (consumer_department ~ '^[a-z][a-z0-9-]{1,47}$'),
  schema_revision text NOT NULL,
  schema_digest text NOT NULL CHECK (schema_digest ~ '^sha256:[0-9a-f]{64}$'),
  allowed_scope jsonb NOT NULL CHECK (jsonb_typeof(allowed_scope) = 'object' AND allowed_scope::text NOT LIKE '%"*"%'),
  freshness_target_seconds integer NOT NULL CHECK (freshness_target_seconds BETWEEN 60 AND 2678400),
  poll_interval_seconds integer NOT NULL CHECK (poll_interval_seconds BETWEEN 5 AND 86400),
  page_limit integer NOT NULL DEFAULT 100 CHECK (page_limit BETWEEN 1 AND 100),
  enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'POLICY_BLOCKED')),
  policy_block_reason text NULL,
  coverage text NOT NULL DEFAULT 'UNKNOWN' CHECK (coverage IN ('COMPLETE', 'PARTIAL', 'NONE', 'UNKNOWN')),
  gap_status text NOT NULL DEFAULT 'NONE' CHECK (gap_status IN ('NONE', 'GAP_DETECTED')),
  quarantined_count integer NOT NULL DEFAULT 0 CHECK (quarantined_count >= 0),
  last_success_at timestamptz NULL,
  last_source_observation_at timestamptz NULL,
  last_reconciliation_at timestamptz NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One ingestion stream per product dataset; other departments get access
  -- through dataset grants rather than duplicate streams.
  CONSTRAINT hq_product_admin_subscriptions_dataset_uq UNIQUE (product_admin_id, dataset_row_id)
);

-- Ingested events (append-only inbox) ---------------------------------------

CREATE TABLE hq_integration.hq_product_admin_event_inbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_admin_id uuid NOT NULL REFERENCES hq_integration.hq_product_admins (id),
  subscription_id uuid NOT NULL REFERENCES hq_integration.hq_product_admin_subscriptions (id),
  contract_id uuid NOT NULL REFERENCES hq_integration.hq_product_admin_contracts (id),
  event_id uuid NOT NULL,
  event_digest text NOT NULL CHECK (event_digest ~ '^sha256:[0-9a-f]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  family text NOT NULL,
  schema_id text NOT NULL,
  schema_version text NOT NULL,
  dataset_id text NOT NULL,
  partition_key text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 1),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  entity_version bigint NOT NULL CHECK (entity_version >= 0),
  scope jsonb NOT NULL,
  classification text NOT NULL CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL')),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  emitted_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  application text NOT NULL CHECK (application IN ('APPLIED', 'STALE_IGNORED', 'NO_PROJECTION')),
  correlation_id text NULL,
  CONSTRAINT hq_product_admin_event_inbox_event_uq UNIQUE (product_admin_id, event_id),
  CONSTRAINT hq_product_admin_event_inbox_sequence_uq UNIQUE (subscription_id, partition_key, sequence)
);
CREATE TRIGGER hq_product_admin_event_inbox_append_only BEFORE UPDATE OR DELETE ON hq_integration.hq_product_admin_event_inbox
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();
CREATE TRIGGER hq_product_admin_event_inbox_no_truncate BEFORE TRUNCATE ON hq_integration.hq_product_admin_event_inbox
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();

-- Partition cursors with fenced leases --------------------------------------

CREATE TABLE hq_integration.hq_product_admin_sync_cursors (
  id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES hq_integration.hq_product_admin_subscriptions (id),
  partition_key text NOT NULL CHECK (partition_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  acked_sequence bigint NOT NULL DEFAULT 0 CHECK (acked_sequence >= 0),
  last_event_id uuid NULL,
  head_sequence bigint NULL CHECK (head_sequence IS NULL OR head_sequence >= 0),
  lease_owner text NULL,
  lease_token bigint NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
  lease_expires_at timestamptz NULL,
  gap_from bigint NULL,
  gap_to bigint NULL,
  gap_detected_at timestamptz NULL,
  last_success_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_product_admin_sync_cursors_partition_uq UNIQUE (subscription_id, partition_key),
  CONSTRAINT hq_product_admin_sync_cursors_ack_le_last CHECK (acked_sequence <= last_sequence),
  CONSTRAINT hq_product_admin_sync_cursors_gap CHECK ((gap_from IS NULL) = (gap_to IS NULL) AND (gap_from IS NULL OR (gap_from > last_sequence AND gap_from <= gap_to)))
);

CREATE OR REPLACE FUNCTION hq_integration.guard_cursor_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_sequence < OLD.last_sequence OR NEW.acked_sequence < OLD.acked_sequence OR NEW.lease_token < OLD.lease_token THEN
    RAISE EXCEPTION 'sync cursors are monotonic' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.subscription_id IS DISTINCT FROM OLD.subscription_id OR NEW.partition_key IS DISTINCT FROM OLD.partition_key THEN
    RAISE EXCEPTION 'cursor identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER hq_product_admin_sync_cursors_guard BEFORE UPDATE ON hq_integration.hq_product_admin_sync_cursors
  FOR EACH ROW EXECUTE FUNCTION hq_integration.guard_cursor_update();

-- Domain-neutral metric projections -----------------------------------------

CREATE TABLE hq_integration.hq_product_admin_metrics (
  id uuid PRIMARY KEY,
  product_admin_id uuid NOT NULL REFERENCES hq_integration.hq_product_admins (id),
  product_id text NOT NULL,
  subscription_id uuid NOT NULL REFERENCES hq_integration.hq_product_admin_subscriptions (id),
  contract_id uuid NOT NULL REFERENCES hq_integration.hq_product_admin_contracts (id),
  dataset_id text NOT NULL,
  metric_id text NOT NULL,
  definition_version text NOT NULL,
  definition_digest text NOT NULL CHECK (definition_digest ~ '^sha256:[0-9a-f]{64}$'),
  scope_key text NOT NULL,
  scope jsonb NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  grain text NOT NULL,
  unit text NOT NULL,
  currency text NULL CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  value numeric NULL,
  value_state text NOT NULL CHECK (value_state IN ('OBSERVED', 'UNAVAILABLE')),
  source_observed_at timestamptz NULL,
  freshness text NOT NULL CHECK (freshness IN ('FRESH', 'STALE', 'UNKNOWN')),
  coverage text NOT NULL CHECK (coverage IN ('COMPLETE', 'PARTIAL', 'NONE', 'UNKNOWN')),
  source_sequence bigint NULL,
  source_entity_version bigint NOT NULL CHECK (source_entity_version >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_product_admin_metrics_window CHECK (window_end > window_start),
  CONSTRAINT hq_product_admin_metrics_observed CHECK ((value_state = 'OBSERVED') = (value IS NOT NULL)),
  -- An observed value always carries a genuine source observation and coverage.
  CONSTRAINT hq_product_admin_metrics_truthful CHECK (value_state <> 'OBSERVED' OR (source_observed_at IS NOT NULL AND coverage IN ('COMPLETE', 'PARTIAL'))),
  CONSTRAINT hq_product_admin_metrics_point_uq UNIQUE (product_admin_id, metric_id, definition_version, scope_key, window_start, window_end)
);

-- Version protection: only a strictly newer source entity version may
-- replace a projection, and each replacement bumps the row version.
CREATE OR REPLACE FUNCTION hq_integration.guard_metric_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_entity_version <= OLD.source_entity_version THEN
    RAISE EXCEPTION 'metric projection cannot be replaced by an older or equal source version' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.product_admin_id IS DISTINCT FROM OLD.product_admin_id OR NEW.metric_id IS DISTINCT FROM OLD.metric_id
     OR NEW.definition_version IS DISTINCT FROM OLD.definition_version OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
     OR NEW.window_start IS DISTINCT FROM OLD.window_start OR NEW.window_end IS DISTINCT FROM OLD.window_end
     OR NEW.unit IS DISTINCT FROM OLD.unit OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.grain IS DISTINCT FROM OLD.grain THEN
    RAISE EXCEPTION 'metric identity, unit, grain and currency are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER hq_product_admin_metrics_guard BEFORE UPDATE ON hq_integration.hq_product_admin_metrics
  FOR EACH ROW EXECUTE FUNCTION hq_integration.guard_metric_update();
CREATE TRIGGER hq_product_admin_metrics_no_delete BEFORE DELETE ON hq_integration.hq_product_admin_metrics
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();

-- Lineage (append-only) -------------------------------------------------------

CREATE TABLE hq_integration.hq_product_admin_lineage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_admin_id uuid NOT NULL REFERENCES hq_integration.hq_product_admins (id),
  metric_row_id uuid NOT NULL REFERENCES hq_integration.hq_product_admin_metrics (id),
  inbox_id bigint NULL REFERENCES hq_integration.hq_product_admin_event_inbox (id),
  snapshot_ref text NULL,
  contract_id uuid NOT NULL REFERENCES hq_integration.hq_product_admin_contracts (id),
  dataset_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('APPLY_EVENT', 'RECONCILE_SNAPSHOT')),
  source_sequence bigint NULL,
  source_entity_version bigint NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_product_admin_lineage_source CHECK ((inbox_id IS NOT NULL) <> (snapshot_ref IS NOT NULL))
);
CREATE TRIGGER hq_product_admin_lineage_append_only BEFORE UPDATE OR DELETE ON hq_integration.hq_product_admin_lineage
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();
CREATE TRIGGER hq_product_admin_lineage_no_truncate BEFORE TRUNCATE ON hq_integration.hq_product_admin_lineage
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();

-- Sync runs --------------------------------------------------------------------

CREATE TABLE hq_integration.hq_product_admin_sync_runs (
  id uuid PRIMARY KEY,
  product_admin_id uuid NOT NULL REFERENCES hq_integration.hq_product_admins (id),
  subscription_id uuid NULL REFERENCES hq_integration.hq_product_admin_subscriptions (id),
  partition_key text NULL,
  run_kind text NOT NULL CHECK (run_kind IN ('EVENTS', 'RECONCILE', 'HEALTH')),
  worker_id text NOT NULL,
  fencing_token bigint NULL,
  correlation_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL_GAP', 'FAILED', 'LEASE_LOST', 'ABORTED_REVOKED', 'SKIPPED_POLICY')),
  events_received integer NOT NULL DEFAULT 0,
  events_applied integer NOT NULL DEFAULT 0,
  events_duplicate integer NOT NULL DEFAULT 0,
  events_stale integer NOT NULL DEFAULT 0,
  events_quarantined integer NOT NULL DEFAULT 0,
  ack_status text NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (ack_status IN ('NOT_REQUIRED', 'ACKED', 'ACK_FAILED', 'SKIPPED_REVOKED')),
  acked_sequence bigint NULL,
  error_code text NULL CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,63}$')
);
CREATE INDEX hq_product_admin_sync_runs_recent_idx ON hq_integration.hq_product_admin_sync_runs (product_admin_id, started_at DESC);

-- Quarantine -------------------------------------------------------------------

CREATE TABLE hq_integration.hq_product_admin_quarantine (
  id uuid PRIMARY KEY,
  product_admin_id uuid NOT NULL REFERENCES hq_integration.hq_product_admins (id),
  subscription_id uuid NULL REFERENCES hq_integration.hq_product_admin_subscriptions (id),
  event_id uuid NULL,
  partition_key text NULL,
  sequence bigint NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  event_digest text NULL,
  schema_id text NULL,
  schema_version text NULL,
  -- Sanitized metadata only; raw payloads of rejected events are not stored.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL,
  resolved_by text NULL,
  resolution text NULL
);
CREATE UNIQUE INDEX hq_product_admin_quarantine_event_uq ON hq_integration.hq_product_admin_quarantine (product_admin_id, event_id, reason_code) WHERE event_id IS NOT NULL;
CREATE TRIGGER hq_product_admin_quarantine_no_delete BEFORE DELETE ON hq_integration.hq_product_admin_quarantine
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();

-- Onboarding approval history (append-only) ---------------------------------

CREATE TABLE hq_integration.hq_product_admin_onboarding_approvals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_admin_id uuid NOT NULL REFERENCES hq_integration.hq_product_admins (id),
  decision text NOT NULL CHECK (decision IN ('TRANSITION', 'DATASET_APPROVED', 'DATASET_REJECTED', 'CONTRACT_VALIDATED', 'CONTRACT_CERTIFIED', 'CONTRACT_ACTIVATED', 'CONTRACT_REJECTED', 'SUBSCRIPTION_CHANGED', 'IDENTITY_CHECK_FAILED')),
  from_status text NULL,
  to_status text NULL,
  actor_id text NOT NULL,
  reason_code text NULL CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  evidence_ref text NULL CHECK (evidence_ref IS NULL OR char_length(evidence_ref) <= 256),
  expected_revision integer NULL,
  resulting_revision integer NULL,
  contract_id uuid NULL REFERENCES hq_integration.hq_product_admin_contracts (id),
  dataset_row_id uuid NULL REFERENCES hq_integration.hq_product_admin_datasets (id),
  subscription_id uuid NULL REFERENCES hq_integration.hq_product_admin_subscriptions (id),
  correlation_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER hq_product_admin_onboarding_approvals_append_only BEFORE UPDATE OR DELETE ON hq_integration.hq_product_admin_onboarding_approvals
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();
CREATE TRIGGER hq_product_admin_onboarding_approvals_no_truncate BEFORE TRUNCATE ON hq_integration.hq_product_admin_onboarding_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();

-- Security audit (append-only) -------------------------------------------------

CREATE TABLE hq_integration.hq_product_admin_security_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('STAFF', 'SERVICE', 'SYSTEM', 'OPERATOR')),
  actor_id text NOT NULL,
  product_id text NULL,
  product_admin_id uuid NULL,
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ALLOWED', 'DENIED', 'ERROR', 'RECORDED')),
  reason_code text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX hq_product_admin_security_audit_product_idx ON hq_integration.hq_product_admin_security_audit (product_admin_id, occurred_at DESC);
CREATE TRIGGER hq_product_admin_security_audit_append_only BEFORE UPDATE OR DELETE ON hq_integration.hq_product_admin_security_audit
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();
CREATE TRIGGER hq_product_admin_security_audit_no_truncate BEFORE TRUNCATE ON hq_integration.hq_product_admin_security_audit
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();

-- Durable replay protection for delegation tokens ---------------------------

CREATE TABLE hq_integration.hq_product_admin_replay_nonces (
  namespace text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (namespace, nonce)
);
CREATE INDEX hq_product_admin_replay_nonces_expiry_idx ON hq_integration.hq_product_admin_replay_nonces (expires_at);
