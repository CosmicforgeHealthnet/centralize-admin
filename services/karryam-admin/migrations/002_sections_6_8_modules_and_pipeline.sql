-- Sections 6-8: governed operations, approvals, Bridge -> Karryam Admin
-- event pipeline (Stage A) and the derived HQ outbox (Stage B).
-- Forward-only. Dedicated Karryam Admin objects only: no source tables and
-- no HQ tables. Runtime grants are applied by scripts/migrate.js.

-- ---------------------------------------------------------------------------
-- Governed operations. Status moves only along the allowed transitions; the
-- identity, digest, scope and requester of an operation never change, and a
-- source command is dispatched at most once.
-- ---------------------------------------------------------------------------
ALTER TABLE karryam_admin.operation_requests DROP CONSTRAINT IF EXISTS operation_requests_status_check;
ALTER TABLE karryam_admin.operation_requests
  ADD COLUMN risk text CHECK (risk IS NULL OR risk IN ('R0','R1','R2','R3','R4')),
  ADD COLUMN bridge_capability_id text,
  ADD COLUMN intent_digest text CHECK (intent_digest IS NULL OR intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN scope jsonb CHECK (scope IS NULL OR jsonb_typeof(scope) = 'object'),
  ADD COLUMN purpose_code text,
  ADD COLUMN request_reason_code text,
  ADD COLUMN case_reference text,
  ADD COLUMN expected_version bigint,
  ADD COLUMN approval_ref uuid,
  ADD COLUMN dispatch_count integer NOT NULL DEFAULT 0 CHECK (dispatch_count BETWEEN 0 AND 1),
  ADD COLUMN dispatched_at timestamptz,
  ADD COLUMN source_status text,
  ADD COLUMN source_version bigint,
  ADD COLUMN outcome_evidence jsonb CHECK (outcome_evidence IS NULL OR jsonb_typeof(outcome_evidence) = 'object'),
  ADD COLUMN readback_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_readback_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE karryam_admin.operation_requests ADD CONSTRAINT operation_requests_status_valid
  CHECK (status IN ('REJECTED','RECORDED','DISPATCHING','SUCCEEDED','FAILED','UNKNOWN_OUTCOME'));
CREATE INDEX operation_requests_unknown_idx ON karryam_admin.operation_requests (updated_at) WHERE status IN ('UNKNOWN_OUTCOME','DISPATCHING');

CREATE FUNCTION karryam_admin.guard_operation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.service_id <> OLD.service_id OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_digest <> OLD.request_digest OR NEW.capability_id <> OLD.capability_id OR NEW.staff_ref <> OLD.staff_ref
     OR NEW.created_at <> OLD.created_at OR NEW.intent_digest IS DISTINCT FROM OLD.intent_digest OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.bridge_capability_id IS DISTINCT FROM OLD.bridge_capability_id OR NEW.approval_ref IS DISTINCT FROM OLD.approval_ref THEN
    RAISE EXCEPTION 'operation identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.dispatch_count < OLD.dispatch_count THEN
    RAISE EXCEPTION 'dispatch count cannot decrease' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'RECORDED' AND NEW.status IN ('REJECTED','DISPATCHING'))
    OR (OLD.status = 'DISPATCHING' AND NEW.status IN ('SUCCEEDED','FAILED','UNKNOWN_OUTCOME'))
    OR (OLD.status = 'UNKNOWN_OUTCOME' AND NEW.status IN ('SUCCEEDED','FAILED'))) THEN
    RAISE EXCEPTION 'operation transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('REJECTED','SUCCEEDED','FAILED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal operation is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER operation_requests_guard BEFORE UPDATE ON karryam_admin.operation_requests
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_operation_update();
CREATE TRIGGER operation_requests_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.operation_requests
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_audit_mutation();

-- Independent approvals: two-person, digest/scope bound, expiring,
-- consumed at most once by exactly one operation.
CREATE TABLE karryam_admin.approval_references (
  id               uuid PRIMARY KEY,
  capability_id    text NOT NULL,
  intent_digest    text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  scope            jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  requested_by     text NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL CHECK (status IN ('PROPOSED','APPROVED','REJECTED','CONSUMED')),
  decided_by       text,
  decided_at       timestamptz,
  decided_mfa_at   timestamptz,
  expires_at       timestamptz NOT NULL,
  consumed_by      uuid UNIQUE,
  consumed_at      timestamptz,
  CONSTRAINT approval_two_person CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CONSTRAINT approval_decision_complete CHECK ((status = 'PROPOSED') = (decided_by IS NULL)),
  CONSTRAINT approval_consumed_complete CHECK ((status = 'CONSUMED') = (consumed_by IS NOT NULL))
);
CREATE FUNCTION karryam_admin.guard_approval_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.capability_id <> OLD.capability_id OR NEW.intent_digest <> OLD.intent_digest OR NEW.scope <> OLD.scope
     OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'approval binding is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT ((OLD.status = 'PROPOSED' AND NEW.status IN ('APPROVED','REJECTED')) OR (OLD.status = 'APPROVED' AND NEW.status = 'CONSUMED')) THEN
    RAISE EXCEPTION 'approval transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER approval_references_guard BEFORE UPDATE ON karryam_admin.approval_references
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_approval_update();
CREATE TRIGGER approval_references_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.approval_references
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_audit_mutation();

-- Sensitive data access record (who read what class of data, for which
-- purpose and scope). Append-only.
CREATE TABLE karryam_admin.sensitive_access_log (
  id             bigserial PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  correlation_id text,
  staff_ref      text NOT NULL,
  capability_id  text NOT NULL,
  privacy_class  text NOT NULL,
  purpose_code   text,
  scope          jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  outcome        text NOT NULL CHECK (outcome ~ '^[A-Z][A-Z0-9_]{1,47}$'),
  item_count     integer CHECK (item_count IS NULL OR item_count >= 0)
);
CREATE INDEX sensitive_access_log_staff_idx ON karryam_admin.sensitive_access_log (staff_ref, occurred_at);
CREATE TRIGGER sensitive_access_log_append_only BEFORE UPDATE OR DELETE ON karryam_admin.sensitive_access_log
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.reject_audit_mutation();
CREATE TRIGGER sensitive_access_log_no_truncate BEFORE TRUNCATE ON karryam_admin.sensitive_access_log
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_audit_mutation();

-- Reviewed Bridge contract revisions this deployment has run against.
CREATE TABLE karryam_admin.bridge_contract_revisions (
  revision           text PRIMARY KEY CHECK (revision ~ '^[0-9a-f]{64}$'),
  source_commit      text NOT NULL,
  openapi_sha256     text NOT NULL,
  matrix_sha256      text NOT NULL,
  capability_count   integer NOT NULL,
  first_seen_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Stage A: Bridge -> Karryam Admin.
-- ---------------------------------------------------------------------------
-- One partition per approved Bridge feed scope. The cursor is the highest
-- committed Bridge sequence; the hold stops the cursor at an event that
-- could not be verified; the lease token fences concurrent workers.
CREATE TABLE karryam_admin.bridge_feed_partitions (
  partition_key      text PRIMARY KEY CHECK (partition_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  market             text NOT NULL,
  organization       text NOT NULL,
  zone               text NOT NULL,
  tenant             text NOT NULL,
  consumer           text NOT NULL,
  last_sequence      bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  acked_sequence     bigint NOT NULL DEFAULT 0 CHECK (acked_sequence >= 0),
  head_sequence      bigint CHECK (head_sequence IS NULL OR head_sequence >= 0),
  hold_sequence      bigint,
  hold_reason        text,
  hold_detected_at   timestamptz,
  started_from_zero  boolean NOT NULL DEFAULT true,
  contract_revision  text,
  lease_owner        text,
  lease_token        bigint NOT NULL DEFAULT 0,
  lease_expires_at   timestamptz,
  last_success_at    timestamptz,
  last_ack_at        timestamptz,
  last_error_code    text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feed_ack_not_beyond_commit CHECK (acked_sequence <= last_sequence),
  CONSTRAINT feed_scope_unique UNIQUE (market, organization, zone, tenant)
);
CREATE FUNCTION karryam_admin.guard_feed_cursor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_sequence < OLD.last_sequence OR NEW.acked_sequence < OLD.acked_sequence OR NEW.lease_token < OLD.lease_token THEN
    RAISE EXCEPTION 'feed cursor, ACK and fencing token are monotonic' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.market <> OLD.market OR NEW.organization <> OLD.organization OR NEW.zone <> OLD.zone OR NEW.tenant <> OLD.tenant OR NEW.consumer <> OLD.consumer THEN
    RAISE EXCEPTION 'feed partition scope is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER bridge_feed_partitions_guard BEFORE UPDATE ON karryam_admin.bridge_feed_partitions
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_feed_cursor();

-- Durable, minimized inbox. Event identity and sequence are unique; the
-- digest is immutable. Only retention may clear the minimized payload.
CREATE TABLE karryam_admin.bridge_event_inbox (
  id                 bigserial PRIMARY KEY,
  partition_key      text NOT NULL REFERENCES karryam_admin.bridge_feed_partitions(partition_key),
  event_id           uuid NOT NULL UNIQUE,
  sequence           bigint NOT NULL CHECK (sequence >= 1),
  event_type         text NOT NULL,
  source_service     text NOT NULL,
  entity_type        text NOT NULL,
  entity_ref         text NOT NULL,
  entity_version     bigint NOT NULL CHECK (entity_version >= 1),
  tombstone          boolean NOT NULL,
  classification     text NOT NULL,
  scope              jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  payload            jsonb,
  event_digest       text NOT NULL CHECK (event_digest ~ '^sha256:[0-9a-f]{64}$'),
  outcome            text NOT NULL CHECK (outcome IN ('APPLIED','GAP_APPLIED','STALE','LATE_APPLIED','LATE_STALE')),
  delivery           text NOT NULL CHECK (delivery IN ('FEED','REWIND')),
  occurred_at        timestamptz NOT NULL,
  emitted_at         timestamptz NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  contract_revision  text NOT NULL,
  payload_cleared_at timestamptz,
  CONSTRAINT inbox_partition_sequence_unique UNIQUE (partition_key, sequence)
);
CREATE INDEX bridge_event_inbox_entity_idx ON karryam_admin.bridge_event_inbox (source_service, entity_type, entity_ref);
CREATE INDEX bridge_event_inbox_received_idx ON karryam_admin.bridge_event_inbox (received_at);
CREATE FUNCTION karryam_admin.guard_inbox_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payload IS NOT NULL OR (to_jsonb(NEW) - 'payload' - 'payload_cleared_at') <> (to_jsonb(OLD) - 'payload' - 'payload_cleared_at') THEN
    RAISE EXCEPTION 'inbox rows are immutable except retention clearing of the payload' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bridge_event_inbox_guard BEFORE UPDATE ON karryam_admin.bridge_event_inbox
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_inbox_update();
CREATE TRIGGER bridge_event_inbox_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.bridge_event_inbox
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_audit_mutation();

-- Authorized, minimized entity projections. Never moves backwards.
CREATE TABLE karryam_admin.entity_projections (
  source_service   text NOT NULL,
  entity_type      text NOT NULL,
  entity_ref       text NOT NULL,
  partition_key    text NOT NULL REFERENCES karryam_admin.bridge_feed_partitions(partition_key),
  entity_version   bigint NOT NULL CHECK (entity_version >= 1),
  tombstone        boolean NOT NULL DEFAULT false,
  classification   text NOT NULL,
  scope            jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  payload          jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at      timestamptz NOT NULL,
  source_event_id  uuid NOT NULL,
  coverage         text NOT NULL CHECK (coverage IN ('INCREMENTAL','BACKFILLED')),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_service, entity_type, entity_ref)
);
CREATE INDEX entity_projections_partition_idx ON karryam_admin.entity_projections (partition_key, entity_type) WHERE NOT tombstone;
CREATE FUNCTION karryam_admin.guard_projection_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entity_version <= OLD.entity_version THEN
    RAISE EXCEPTION 'projection version must increase (% -> %)', OLD.entity_version, NEW.entity_version USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER entity_projections_version_guard BEFORE UPDATE ON karryam_admin.entity_projections
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_projection_version();

CREATE TABLE karryam_admin.entity_version_gaps (
  id                bigserial PRIMARY KEY,
  partition_key     text NOT NULL,
  source_service    text NOT NULL,
  entity_type       text NOT NULL,
  entity_ref        text NOT NULL,
  previous_version  bigint NOT NULL,
  received_version  bigint NOT NULL CHECK (received_version > previous_version + 1),
  detected_at       timestamptz NOT NULL DEFAULT now(),
  repaired_at       timestamptz,
  repaired_by_run   uuid
);
CREATE INDEX entity_version_gaps_open_idx ON karryam_admin.entity_version_gaps (partition_key, entity_type) WHERE repaired_at IS NULL;

-- Quarantine keeps safe metadata and the digest of the rejected event only.
CREATE TABLE karryam_admin.event_quarantine (
  id             bigserial PRIMARY KEY,
  partition_key  text NOT NULL,
  event_id       text,
  sequence       bigint,
  event_type     text,
  reason         text NOT NULL CHECK (reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  raw_digest     text NOT NULL CHECK (raw_digest ~ '^sha256:[0-9a-f]{64}$'),
  detected_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolution     text,
  resolved_by    text,
  CONSTRAINT quarantine_once UNIQUE (partition_key, raw_digest, reason)
);
CREATE INDEX event_quarantine_open_idx ON karryam_admin.event_quarantine (partition_key) WHERE resolved_at IS NULL;

-- Lineage: which source event produced which projection version and which
-- derived HQ event.
CREATE TABLE karryam_admin.projection_lineage (
  id                bigserial PRIMARY KEY,
  source_event_id   uuid NOT NULL,
  partition_key     text NOT NULL,
  source_sequence   bigint,
  entity_type       text NOT NULL,
  entity_ref        text NOT NULL,
  entity_version    bigint NOT NULL,
  derived_event_id  uuid,
  metric_id         text,
  operation         text NOT NULL CHECK (operation IN ('APPLY_EVENT','BACKFILL_SNAPSHOT','DERIVE_METRIC')),
  recorded_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projection_lineage_source_idx ON karryam_admin.projection_lineage (source_event_id);
CREATE TRIGGER projection_lineage_append_only BEFORE UPDATE OR DELETE ON karryam_admin.projection_lineage
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.reject_audit_mutation();

-- Source-side coverage as reported by the Bridge projection status.
CREATE TABLE karryam_admin.source_coverage (
  source_service      text NOT NULL,
  entity_type         text NOT NULL,
  bridge_coverage     text NOT NULL CHECK (bridge_coverage IN ('COMPLETE','PARTIAL_COVERAGE')),
  bridge_open_gaps    integer NOT NULL,
  bridge_backfill     text NOT NULL,
  bridge_freshness    text NOT NULL,
  observed_at         timestamptz NOT NULL,
  PRIMARY KEY (source_service, entity_type)
);

CREATE TABLE karryam_admin.sync_runs (
  id                 uuid PRIMARY KEY,
  stage              text NOT NULL CHECK (stage IN ('BRIDGE_FEED','RECONCILE','BACKFILL','RETENTION')),
  trigger_kind       text NOT NULL CHECK (trigger_kind IN ('SCHEDULED','OPERATOR')),
  partition_key      text,
  worker_id          text NOT NULL,
  fencing_token      bigint,
  contract_revision  text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  status             text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','HELD','FAILED','LEASE_LOST','BLOCKED')),
  counts             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  details            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  error_code         text
);
CREATE INDEX sync_runs_stage_idx ON karryam_admin.sync_runs (stage, started_at DESC);

-- ---------------------------------------------------------------------------
-- Derived metrics and Stage B: Karryam Admin -> HQ.
-- ---------------------------------------------------------------------------
CREATE TABLE karryam_admin.metric_snapshots (
  metric_id       text NOT NULL,
  partition_key   text NOT NULL,
  window_start    timestamptz NOT NULL,
  window_end      timestamptz NOT NULL CHECK (window_end > window_start),
  value           numeric,
  value_state     text NOT NULL CHECK (value_state IN ('OBSERVED','UNAVAILABLE')),
  coverage        text NOT NULL CHECK (coverage IN ('COMPLETE','PARTIAL','NONE','UNKNOWN')),
  observed_at     timestamptz,
  entity_version  bigint NOT NULL CHECK (entity_version >= 1),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (metric_id, partition_key, window_start),
  CONSTRAINT metric_observed_has_value CHECK ((value_state = 'OBSERVED') = (value IS NOT NULL))
);

-- Append-only outbox with contiguous per-(dataset, partition) sequences.
CREATE TABLE karryam_admin.hq_outbox_heads (
  dataset_id     text NOT NULL,
  partition_key  text NOT NULL,
  head_sequence  bigint NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  PRIMARY KEY (dataset_id, partition_key)
);
CREATE FUNCTION karryam_admin.guard_outbox_head() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.head_sequence <> OLD.head_sequence + 1 THEN
    RAISE EXCEPTION 'outbox head advances by exactly one' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hq_outbox_heads_guard BEFORE UPDATE ON karryam_admin.hq_outbox_heads
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_outbox_head();

CREATE TABLE karryam_admin.hq_outbox (
  id               bigserial PRIMARY KEY,
  dataset_id       text NOT NULL,
  partition_key    text NOT NULL,
  sequence         bigint NOT NULL CHECK (sequence >= 1),
  event_id         uuid NOT NULL UNIQUE,
  family           text NOT NULL,
  event            jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  payload_digest   text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_event_id  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_outbox_sequence_unique UNIQUE (dataset_id, partition_key, sequence)
);
CREATE TRIGGER hq_outbox_append_only BEFORE UPDATE OR DELETE ON karryam_admin.hq_outbox
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.reject_audit_mutation();
CREATE TRIGGER hq_outbox_no_truncate BEFORE TRUNCATE ON karryam_admin.hq_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_audit_mutation();

CREATE TABLE karryam_admin.hq_outbox_acks (
  consumer        text NOT NULL,
  dataset_id      text NOT NULL,
  partition_key   text NOT NULL,
  acked_sequence  bigint NOT NULL CHECK (acked_sequence >= 0),
  acked_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, dataset_id, partition_key)
);
CREATE FUNCTION karryam_admin.guard_outbox_ack() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.acked_sequence < OLD.acked_sequence THEN
    RAISE EXCEPTION 'HQ acknowledgement cannot regress' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hq_outbox_acks_guard BEFORE UPDATE ON karryam_admin.hq_outbox_acks
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_outbox_ack();
