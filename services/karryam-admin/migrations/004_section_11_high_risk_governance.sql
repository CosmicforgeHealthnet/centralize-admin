-- Section 11.3: high-risk (R3/R4) command certification (forward-only).
--
-- An R3/R4 source command can become executable only when ALL of these hold:
-- the operator lists it in KARRYAM_ADMIN_ENABLED_COMMANDS, an unexpired and
-- unrevoked certification row exists for it under the pinned Bridge contract
-- revision (two distinct reviewers, evidence, source policy revision), the
-- Bridge reports it available at runtime, the requester has recent MFA, an
-- independent approver approved the exact intent, and the Bridge itself
-- authorizes the call. This table is written only by the operator with the
-- migration identity; the runtime role can read it (scripts/migrate.js).
-- It never enables anything by itself.

CREATE TABLE karryam_admin.high_risk_certifications (
  id                      uuid PRIMARY KEY,
  capability_id           text NOT NULL CHECK (capability_id ~ '^karryam\.[a-z][a-z0-9_.-]{1,127}$'),
  risk                    text NOT NULL CHECK (risk IN ('R3','R4')),
  contract_revision       text NOT NULL CHECK (contract_revision ~ '^[0-9a-f]{64}$'),
  source_policy_revision  text NOT NULL CHECK (source_policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  evidence_ref            text NOT NULL CHECK (evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$'),
  certified_by            text NOT NULL,
  second_reviewer         text NOT NULL,
  certified_at            timestamptz NOT NULL DEFAULT now(),
  valid_from              timestamptz NOT NULL,
  expires_at              timestamptz NOT NULL,
  revoked_at              timestamptz,
  revoked_by              text,
  revocation_reason       text CHECK (revocation_reason IS NULL OR revocation_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT high_risk_two_reviewers CHECK (second_reviewer <> certified_by),
  CONSTRAINT high_risk_validity CHECK (expires_at > valid_from AND expires_at <= valid_from + interval '180 days'),
  CONSTRAINT high_risk_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revocation_reason IS NULL))
);
-- One live certification per capability and contract revision.
CREATE UNIQUE INDEX high_risk_certifications_live_uq ON karryam_admin.high_risk_certifications (capability_id, contract_revision) WHERE revoked_at IS NULL;

CREATE FUNCTION karryam_admin.guard_high_risk_certification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['revoked_at','revoked_by','revocation_reason']) <> (to_jsonb(OLD) - ARRAY['revoked_at','revoked_by','revocation_reason']) THEN
    RAISE EXCEPTION 'high-risk certifications are immutable except a single revocation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER high_risk_certifications_guard BEFORE UPDATE ON karryam_admin.high_risk_certifications
  FOR EACH ROW EXECUTE FUNCTION karryam_admin.guard_high_risk_certification();
CREATE TRIGGER high_risk_certifications_no_delete BEFORE DELETE OR TRUNCATE ON karryam_admin.high_risk_certifications
  FOR EACH STATEMENT EXECUTE FUNCTION karryam_admin.reject_mutation();

-- Approvals for high-risk commands record which certification and source
-- policy revision the approver reviewed (bound at proposal, immutable).
ALTER TABLE karryam_admin.approval_references ADD COLUMN certification_id uuid REFERENCES karryam_admin.high_risk_certifications (id);

CREATE OR REPLACE FUNCTION karryam_admin.guard_approval_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.capability_id <> OLD.capability_id OR NEW.intent_digest <> OLD.intent_digest OR NEW.scope <> OLD.scope
     OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at OR NEW.expires_at <> OLD.expires_at
     OR NEW.risk IS DISTINCT FROM OLD.risk OR NEW.expected_version IS DISTINCT FROM OLD.expected_version
     OR NEW.source_policy_revision IS DISTINCT FROM OLD.source_policy_revision OR NEW.certification_id IS DISTINCT FROM OLD.certification_id THEN
    RAISE EXCEPTION 'approval binding is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.decided_by IS NOT NULL AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decided_mfa_at IS DISTINCT FROM OLD.decided_mfa_at) THEN
    RAISE EXCEPTION 'approval decisions are recorded once' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.revoked_by IS NOT NULL AND (NEW.revoked_by = OLD.requested_by AND OLD.status = 'APPROVED') THEN
    RAISE EXCEPTION 'the requester cannot revoke an approved reference' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT ((OLD.status = 'PROPOSED' AND NEW.status IN ('APPROVED','REJECTED','REVOKED'))
       OR (OLD.status = 'APPROVED' AND NEW.status IN ('CONSUMED','REVOKED'))) THEN
    RAISE EXCEPTION 'approval transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Forward fix of 003: an approval reference belongs to at most one operation
-- that was not refused. A refused attempt (e.g. a payload that did not match
-- the approved intent) leaves the approval unconsumed and usable by the
-- exact approved command; concurrent attempts still collide while RECORDED.
DROP INDEX karryam_admin.operation_requests_approval_once;
CREATE UNIQUE INDEX operation_requests_approval_once ON karryam_admin.operation_requests (approval_ref) WHERE approval_ref IS NOT NULL AND status <> 'REJECTED';
