-- Section 9: HQ integration data governance (forward-only, hq_integration
-- schema only). Product-neutral: no product-specific branches. Does not
-- touch admin_ops_service_registry, Mail, HealthNet or any product database.
--
-- Backfill: new columns are nullable or have constant defaults; new CHECK
-- constraints on populated tables are NOT VALID (enforced for every new or
-- changed row without rewriting history) unless the existing data provably
-- satisfies them. Rollback-compatible: the previous image never writes the
-- new columns and every statement it issues still satisfies the guards.

CREATE OR REPLACE FUNCTION hq_integration.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- 9.5 Migration history is append-only.
CREATE TRIGGER hq_product_admin_schema_migrations_append_only BEFORE UPDATE OR DELETE ON hq_integration.hq_product_admin_schema_migrations
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();
CREATE TRIGGER hq_product_admin_schema_migrations_no_truncate BEFORE TRUNCATE ON hq_integration.hq_product_admin_schema_migrations
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();

-- ---------------------------------------------------------------------------
-- 9.3.1 / 9.3.2 Registrations: an ENABLED product always points at its own
-- ACTIVE certified contract (checked at commit, so activation inside one
-- transaction works). Registrations are never truncated.
-- ---------------------------------------------------------------------------
CREATE FUNCTION hq_integration.check_enabled_contract() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM hq_integration.hq_product_admins p
    LEFT JOIN hq_integration.hq_product_admin_contracts c ON c.id = p.current_contract_id
    WHERE p.lifecycle_status = 'ENABLED'
      AND (TG_TABLE_NAME <> 'hq_product_admins' OR p.id = NEW.id)
      AND (TG_TABLE_NAME <> 'hq_product_admin_contracts' OR p.current_contract_id = NEW.id)
      AND (c.id IS NULL OR c.product_admin_id <> p.id OR c.status <> 'ACTIVE')) THEN
    RAISE EXCEPTION 'an enabled product admin must reference its own active certified contract' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER hq_product_admins_enabled_contract AFTER INSERT OR UPDATE ON hq_integration.hq_product_admins
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hq_integration.check_enabled_contract();
CREATE CONSTRAINT TRIGGER hq_product_admin_contracts_enabled_contract AFTER UPDATE ON hq_integration.hq_product_admin_contracts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hq_integration.check_enabled_contract();
CREATE TRIGGER hq_product_admins_no_truncate BEFORE TRUNCATE ON hq_integration.hq_product_admins
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();
CREATE TRIGGER hq_product_admin_contracts_no_truncate BEFORE TRUNCATE ON hq_integration.hq_product_admin_contracts
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();

-- ---------------------------------------------------------------------------
-- 9.3.3 Staff grants: explicit effective date. A grant is not in force
-- before not_before nor at/after expires_at (enforced in authorize()).
-- ---------------------------------------------------------------------------
ALTER TABLE hq_integration.hq_product_admin_grants
  ADD COLUMN not_before timestamptz NULL,
  ADD CONSTRAINT hq_product_admin_grants_validity_window CHECK (expires_at IS NULL OR not_before IS NULL OR expires_at > not_before),
  ADD CONSTRAINT hq_product_admin_grants_revocation_reason CHECK (revoked_at IS NULL OR revocation_reason IS NOT NULL) NOT VALID;
CREATE TRIGGER hq_product_admin_grants_no_truncate BEFORE TRUNCATE ON hq_integration.hq_product_admin_grants
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();
-- loadGrants() reads every grant of one staff member (revoked and expired
-- included, so the decision can say why); the 001 partial index cannot serve it.
CREATE INDEX hq_product_admin_grants_staff_all_idx ON hq_integration.hq_product_admin_grants (staff_id);
CREATE INDEX hq_product_admin_grants_product_idx ON hq_integration.hq_product_admin_grants (product_id, staff_id) WHERE revoked_at IS NULL AND product_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 9.3.4 Datasets and subscriptions: a subscription is bound to one approved
-- dataset of the same product, its scope stays inside the product's
-- approved scope, and it can only be enabled while that dataset is
-- APPROVED. Identity and scope never change after creation.
-- ---------------------------------------------------------------------------
CREATE FUNCTION hq_integration.guard_subscription() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ds record;
  product_scope jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.product_admin_id <> OLD.product_admin_id OR NEW.dataset_row_id <> OLD.dataset_row_id
     OR NEW.consumer_department <> OLD.consumer_department OR NEW.schema_revision <> OLD.schema_revision OR NEW.schema_digest <> OLD.schema_digest
     OR NEW.allowed_scope <> OLD.allowed_scope OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'subscription identity and scope are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT d.product_admin_id, d.approval_status, d.privacy_class, d.schema_digest INTO ds FROM hq_integration.hq_product_admin_datasets d WHERE d.id = NEW.dataset_row_id;
  IF ds.product_admin_id IS DISTINCT FROM NEW.product_admin_id THEN
    RAISE EXCEPTION 'subscription dataset belongs to another product admin' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' AND ds.schema_digest <> NEW.schema_digest THEN
    RAISE EXCEPTION 'subscription schema digest differs from the approved dataset' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Checked when synchronization is switched on (insert or false -> true).
  IF NEW.enabled AND (TG_OP = 'INSERT' OR NOT OLD.enabled) AND (ds.approval_status <> 'APPROVED' OR ds.privacy_class NOT IN ('PUBLIC','INTERNAL','CONFIDENTIAL')) THEN
    RAISE EXCEPTION 'only an approved, HQ-syncable dataset can be synchronized' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT p.allowed_scope INTO product_scope FROM hq_integration.hq_product_admins p WHERE p.id = NEW.product_admin_id;
    IF EXISTS (SELECT 1 FROM jsonb_each(NEW.allowed_scope) s
               WHERE jsonb_typeof(s.value) <> 'array' OR jsonb_array_length(s.value) = 0
                  OR (product_scope ? s.key AND NOT (product_scope -> s.key) @> s.value)) THEN
      RAISE EXCEPTION 'subscription scope exceeds the approved product scope' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hq_product_admin_subscriptions_guard BEFORE INSERT OR UPDATE ON hq_integration.hq_product_admin_subscriptions
  FOR EACH ROW EXECUTE FUNCTION hq_integration.guard_subscription();
CREATE TRIGGER hq_product_admin_subscriptions_no_delete BEFORE DELETE ON hq_integration.hq_product_admin_subscriptions
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();
CREATE TRIGGER hq_product_admin_subscriptions_no_truncate BEFORE TRUNCATE ON hq_integration.hq_product_admin_subscriptions
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();
CREATE TRIGGER hq_product_admin_datasets_no_truncate BEFORE TRUNCATE ON hq_integration.hq_product_admin_datasets
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();

-- ---------------------------------------------------------------------------
-- 9.3.5 Cursors: never deleted; hold codes sanitized (002).
-- ---------------------------------------------------------------------------
CREATE TRIGGER hq_product_admin_sync_cursors_no_delete BEFORE DELETE ON hq_integration.hq_product_admin_sync_cursors
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();
CREATE TRIGGER hq_product_admin_sync_cursors_no_truncate BEFORE TRUNCATE ON hq_integration.hq_product_admin_sync_cursors
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();

-- ---------------------------------------------------------------------------
-- 9.4.7 / 9.4.8 Inbox: restricted field names never enter the generic HQ
-- inbox; minimized payloads may be cleared by retention (event identity,
-- digests and lineage stay) but never under an active legal hold.
-- ---------------------------------------------------------------------------
CREATE TABLE hq_integration.hq_product_admin_legal_holds (
  id uuid PRIMARY KEY,
  product_admin_id uuid NOT NULL REFERENCES hq_integration.hq_product_admins (id),
  dataset_id text NULL CHECK (dataset_id IS NULL OR dataset_id ~ '^[a-z][a-z0-9_.-]{1,95}$'),
  entity_type text NULL,
  entity_id text NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  case_reference text NOT NULL CHECK (case_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  placed_by text NOT NULL,
  approved_by text NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz NULL,
  released_by text NULL,
  release_reason text NULL CHECK (release_reason IS NULL OR release_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT hq_legal_hold_two_person CHECK (approved_by <> placed_by),
  CONSTRAINT hq_legal_hold_entity_pair CHECK ((entity_type IS NULL) = (entity_id IS NULL)),
  CONSTRAINT hq_legal_hold_release_complete CHECK ((released_at IS NULL) = (released_by IS NULL) AND (released_at IS NULL) = (release_reason IS NULL))
);
CREATE INDEX hq_product_admin_legal_holds_active_idx ON hq_integration.hq_product_admin_legal_holds (product_admin_id) WHERE released_at IS NULL;
CREATE FUNCTION hq_integration.guard_legal_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['released_at','released_by','release_reason']) <> (to_jsonb(OLD) - ARRAY['released_at','released_by','release_reason']) THEN
    RAISE EXCEPTION 'legal holds are immutable except a single release' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hq_product_admin_legal_holds_guard BEFORE UPDATE ON hq_integration.hq_product_admin_legal_holds
  FOR EACH ROW EXECUTE FUNCTION hq_integration.guard_legal_hold();
CREATE TRIGGER hq_product_admin_legal_holds_no_delete BEFORE DELETE OR TRUNCATE ON hq_integration.hq_product_admin_legal_holds
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();

CREATE FUNCTION hq_integration.under_legal_hold(p_product uuid, p_dataset text, p_entity_type text, p_entity_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM hq_integration.hq_product_admin_legal_holds h WHERE h.released_at IS NULL AND h.product_admin_id = p_product
    AND (h.dataset_id IS NULL OR h.dataset_id = p_dataset)
    AND (h.entity_type IS NULL OR (h.entity_type = p_entity_type AND h.entity_id = p_entity_id)));
$$;

-- Field names that never belong in generic HQ datasets (any product). The
-- contract validator refuses them first; this is the database backstop.
CREATE FUNCTION hq_integration.has_prohibited_field(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p) = 'object' AND EXISTS (
    SELECT 1 FROM jsonb_object_keys(p) k
    WHERE lower(k) ~ '^(nin|bvn|ssn|otp|one_time_code|password|passcode|pin|cvv|cvc|card_number|pan|iban|account_number|bank_account|routing_number|secret|api_key|access_token|refresh_token|private_key|passport_number|identity_document|id_document_image|selfie|gps_trail|location_trail|location_track|raw_location|latitude|longitude|diagnosis|medical_record|health_record|prescription)$');
$$;

ALTER TABLE hq_integration.hq_product_admin_event_inbox ALTER COLUMN payload DROP NOT NULL;
ALTER TABLE hq_integration.hq_product_admin_event_inbox
  ADD COLUMN payload_cleared_at timestamptz NULL,
  ADD COLUMN payload_cleared_reason text NULL CHECK (payload_cleared_reason IS NULL OR payload_cleared_reason IN ('RETENTION','ERASURE')),
  ADD CONSTRAINT hq_product_admin_event_inbox_payload_state CHECK ((payload IS NULL) = (payload_cleared_at IS NOT NULL) AND (payload_cleared_at IS NULL) = (payload_cleared_reason IS NULL)),
  ADD CONSTRAINT hq_product_admin_event_inbox_no_prohibited_field CHECK (NOT hq_integration.has_prohibited_field(payload)) NOT VALID;

DROP TRIGGER hq_product_admin_event_inbox_append_only ON hq_integration.hq_product_admin_event_inbox;
CREATE FUNCTION hq_integration.guard_inbox_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.payload IS NULL OR NEW.payload IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['payload','payload_cleared_at','payload_cleared_reason']) <> (to_jsonb(OLD) - ARRAY['payload','payload_cleared_at','payload_cleared_reason']) THEN
    RAISE EXCEPTION 'inbox rows are immutable except a single payload clearing' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF hq_integration.under_legal_hold(OLD.product_admin_id, OLD.dataset_id, OLD.entity_type, OLD.entity_id) THEN
    RAISE EXCEPTION 'inbox payload is under legal hold' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hq_product_admin_event_inbox_guard BEFORE UPDATE ON hq_integration.hq_product_admin_event_inbox
  FOR EACH ROW EXECUTE FUNCTION hq_integration.guard_inbox_update();
CREATE TRIGGER hq_product_admin_event_inbox_no_delete BEFORE DELETE ON hq_integration.hq_product_admin_event_inbox
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();
CREATE INDEX hq_product_admin_event_inbox_retention_idx ON hq_integration.hq_product_admin_event_inbox (subscription_id, received_at) WHERE payload IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 9.3.6 / 9.4.5 Metrics: minor-currency values carry a currency and are
-- whole; counts are nonnegative whole numbers; never deleted or truncated.
-- ---------------------------------------------------------------------------
ALTER TABLE hq_integration.hq_product_admin_metrics
  ADD CONSTRAINT hq_product_admin_metrics_minor_currency CHECK (unit <> 'minor_currency' OR (currency IS NOT NULL AND (value IS NULL OR value = trunc(value)))) NOT VALID,
  ADD CONSTRAINT hq_product_admin_metrics_count_whole CHECK (unit <> 'count' OR value IS NULL OR (value >= 0 AND value = trunc(value))) NOT VALID;
CREATE TRIGGER hq_product_admin_metrics_no_truncate BEFORE TRUNCATE ON hq_integration.hq_product_admin_metrics
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();

-- ---------------------------------------------------------------------------
-- 9.3.10 Sync runs: identity fixed at start; a finished run is immutable;
-- counters are nonnegative.
-- ---------------------------------------------------------------------------
ALTER TABLE hq_integration.hq_product_admin_sync_runs
  ADD CONSTRAINT hq_product_admin_sync_runs_counts CHECK (events_received >= 0 AND events_applied >= 0 AND events_duplicate >= 0 AND events_stale >= 0 AND events_quarantined >= 0) NOT VALID;
CREATE FUNCTION hq_integration.guard_sync_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'finished sync runs are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.product_admin_id <> OLD.product_admin_id OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
     OR NEW.partition_key IS DISTINCT FROM OLD.partition_key OR NEW.run_kind <> OLD.run_kind OR NEW.worker_id <> OLD.worker_id
     OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token OR NEW.correlation_id <> OLD.correlation_id OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'sync run identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hq_product_admin_sync_runs_guard BEFORE UPDATE ON hq_integration.hq_product_admin_sync_runs
  FOR EACH ROW EXECUTE FUNCTION hq_integration.guard_sync_run();
CREATE TRIGGER hq_product_admin_sync_runs_no_delete BEFORE DELETE ON hq_integration.hq_product_admin_sync_runs
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();
CREATE TRIGGER hq_product_admin_sync_runs_no_truncate BEFORE TRUNCATE ON hq_integration.hq_product_admin_sync_runs
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();

-- ---------------------------------------------------------------------------
-- 9.3.11 Quarantine: sanitized evidence is immutable; resolution is
-- recorded once with an operator and a reason code.
-- ---------------------------------------------------------------------------
ALTER TABLE hq_integration.hq_product_admin_quarantine
  ADD CONSTRAINT hq_product_admin_quarantine_resolution CHECK ((resolved_at IS NULL) = (resolved_by IS NULL) AND (resolved_at IS NULL) = (resolution IS NULL)) NOT VALID,
  ADD CONSTRAINT hq_product_admin_quarantine_digest CHECK (event_digest IS NULL OR event_digest ~ '^sha256:[0-9a-f]{64}$') NOT VALID,
  ADD CONSTRAINT hq_product_admin_quarantine_detail CHECK (jsonb_typeof(detail) = 'object' AND NOT hq_integration.has_prohibited_field(detail)) NOT VALID;
CREATE FUNCTION hq_integration.guard_quarantine() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolved_at IS NOT NULL OR NEW.resolved_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['resolved_at','resolved_by','resolution']) <> (to_jsonb(OLD) - ARRAY['resolved_at','resolved_by','resolution']) THEN
    RAISE EXCEPTION 'quarantine evidence is immutable except a single resolution' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hq_product_admin_quarantine_guard BEFORE UPDATE ON hq_integration.hq_product_admin_quarantine
  FOR EACH ROW EXECUTE FUNCTION hq_integration.guard_quarantine();
CREATE TRIGGER hq_product_admin_quarantine_no_truncate BEFORE TRUNCATE ON hq_integration.hq_product_admin_quarantine
  FOR EACH STATEMENT EXECUTE FUNCTION hq_integration.reject_mutation();
CREATE INDEX hq_product_admin_quarantine_open_idx ON hq_integration.hq_product_admin_quarantine (product_admin_id, subscription_id) WHERE resolved_at IS NULL;

-- 9.3.12 / 9.3.13 Append-only evidence: index for per-product history.
CREATE INDEX hq_product_admin_onboarding_approvals_product_idx ON hq_integration.hq_product_admin_onboarding_approvals (product_admin_id, created_at);

-- Replay nonces: only expired rows may be removed; never updated.
CREATE FUNCTION hq_integration.guard_nonce_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.expires_at > now() THEN
    RAISE EXCEPTION 'unexpired replay nonces cannot be removed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER hq_product_admin_replay_nonces_expired_delete_only BEFORE DELETE ON hq_integration.hq_product_admin_replay_nonces
  FOR EACH ROW EXECUTE FUNCTION hq_integration.guard_nonce_delete();
CREATE TRIGGER hq_product_admin_replay_nonces_no_update BEFORE UPDATE ON hq_integration.hq_product_admin_replay_nonces
  FOR EACH ROW EXECUTE FUNCTION hq_integration.reject_mutation();
