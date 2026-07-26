const REQUIRED_TABLES = Object.freeze([
  "marketing_execution_plans", "marketing_execution_plan_items", "marketing_execution_approvals", "marketing_execution_approval_events",
  "marketing_execution_runs", "marketing_execution_jobs", "marketing_provider_operations", "marketing_provider_operation_attempts",
  "marketing_execution_state_snapshots", "marketing_execution_validation_issues", "marketing_execution_reconciliations", "marketing_execution_policies",
  "marketing_creative_publications", "marketing_creative_media_validation_evidence", "marketing_creative_publication_review_events", "marketing_targeting_discovery",
  "marketing_execution_account_locks", "marketing_execution_dead_letter_reviews", "marketing_execution_policy_history", "marketing_execution_validation_packets",
  "marketing_execution_drift_acknowledgments", "marketing_execution_retry_reviews", "marketing_execution_reconciliation_jobs", "marketing_execution_compensation_links",
  "marketing_execution_emergency_overrides",
]);
const REQUIRED_INDEXES = Object.freeze([
  "IDX_marketing_execution_jobs_claim", "IDX_marketing_execution_jobs_expired_lease", "UQ_marketing_execution_jobs_submission_identity",
  "UQ_marketing_execution_jobs_active_account", "UQ_marketing_provider_operations_key", "UQ_marketing_creative_publications_revision",
  "UQ_marketing_execution_plans_active_source_recommendation", "IDX_marketing_reconciliation_jobs_claim", "IDX_marketing_reconciliation_jobs_lease",
  "IDX_marketing_compensation_links_original", "IDX_marketing_compensation_links_reconciliation", "IDX_marketing_targeting_discovery_lookup",
  "UQ_marketing_execution_policy_history_version", "UQ_marketing_execution_validation_packets_identity", "IDX_marketing_execution_drift_ack_timeline",
  "UQ_marketing_execution_retry_reviews_key", "IDX_marketing_execution_plans_provider_account_status", "IDX_marketing_creative_publications_list",
  "IDX_marketing_execution_jobs_cancellation_request", "IDX_marketing_execution_overrides_active",
]);
const REQUIRED_ENUMS = Object.freeze([
  "MarketingExecutionPlanStatus", "MarketingExecutionJobStatus", "MarketingExecutionOperationStatus", "MarketingExecutionOutcomeCertainty",
  "MarketingExecutionReconciliationStatus", "MarketingExecutionPolicyScope", "MarketingExecutionRecoveryOutcome",
]);

const cache = new WeakMap();
function missing(required, actual) { const available = new Set(actual); return required.filter((name) => !available.has(name)); }

function createExecutionSchemaAssertion({ client, cacheTtlMs = 60_000, now = () => Date.now() } = {}) {
  async function inspect({ force = false } = {}) {
    const cached = cache.get(client);
    if (!force && cached && cached.expiresAt > now()) return cached.value;
    if (!client || typeof client.$queryRawUnsafe !== "function") return { ready: false, category: "SCHEMA", counts: { tables: 0, indexes: 0, enums: 0 } };
    try {
      const [tables, indexes, enums] = await Promise.all([
        client.$queryRawUnsafe("SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = current_schema() AND tablename = ANY($1::text[])", [...REQUIRED_TABLES]),
        client.$queryRawUnsafe("SELECT indexname AS name FROM pg_catalog.pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1::text[])", [...REQUIRED_INDEXES]),
        client.$queryRawUnsafe("SELECT typname AS name FROM pg_catalog.pg_type WHERE typname = ANY($1::text[])", [...REQUIRED_ENUMS]),
      ]);
      const absent = { tables: missing(REQUIRED_TABLES, tables.map((row) => row.name)), indexes: missing(REQUIRED_INDEXES, indexes.map((row) => row.name)), enums: missing(REQUIRED_ENUMS, enums.map((row) => row.name)) };
      const value = { ready: !absent.tables.length && !absent.indexes.length && !absent.enums.length, category: !absent.tables.length && !absent.indexes.length && !absent.enums.length ? null : "SCHEMA", counts: { tables: tables.length, indexes: indexes.length, enums: enums.length }, required: { tables: REQUIRED_TABLES.length, indexes: REQUIRED_INDEXES.length, enums: REQUIRED_ENUMS.length }, missingCounts: { tables: absent.tables.length, indexes: absent.indexes.length, enums: absent.enums.length } };
      cache.set(client, { value, expiresAt: now() + Math.min(Math.max(cacheTtlMs, 5_000), 300_000) });
      return value;
    } catch (_error) {
      const value = { ready: false, category: "DATABASE", counts: { tables: 0, indexes: 0, enums: 0 }, required: { tables: REQUIRED_TABLES.length, indexes: REQUIRED_INDEXES.length, enums: REQUIRED_ENUMS.length } };
      cache.set(client, { value, expiresAt: now() + 5_000 }); return value;
    }
  }
  function invalidate() { cache.delete(client); }
  return Object.freeze({ inspect, invalidate });
}

module.exports = { REQUIRED_TABLES, REQUIRED_INDEXES, REQUIRED_ENUMS, createExecutionSchemaAssertion };
