-- Section 10.1.4 / 11.3: governed command forwarding through HQ
-- (forward-only, hq_integration only, product-neutral).
--
-- Enabling or disabling operations for a product is an onboarding decision
-- recorded in the append-only approval history. Operations can only be on
-- for a registration that has a current contract. Rollback-compatible: the
-- previous image never enables operations and never writes the new values.

ALTER TABLE hq_integration.hq_product_admin_onboarding_approvals DROP CONSTRAINT hq_product_admin_onboarding_approvals_decision_check;
ALTER TABLE hq_integration.hq_product_admin_onboarding_approvals ADD CONSTRAINT hq_product_admin_onboarding_approvals_decision_check
  CHECK (decision IN ('TRANSITION', 'DATASET_APPROVED', 'DATASET_REJECTED', 'CONTRACT_VALIDATED', 'CONTRACT_CERTIFIED', 'CONTRACT_ACTIVATED', 'CONTRACT_REJECTED',
                      'SUBSCRIPTION_CHANGED', 'IDENTITY_CHECK_FAILED', 'OPERATIONS_ENABLED', 'OPERATIONS_DISABLED'));

ALTER TABLE hq_integration.hq_product_admins
  ADD CONSTRAINT hq_product_admins_operations_need_contract CHECK (NOT operations_enabled OR current_contract_id IS NOT NULL) NOT VALID;

-- Turning operations on is a reviewed change: it must advance the revision.
CREATE FUNCTION hq_integration.guard_operations_switch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operations_enabled AND NOT OLD.operations_enabled THEN
    IF NEW.lifecycle_status <> 'ENABLED' OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'operations can only be enabled on an enabled product as a reviewed revision' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hq_product_admins_operations_switch BEFORE UPDATE OF operations_enabled ON hq_integration.hq_product_admins
  FOR EACH ROW EXECUTE FUNCTION hq_integration.guard_operations_switch();
