-- Fail-closed synchronization gate and event integrity hold (PR #55 closure).
--
--  * sync runs blocked by the shared synchronization gate (unapproved
--    contract drift, identity drift, trust-store change, superseded contract)
--    are recorded as BLOCKED, and an ACK withheld for the same reason as
--    SKIPPED_BLOCKED;
--  * a cursor held at a quarantined event (or a sequence gap) records a
--    sanitized reason code. The held range is gap_from..gap_to, so the
--    cursor can never advance across it except by reconciliation.
-- Forward-only and rollback-compatible: existing rows are unchanged, and the
-- previous image keeps working against this schema (it never writes the new
-- values).

ALTER TABLE hq_integration.hq_product_admin_sync_runs DROP CONSTRAINT hq_product_admin_sync_runs_status_check;
ALTER TABLE hq_integration.hq_product_admin_sync_runs ADD CONSTRAINT hq_product_admin_sync_runs_status_check
  CHECK (status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL_GAP', 'FAILED', 'LEASE_LOST', 'ABORTED_REVOKED', 'SKIPPED_POLICY', 'BLOCKED'));

ALTER TABLE hq_integration.hq_product_admin_sync_runs DROP CONSTRAINT hq_product_admin_sync_runs_ack_status_check;
ALTER TABLE hq_integration.hq_product_admin_sync_runs ADD CONSTRAINT hq_product_admin_sync_runs_ack_status_check
  CHECK (ack_status IN ('NOT_REQUIRED', 'ACKED', 'ACK_FAILED', 'SKIPPED_REVOKED', 'SKIPPED_BLOCKED'));

ALTER TABLE hq_integration.hq_product_admin_sync_cursors ADD COLUMN hold_reason text NULL;
-- Format-only: an image rollback to code that predates hold_reason must still
-- be able to clear a gap (the engine always clears both together).
ALTER TABLE hq_integration.hq_product_admin_sync_cursors ADD CONSTRAINT hq_product_admin_sync_cursors_hold_reason
  CHECK (hold_reason IS NULL OR hold_reason ~ '^[A-Z][A-Z0-9_]{2,63}$');
