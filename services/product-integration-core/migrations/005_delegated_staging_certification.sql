-- Preserve ordinary independent certification; record the separately verified,
-- time-limited staging operator exception explicitly rather than inventing actors.
ALTER TABLE hq_integration.hq_product_admin_contracts
  ADD COLUMN operator_certification_decision_ref text NULL;
ALTER TABLE hq_integration.hq_product_admin_contracts
  DROP CONSTRAINT hq_product_admin_contracts_certified;
ALTER TABLE hq_integration.hq_product_admin_contracts
  ADD CONSTRAINT hq_product_admin_contracts_certified CHECK (
    status NOT IN ('CERTIFIED','ACTIVE','SUPERSEDED') OR
    (certified_by IS NOT NULL AND certified_at IS NOT NULL AND
      (certified_by <> validated_by OR operator_certification_decision_ref IS NOT NULL))
  );
CREATE FUNCTION hq_integration.guard_delegated_certification() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE registration hq_integration.hq_product_admins; proof jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.operator_certification_decision_ref IS NOT NULL THEN
    IF NEW.operator_certification_decision_ref IS DISTINCT FROM OLD.operator_certification_decision_ref THEN
      RAISE EXCEPTION 'delegated certification evidence is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.operator_certification_decision_ref IS NULL THEN RETURN NEW; END IF;
  IF TG_OP <> 'UPDATE' OR OLD.status <> 'VALIDATED' OR NEW.status <> 'CERTIFIED'
     OR NEW.certified_by <> NEW.validated_by OR NEW.certified_by !~ '^operator:root@[A-Za-z0-9._-]+$' THEN
    RAISE EXCEPTION 'invalid delegated certification transition' USING ERRCODE='23514';
  END IF;
  SELECT * INTO registration FROM hq_integration.hq_product_admins WHERE id=NEW.product_admin_id;
  IF registration.environment <> 'staging' THEN
    RAISE EXCEPTION 'delegated certification is staging only' USING ERRCODE='23514';
  END IF;
  SELECT metadata INTO proof FROM hq_integration.hq_product_admin_security_audit
   WHERE actor_type='OPERATOR' AND actor_id=NEW.certified_by AND product_id=registration.product_id
     AND action='integration.certify' AND outcome='ALLOWED' AND reason_code='OWNER_DELEGATED_STAGING_SETUP'
     AND metadata->>'decision_ref'=NEW.operator_certification_decision_ref
     AND occurred_at >= CURRENT_TIMESTAMP - interval '5 minutes'
   ORDER BY id DESC LIMIT 1;
  IF COALESCE(proof IS NULL OR proof->'independence_exception' IS DISTINCT FROM 'true'::jsonb OR proof->'staff_session_used' IS DISTINCT FROM 'false'::jsonb OR NOT (proof ?& ARRAY['environment','decision_issued_at','decision_expires_at','decision_digest','authority_digest','scope_market','scope_organization','scope_zone','scope_tenant']) OR proof->>'environment' IS DISTINCT FROM 'staging'
     OR (proof->>'decision_expires_at')::timestamptz <= CURRENT_TIMESTAMP
     OR (proof->>'decision_issued_at')::timestamptz > CURRENT_TIMESTAMP
     OR (proof->>'decision_expires_at')::timestamptz > (proof->>'decision_issued_at')::timestamptz + interval '1 hour'
     OR proof->>'decision_digest' !~ '^[0-9a-f]{64}$'
     OR proof->>'authority_digest' !~ '^[0-9a-f]{64}$'
     OR registration.allowed_scope IS DISTINCT FROM jsonb_build_object(
       'market',jsonb_build_array(proof->>'scope_market'),
       'organization',jsonb_build_array(proof->>'scope_organization'),
       'zone',jsonb_build_array(proof->>'scope_zone'),
       'tenant',jsonb_build_array(proof->>'scope_tenant')), TRUE) THEN
    RAISE EXCEPTION 'current scoped delegated certification evidence required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hq_product_admin_contracts_delegated_guard
BEFORE INSERT OR UPDATE ON hq_integration.hq_product_admin_contracts
FOR EACH ROW EXECUTE FUNCTION hq_integration.guard_delegated_certification();
