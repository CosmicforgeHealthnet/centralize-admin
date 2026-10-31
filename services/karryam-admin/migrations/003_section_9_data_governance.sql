-- Section 9: data models, constraints and data governance (forward-only).
-- Builds on 001/002 without rewriting them. Dedicated Karryam Admin objects
-- only: no source tables, no HQ tables, no Mail/HealthNet objects. Runtime
-- grants for the new tables are applied by scripts/migrate.js.
--
-- Backfill: every new column is nullable or has a constant default, so
-- existing rows stay valid without rewriting append-only history. The only
-- table rewrite is hq_outbox (stored generated columns computed from the
-- immutable event body; no UPDATE trigger fires).

-- ---------------------------------------------------------------------------
-- Shared guard with the table name in the message.
-- ---------------------------------------------------------------------------
CREATE FUNCTION karryam_admin.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'karryam_admin.%: % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- 9.5 Migration history is append-only (the runner only ever inserts).
CREATE TRIGGER schema_migrations_append_only BEFORE UPDATE OR DELETE ON karryam_admin.schema_migrations
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.reject_mutation();
CREATE TRIGGER schema_migrations_no_truncate BEFORE TRUNCATE ON karryam_admin.schema_migrations
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();

-- ---------------------------------------------------------------------------
-- 9.2.2 Bridge contract records: approval evidence, policy, signer, expiry.
-- A record never enables a capability; exposure is computed elsewhere.
-- Approval metadata is written once by the operator (migration identity).
-- ---------------------------------------------------------------------------
ALTER TABLE karryam_admin.bridge_contract_revisions
  ADD COLUMN contract_version text CHECK (contract_version IS NULL OR contract_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'),
  ADD COLUMN source_policy_revision text CHECK (source_policy_revision IS NULL OR source_policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  ADD COLUMN signer_ref text CHECK (signer_ref IS NULL OR signer_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  ADD COLUMN approval_evidence_ref text CHECK (approval_evidence_ref IS NULL OR approval_evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$'),
  ADD COLUMN approved_by text,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN expires_at timestamptz,
  ADD CONSTRAINT bridge_contract_approval_complete CHECK ((approved_at IS NULL) = (approved_by IS NULL) AND (approved_at IS NULL OR approval_evidence_ref IS NOT NULL)),
  ADD CONSTRAINT bridge_contract_expiry_after_approval CHECK (expires_at IS NULL OR approved_at IS NULL OR expires_at > approved_at);

CREATE FUNCTION karryam_admin.guard_contract_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision <> OLD.revision OR NEW.source_commit <> OLD.source_commit OR NEW.openapi_sha256 <> OLD.openapi_sha256
     OR NEW.matrix_sha256 <> OLD.matrix_sha256 OR NEW.capability_count <> OLD.capability_count OR NEW.first_seen_at <> OLD.first_seen_at
     OR NEW.contract_version IS DISTINCT FROM OLD.contract_version THEN
    RAISE EXCEPTION 'pinned contract identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.approved_at IS NOT NULL AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approval_evidence_ref IS DISTINCT FROM OLD.approval_evidence_ref OR NEW.source_policy_revision IS DISTINCT FROM OLD.source_policy_revision
     OR NEW.signer_ref IS DISTINCT FROM OLD.signer_ref OR NEW.expires_at IS DISTINCT FROM OLD.expires_at) THEN
    RAISE EXCEPTION 'contract approval evidence is recorded once' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bridge_contract_revisions_guard BEFORE UPDATE ON karryam_admin.bridge_contract_revisions
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_contract_revision();
CREATE TRIGGER bridge_contract_revisions_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.bridge_contract_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();

-- ---------------------------------------------------------------------------
-- 9.2.3 Runtime capability discovery cache. Separate from the pinned static
-- inventory: one row per capability per discovery, evaluated by the Bridge
-- for one staff member's roles. Expired or missing rows mean UNKNOWN, never
-- available. Append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE karryam_admin.capability_snapshots (
  id                     bigserial PRIMARY KEY,
  discovery_id           uuid NOT NULL,
  capability_id          text NOT NULL CHECK (capability_id ~ '^[a-z][a-z0-9_.-]{1,127}$'),
  observed_state         text NOT NULL CHECK (observed_state ~ '^[A-Z][A-Z_]{1,31}$'),
  required_permission    text NOT NULL CHECK (char_length(required_permission) BETWEEN 1 AND 128),
  risk                   text NOT NULL CHECK (risk IN ('R0','R1','R2','R3','R4')),
  source_owner           text NOT NULL CHECK (char_length(source_owner) BETWEEN 1 AND 128),
  contract_revision      text NOT NULL CHECK (contract_revision ~ '^[0-9a-f]{64}$'),
  source_openapi_sha256  text NOT NULL CHECK (source_openapi_sha256 ~ '^[0-9a-f]{64}$'),
  -- Only when the source reports one; never synthesized.
  policy_fingerprint     text CHECK (policy_fingerprint IS NULL OR policy_fingerprint ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  market                 text NOT NULL,
  organization           text NOT NULL,
  bridge_role            text NOT NULL,
  staff_ref              text NOT NULL,
  observed_at            timestamptz NOT NULL,
  expires_at             timestamptz NOT NULL,
  CONSTRAINT capability_snapshot_unique UNIQUE (discovery_id, capability_id),
  CONSTRAINT capability_snapshot_expiry CHECK (expires_at > observed_at AND expires_at <= observed_at + interval '1 day')
);
CREATE INDEX capability_snapshots_latest_idx ON karryam_admin.capability_snapshots (capability_id, bridge_role, observed_at DESC);
CREATE TRIGGER capability_snapshots_append_only BEFORE UPDATE OR DELETE ON karryam_admin.capability_snapshots
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.reject_mutation();
CREATE TRIGGER capability_snapshots_no_truncate BEFORE TRUNCATE ON karryam_admin.capability_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();

-- ---------------------------------------------------------------------------
-- 9.4.8 Legal holds and retention policy.
-- ---------------------------------------------------------------------------
CREATE TABLE karryam_admin.legal_holds (
  id              uuid PRIMARY KEY,
  hold_scope      text NOT NULL CHECK (hold_scope IN ('ENTITY','PARTITION')),
  source_service  text,
  entity_type     text,
  entity_ref      text,
  partition_key   text,
  reason_code     text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  case_reference  text NOT NULL CHECK (case_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  placed_by       text NOT NULL,
  approved_by     text NOT NULL,
  placed_at       timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  released_by     text,
  release_reason  text CHECK (release_reason IS NULL OR release_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT legal_hold_two_person CHECK (approved_by <> placed_by),
  CONSTRAINT legal_hold_entity_target CHECK ((hold_scope = 'ENTITY') = (source_service IS NOT NULL AND entity_type IS NOT NULL AND entity_ref IS NOT NULL)),
  CONSTRAINT legal_hold_partition_target CHECK ((hold_scope = 'PARTITION') = (partition_key IS NOT NULL)),
  CONSTRAINT legal_hold_release_complete CHECK ((released_at IS NULL) = (released_by IS NULL) AND (released_at IS NULL) = (release_reason IS NULL))
);
CREATE INDEX legal_holds_entity_active_idx ON karryam_admin.legal_holds (source_service, entity_type, entity_ref) WHERE released_at IS NULL;
CREATE INDEX legal_holds_partition_active_idx ON karryam_admin.legal_holds (partition_key) WHERE released_at IS NULL;

CREATE FUNCTION karryam_admin.guard_legal_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['released_at','released_by','release_reason']) <> (to_jsonb(OLD) - ARRAY['released_at','released_by','release_reason']) THEN
    RAISE EXCEPTION 'legal holds are immutable except a single release' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER legal_holds_guard BEFORE UPDATE ON karryam_admin.legal_holds
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_legal_hold();
CREATE TRIGGER legal_holds_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.legal_holds
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();

-- True when an unreleased hold covers the entity or its partition.
CREATE FUNCTION karryam_admin.under_legal_hold(p_partition text, p_service text, p_type text, p_ref text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM karryam_admin.legal_holds h WHERE h.released_at IS NULL AND (
    (h.hold_scope = 'PARTITION' AND h.partition_key = p_partition) OR
    (h.hold_scope = 'ENTITY' AND h.source_service = p_service AND h.entity_type = p_type AND h.entity_ref = p_ref)));
$$;

-- Per-data-class retention. Evidence classes are retained, never deleted by
-- an ordinary job. Changed only by the operator (runtime has SELECT).
CREATE TABLE karryam_admin.retention_policies (
  data_class      text PRIMARY KEY CHECK (data_class IN ('BRIDGE_EVENT_PAYLOAD','QUARANTINE_METADATA','INTEGRATION_AUDIT','SENSITIVE_ACCESS_LOG','PROJECTION_LINEAGE','OPERATION_RECEIPTS','SYNC_RUNS')),
  retention_days  integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  action          text NOT NULL CHECK (action IN ('CLEAR_PAYLOAD','RETAIN_EVIDENCE')),
  rationale       text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 240),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_evidence_kept CHECK (data_class = 'BRIDGE_EVENT_PAYLOAD' OR action = 'RETAIN_EVIDENCE'),
  CONSTRAINT retention_evidence_minimum CHECK (action <> 'RETAIN_EVIDENCE' OR retention_days >= 365)
);
INSERT INTO karryam_admin.retention_policies (data_class, retention_days, action, rationale) VALUES
  ('BRIDGE_EVENT_PAYLOAD', 30, 'CLEAR_PAYLOAD', 'Minimized payload cleared after 30 days; event identity, digest and lineage are kept'),
  ('QUARANTINE_METADATA', 730, 'RETAIN_EVIDENCE', 'Sanitized metadata and digests only; integrity evidence'),
  ('INTEGRATION_AUDIT', 2555, 'RETAIN_EVIDENCE', 'Append-only security and operation audit'),
  ('SENSITIVE_ACCESS_LOG', 2555, 'RETAIN_EVIDENCE', 'Accountability for sensitive administrative reads'),
  ('PROJECTION_LINEAGE', 2555, 'RETAIN_EVIDENCE', 'Source lineage for derived metrics'),
  ('OPERATION_RECEIPTS', 2555, 'RETAIN_EVIDENCE', 'Operation intent, approval and owner outcome evidence'),
  ('SYNC_RUNS', 730, 'RETAIN_EVIDENCE', 'Observed processing counters and outcomes');
CREATE TRIGGER retention_policies_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.retention_policies
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();

-- ---------------------------------------------------------------------------
-- 9.2.5 Inbox: payload clearing records why, and never happens under a
-- legal hold. Event identity, digest and lineage stay forever.
-- ---------------------------------------------------------------------------
ALTER TABLE karryam_admin.bridge_event_inbox
  ADD COLUMN payload_cleared_reason text CHECK (payload_cleared_reason IS NULL OR payload_cleared_reason IN ('RETENTION','ERASURE')),
  ADD CONSTRAINT inbox_payload_clear_reason CHECK ((payload_cleared_at IS NULL) OR payload_cleared_reason IS NOT NULL) NOT VALID;
ALTER TABLE karryam_admin.bridge_event_inbox DROP CONSTRAINT bridge_event_inbox_outcome_check;
ALTER TABLE karryam_admin.bridge_event_inbox ADD CONSTRAINT bridge_event_inbox_outcome_check
  CHECK (outcome IN ('APPLIED','GAP_APPLIED','STALE','LATE_APPLIED','LATE_STALE','SCOPE_CONFLICT'));

CREATE OR REPLACE FUNCTION karryam_admin.guard_inbox_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payload IS NOT NULL OR (to_jsonb(NEW) - 'payload' - 'payload_cleared_at' - 'payload_cleared_reason') <> (to_jsonb(OLD) - 'payload' - 'payload_cleared_at' - 'payload_cleared_reason') THEN
    RAISE EXCEPTION 'inbox rows are immutable except clearing of the payload' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.payload IS NOT NULL AND (NEW.payload_cleared_at IS NULL OR NEW.payload_cleared_reason IS NULL) THEN
    RAISE EXCEPTION 'payload clearing must record time and reason' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.payload IS NOT NULL AND karryam_admin.under_legal_hold(OLD.partition_key, OLD.source_service, OLD.entity_type, OLD.entity_ref) THEN
    RAISE EXCEPTION 'payload is under legal hold' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9.2.6 / 9.4.4 Projections: identity, partition and scope are immutable (a
-- source entity can never move into another tenant's projection); versions
-- only increase, except an authorized erasure that redacts the payload of
-- the current version.
-- ---------------------------------------------------------------------------
ALTER TABLE karryam_admin.entity_projections ADD COLUMN redacted_at timestamptz;

CREATE OR REPLACE FUNCTION karryam_admin.guard_projection_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_service <> OLD.source_service OR NEW.entity_type <> OLD.entity_type OR NEW.entity_ref <> OLD.entity_ref
     OR NEW.partition_key <> OLD.partition_key OR NEW.scope <> OLD.scope THEN
    RAISE EXCEPTION 'projection identity, partition and scope are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.redacted_at IS NOT NULL AND OLD.redacted_at IS NULL AND NEW.entity_version = OLD.entity_version THEN
    IF NEW.payload <> '{}'::jsonb OR (to_jsonb(NEW) - 'payload' - 'redacted_at' - 'updated_at') <> (to_jsonb(OLD) - 'payload' - 'redacted_at' - 'updated_at') THEN
      RAISE EXCEPTION 'redaction only clears the payload' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF karryam_admin.under_legal_hold(OLD.partition_key, OLD.source_service, OLD.entity_type, OLD.entity_ref) THEN
      RAISE EXCEPTION 'projection is under legal hold' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.entity_version <= OLD.entity_version THEN
    RAISE EXCEPTION 'projection version must increase (% -> %)', OLD.entity_version, NEW.entity_version USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER entity_projections_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.entity_projections
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();

-- ---------------------------------------------------------------------------
-- 9.2.7 / 9.4.5 Metric snapshots: explicit definition, grain, unit and
-- currency; exact numeric storage; minor-currency values are whole and carry
-- a currency; identity, unit and currency never change.
-- ---------------------------------------------------------------------------
ALTER TABLE karryam_admin.metric_snapshots
  ADD COLUMN dataset_id text CHECK (dataset_id IS NULL OR dataset_id ~ '^[a-z][a-z0-9_.-]{1,95}$'),
  ADD COLUMN definition_version text NOT NULL DEFAULT '1.0.0' CHECK (definition_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'),
  ADD COLUMN grain text NOT NULL DEFAULT 'DAY' CHECK (grain IN ('EVENT','HOUR','DAY','WEEK','MONTH','SNAPSHOT')),
  ADD COLUMN unit text NOT NULL DEFAULT 'count' CHECK (unit ~ '^[a-z][a-z0-9_]{0,31}$'),
  ADD COLUMN currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  ADD COLUMN numerator numeric,
  ADD COLUMN denominator numeric CHECK (denominator IS NULL OR denominator > 0),
  ADD CONSTRAINT metric_snapshot_currency_unit CHECK ((unit = 'minor_currency') = (currency IS NOT NULL)),
  ADD CONSTRAINT metric_snapshot_minor_units_whole CHECK (unit <> 'minor_currency' OR value IS NULL OR value = trunc(value)),
  ADD CONSTRAINT metric_snapshot_count_whole CHECK (unit <> 'count' OR value IS NULL OR (value >= 0 AND value = trunc(value))),
  ADD CONSTRAINT metric_snapshot_ratio_parts CHECK ((numerator IS NULL) = (denominator IS NULL)),
  ADD CONSTRAINT metric_snapshot_observed_time CHECK (value_state <> 'OBSERVED' OR observed_at IS NOT NULL);

CREATE FUNCTION karryam_admin.guard_metric_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.metric_id <> OLD.metric_id OR NEW.partition_key <> OLD.partition_key OR NEW.window_start <> OLD.window_start OR NEW.window_end <> OLD.window_end
     OR NEW.definition_version <> OLD.definition_version OR NEW.grain <> OLD.grain OR NEW.unit <> OLD.unit OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.dataset_id IS DISTINCT FROM OLD.dataset_id AND OLD.dataset_id IS NOT NULL THEN
    RAISE EXCEPTION 'metric identity, definition, unit and currency are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.entity_version <= OLD.entity_version THEN
    RAISE EXCEPTION 'metric snapshot version must increase' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER metric_snapshots_guard BEFORE UPDATE ON karryam_admin.metric_snapshots
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_metric_snapshot();
CREATE TRIGGER metric_snapshots_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.metric_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();
CREATE INDEX metric_snapshots_partition_metric_idx ON karryam_admin.metric_snapshots (partition_key, metric_id, window_start DESC);

-- ---------------------------------------------------------------------------
-- 9.2.8 Derived HQ outbox: schema identity and privacy classification are
-- materialized from the immutable event body and only HQ-syncable classes
-- are accepted.
-- ---------------------------------------------------------------------------
ALTER TABLE karryam_admin.hq_outbox
  ADD COLUMN schema_id text GENERATED ALWAYS AS (event->>'schema_id') STORED,
  ADD COLUMN schema_version text GENERATED ALWAYS AS (event->>'schema_version') STORED,
  ADD COLUMN classification text GENERATED ALWAYS AS (event->>'classification') STORED;
ALTER TABLE karryam_admin.hq_outbox
  ADD CONSTRAINT hq_outbox_schema_present CHECK (schema_id IS NOT NULL AND schema_version IS NOT NULL),
  ADD CONSTRAINT hq_outbox_classification_syncable CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL')),
  ADD CONSTRAINT hq_outbox_event_identity CHECK (event->>'event_id' = event_id::text AND (event->>'sequence')::bigint = sequence
    AND event->>'dataset_id' = dataset_id AND event->>'partition_key' = partition_key AND event->>'payload_digest' = payload_digest);
CREATE TRIGGER hq_outbox_heads_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.hq_outbox_heads
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();

-- 9.2.9 HQ ACKs never pass the committed outbox head (also on first insert).
CREATE OR REPLACE FUNCTION karryam_admin.guard_outbox_ack() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  head bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.acked_sequence < OLD.acked_sequence OR NEW.consumer <> OLD.consumer OR NEW.dataset_id <> OLD.dataset_id OR NEW.partition_key <> OLD.partition_key) THEN
    RAISE EXCEPTION 'HQ acknowledgement cannot regress' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT head_sequence INTO head FROM karryam_admin.hq_outbox_heads WHERE dataset_id = NEW.dataset_id AND partition_key = NEW.partition_key;
  IF head IS NULL OR NEW.acked_sequence > head THEN
    RAISE EXCEPTION 'HQ acknowledgement beyond the committed outbox head' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hq_outbox_acks_insert_guard BEFORE INSERT ON karryam_admin.hq_outbox_acks
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_outbox_ack();
CREATE TRIGGER hq_outbox_acks_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.hq_outbox_acks
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();

-- ---------------------------------------------------------------------------
-- 9.2.4 Feed cursors are never deleted; hold codes are sanitized.
-- ---------------------------------------------------------------------------
ALTER TABLE karryam_admin.bridge_feed_partitions
  ADD CONSTRAINT feed_hold_reason_code CHECK (hold_reason IS NULL OR hold_reason ~ '^[A-Z][A-Z0-9_]{2,63}$') NOT VALID;
CREATE TRIGGER bridge_feed_partitions_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.bridge_feed_partitions
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();

-- ---------------------------------------------------------------------------
-- 9.2.10 Sync runs: identity fixed at start; a finished run is immutable;
-- counters are nonnegative integers actually observed.
-- ---------------------------------------------------------------------------
CREATE FUNCTION karryam_admin.guard_sync_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'finished sync runs are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.stage <> OLD.stage OR NEW.trigger_kind <> OLD.trigger_kind OR NEW.partition_key IS DISTINCT FROM OLD.partition_key
     OR NEW.worker_id <> OLD.worker_id OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token OR NEW.started_at <> OLD.started_at
     OR NEW.contract_revision IS DISTINCT FROM OLD.contract_revision THEN
    RAISE EXCEPTION 'sync run identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(NEW.counts) c WHERE jsonb_typeof(c.value) <> 'number' OR (c.value)::numeric < 0 OR (c.value)::numeric <> trunc((c.value)::numeric)) THEN
    RAISE EXCEPTION 'sync run counters are nonnegative integers' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sync_runs_guard BEFORE UPDATE ON karryam_admin.sync_runs
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_sync_run();
CREATE TRIGGER sync_runs_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.sync_runs
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();
ALTER TABLE karryam_admin.sync_runs ADD COLUMN correlation_id text CHECK (correlation_id IS NULL OR correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');

-- ---------------------------------------------------------------------------
-- 9.2.11 Quarantine: digest and metadata only; repeat count; the identity
-- of a record is immutable; resolution needs a code and an operator, and a
-- re-detection reopens it (counted).
-- ---------------------------------------------------------------------------
ALTER TABLE karryam_admin.event_quarantine
  ADD COLUMN occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  ADD COLUMN last_seen_at timestamptz,
  ADD CONSTRAINT quarantine_resolution_complete CHECK ((resolved_at IS NULL) = (resolved_by IS NULL) AND (resolved_at IS NULL) = (resolution IS NULL)) NOT VALID,
  ADD CONSTRAINT quarantine_resolution_code CHECK (resolution IS NULL OR resolution ~ '^[A-Z][A-Z0-9_]{2,63}$') NOT VALID;

CREATE FUNCTION karryam_admin.guard_quarantine() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.partition_key <> OLD.partition_key OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.sequence IS DISTINCT FROM OLD.sequence
     OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.reason <> OLD.reason OR NEW.raw_digest <> OLD.raw_digest OR NEW.detected_at <> OLD.detected_at THEN
    RAISE EXCEPTION 'quarantine evidence is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.occurrences < OLD.occurrences THEN
    RAISE EXCEPTION 'quarantine occurrences cannot decrease' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Reopening a resolved record is only a re-detection.
  IF OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS NULL AND NEW.occurrences <= OLD.occurrences THEN
    RAISE EXCEPTION 'a resolved quarantine record reopens only on re-detection' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER event_quarantine_guard BEFORE UPDATE ON karryam_admin.event_quarantine
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_quarantine();
CREATE TRIGGER event_quarantine_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.event_quarantine
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();

-- Entity-version gaps: evidence is immutable; only the repair is recorded.
CREATE FUNCTION karryam_admin.guard_version_gap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.repaired_at IS NOT NULL OR (to_jsonb(NEW) - 'repaired_at' - 'repaired_by_run') <> (to_jsonb(OLD) - 'repaired_at' - 'repaired_by_run') THEN
    RAISE EXCEPTION 'entity version gaps are immutable except a single repair' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER entity_version_gaps_guard BEFORE UPDATE ON karryam_admin.entity_version_gaps
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_version_gap();
CREATE TRIGGER entity_version_gaps_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.entity_version_gaps
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();
CREATE TRIGGER projection_lineage_no_truncate BEFORE TRUNCATE ON karryam_admin.projection_lineage
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();
CREATE TRIGGER source_coverage_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.source_coverage
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();

-- ---------------------------------------------------------------------------
-- 9.2.13 Approval references: decisions are recorded once, an approval
-- records the approver's recent MFA, binds the expected source version and
-- policy revision, and can be revoked before it is consumed.
-- ---------------------------------------------------------------------------
ALTER TABLE karryam_admin.approval_references
  ADD COLUMN risk text CHECK (risk IS NULL OR risk IN ('R0','R1','R2','R3','R4')),
  ADD COLUMN expected_version bigint,
  ADD COLUMN source_policy_revision text CHECK (source_policy_revision IS NULL OR source_policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by text,
  ADD COLUMN revocation_reason text CHECK (revocation_reason IS NULL OR revocation_reason ~ '^[A-Z][A-Z0-9_]{2,63}$');
ALTER TABLE karryam_admin.approval_references DROP CONSTRAINT approval_references_status_check;
ALTER TABLE karryam_admin.approval_references ADD CONSTRAINT approval_references_status_check CHECK (status IN ('PROPOSED','APPROVED','REJECTED','CONSUMED','REVOKED'));
ALTER TABLE karryam_admin.approval_references DROP CONSTRAINT approval_decision_complete;
ALTER TABLE karryam_admin.approval_references
  ADD CONSTRAINT approval_decision_complete CHECK ((status = 'PROPOSED') = (decided_by IS NULL) OR (status = 'REVOKED' AND decided_by IS NULL)),
  ADD CONSTRAINT approval_revocation_complete CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL) AND (revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revocation_reason IS NULL)),
  ADD CONSTRAINT approval_mfa_recorded CHECK (status NOT IN ('APPROVED','CONSUMED') OR decided_mfa_at IS NOT NULL) NOT VALID;

CREATE OR REPLACE FUNCTION karryam_admin.guard_approval_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.capability_id <> OLD.capability_id OR NEW.intent_digest <> OLD.intent_digest OR NEW.scope <> OLD.scope
     OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at OR NEW.expires_at <> OLD.expires_at
     OR NEW.risk IS DISTINCT FROM OLD.risk OR NEW.expected_version IS DISTINCT FROM OLD.expected_version
     OR NEW.source_policy_revision IS DISTINCT FROM OLD.source_policy_revision THEN
    RAISE EXCEPTION 'approval binding is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.decided_by IS NOT NULL AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decided_mfa_at IS DISTINCT FROM OLD.decided_mfa_at) THEN
    RAISE EXCEPTION 'approval decisions are recorded once' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.revoked_by IS NOT NULL AND (NEW.revoked_by = OLD.requested_by AND OLD.status = 'APPROVED') THEN
    -- The requester may withdraw a proposal, never revoke an approval to re-request it unseen.
    RAISE EXCEPTION 'the requester cannot revoke an approved reference' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT ((OLD.status = 'PROPOSED' AND NEW.status IN ('APPROVED','REJECTED','REVOKED'))
       OR (OLD.status = 'APPROVED' AND NEW.status IN ('CONSUMED','REVOKED'))) THEN
    RAISE EXCEPTION 'approval transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9.2.12 Operation receipts: approval-referenced operations keep their
-- consumption one-to-one; receipts are never deleted (002). Index for
-- requester-scoped history.
-- ---------------------------------------------------------------------------
CREATE INDEX operation_requests_staff_idx ON karryam_admin.operation_requests (staff_ref, created_at DESC);
CREATE UNIQUE INDEX operation_requests_approval_once ON karryam_admin.operation_requests (approval_ref) WHERE approval_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 9.2.14 / 9.2.15 Audit and access log: explicit product identity; access
-- log records the classification and a stable hash of the effective scope.
-- ---------------------------------------------------------------------------
ALTER TABLE karryam_admin.integration_audit ADD COLUMN product_id text NOT NULL DEFAULT 'karryam' CHECK (product_id = 'karryam');
ALTER TABLE karryam_admin.sensitive_access_log ADD COLUMN product_id text NOT NULL DEFAULT 'karryam' CHECK (product_id = 'karryam');
CREATE INDEX sensitive_access_log_capability_idx ON karryam_admin.sensitive_access_log (capability_id, occurred_at);
CREATE INDEX integration_audit_staff_idx ON karryam_admin.integration_audit (staff_ref, occurred_at) WHERE staff_ref IS NOT NULL;

-- Replay nonces: only expired rows may be removed.
CREATE FUNCTION karryam_admin.guard_nonce_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.expires_at > now() THEN
    RAISE EXCEPTION 'unexpired replay nonces cannot be removed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER request_nonces_expired_delete_only BEFORE DELETE ON karryam_admin.request_nonces
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_nonce_delete();
CREATE TRIGGER request_nonces_no_update BEFORE UPDATE ON karryam_admin.request_nonces
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.reject_mutation();
