-- Approvals inbox (design section 10): read-only listing of two-person approvals
-- for HQ ("waiting for me" and "my requests"). Forward-only and additive.
--
-- A proposal records the safe parts of the proposing command (target type
-- and ID, reason code, case reference) so an approver can see what the
-- approval is for without any request body. They are bound at proposal and
-- immutable afterwards, like the rest of the approval binding. Rows created
-- before this migration keep NULL here.

ALTER TABLE cfmeet_admin.approval_references
  ADD COLUMN target_type text CHECK (target_type IS NULL OR target_type ~ '^[a-z][a-z0-9_.-]{1,95}$'),
  ADD COLUMN target_id text CHECK (target_id IS NULL OR target_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  ADD COLUMN request_reason_code text CHECK (request_reason_code IS NULL OR request_reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  ADD COLUMN case_reference text CHECK (case_reference IS NULL OR case_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');

CREATE FUNCTION cfmeet_admin.guard_approval_summary() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_type IS DISTINCT FROM OLD.target_type OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.request_reason_code IS DISTINCT FROM OLD.request_reason_code OR NEW.case_reference IS DISTINCT FROM OLD.case_reference THEN
    RAISE EXCEPTION 'approval intent summary is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER approval_references_summary_guard BEFORE UPDATE ON cfmeet_admin.approval_references
  FOR EACH ROW EXECUTE FUNCTION cfmeet_admin.guard_approval_summary();

-- "My requests": one requester's approvals, newest first (keyset paging).
CREATE INDEX approval_references_requester_idx ON cfmeet_admin.approval_references (requested_by, requested_at DESC, id DESC);
-- "Waiting for me": open proposals, newest first (keyset paging).
CREATE INDEX approval_references_proposed_idx ON cfmeet_admin.approval_references (requested_at DESC, id DESC) WHERE status = 'PROPOSED';
