// Types for the HQ product gateway (`/api/products/...`), product-neutral.
//
// Wire shapes come from:
//   - packages/admin-contracts/src/protocol.js + schemas.js (response
//     envelope, operation-command.v1, read query allowlists);
//   - services/product-integration-core/src/api/products.js (navigation list,
//     manifest, datasets, metrics, events status);
//   - services/product-integration-core/src/onboarding/service.js (grant views);
//   - services/cfmeet-admin/src/operations/service.js (operation view, readback).
// Field names stay snake_case exactly as they travel on the wire.

/** Data freshness of a source observation (protocol FRESHNESS). */
export type Freshness = "FRESH" | "STALE" | "UNKNOWN";
/** Coverage of a source observation (protocol COVERAGE). */
export type Coverage = "COMPLETE" | "PARTIAL" | "NONE" | "UNKNOWN";

/** Stable protocol error codes (protocol ERROR_CODES). */
export type ProtocolErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_REQUEST"
  | "DISABLED"
  | "BLOCKED_POLICY"
  | "UNAVAILABLE"
  | "CONTRACT_MISMATCH"
  | "INTERNAL";

export interface ProtocolErrorBody {
  code: ProtocolErrorCode;
  /** Free-form SCREAMING_SNAKE reason, e.g. RECENT_MFA_REQUIRED. Never carries data. */
  reason: string;
  retryable?: boolean;
  /** Present when an operation exists for this error (read it back; never resend). */
  operation_id?: string;
}

/** Universal Product Admin response envelope (response-envelope.v1). */
export interface ProductEnvelope<T> {
  contract_version: string;
  product_id: string;
  correlation_id: string;
  /** Source observation time; null when nothing was observed (metadata reads). */
  as_of: string | null;
  freshness: Freshness;
  coverage: Coverage;
  result: T | null;
  error: ProtocolErrorBody | null;
}

/** A successful envelope: `result` is present and `error` is null. */
export interface ProductEnvelopeOk<T> extends ProductEnvelope<T> {
  result: T;
  error: null;
}

/** The as-of / freshness / coverage triple every figure must show. */
export interface DataQuality {
  as_of: string | null;
  freshness: Freshness;
  coverage: Coverage;
}

// ── Scope and queries ─────────────────────────────────────────────

export type ScopeDimension = "market" | "organization" | "zone" | "tenant";
/** Effective or requested scope: dimension -> exact values. */
export type ProductScope = Partial<Record<ScopeDimension, string[]>>;

/** One exact value per dimension, as used in read queries. */
export interface ScopeQuery {
  market?: string;
  organization?: string;
  zone?: string;
  tenant?: string;
}

/** Scoped reads (resources, reports) require market and organization. */
export interface RequiredScopeQuery extends ScopeQuery {
  market: string;
  organization: string;
}

/** GET /{p}/metrics/{metric} (gateway METRIC_QUERY_KEYS). */
export interface MetricQuery extends ScopeQuery {
  window_start?: string;
  window_end?: string;
  /** 1..100, default 31. */
  limit?: number;
}

/** Detail reads take no paging, search or parent (PIC refuses them). */
export interface ResourceDetailQuery extends RequiredScopeQuery {
  purpose?: string;
  start?: string;
  end?: string;
}

/** GET /{p}/resources/{capability}/{collection} (gateway RESOURCE_QUERY_KEYS). */
export interface ResourceListQuery extends ResourceDetailQuery {
  /** 1..100. */
  limit?: number;
  /** Opaque token from the previous page's `continuation`. */
  continuation?: string;
  /**
   * Free-text search (1..128 letters, digits, space and `._@:-`). A
   * contact-like value (an "@" or 7+ digits) is sent as POST .../search
   * automatically; it never appears in a URL.
   */
  q?: string;
  /** Parent resource of a nested collection (e.g. a user's sessions). */
  parent?: string;
}

/** GET /{p}/reports/{report} (gateway REPORT_QUERY_KEYS). */
export interface ReportQuery extends RequiredScopeQuery {
  purpose?: string;
  start?: string;
  end?: string;
  timezone?: string;
  authority?: string;
  product_code?: string;
}

/** GET /{p}/grants (gateway GRANT_QUERY_KEYS). */
export interface GrantListQuery {
  staff_id?: string;
  /** 1..100. */
  limit?: number;
  cursor?: string;
}

// ── Navigation (GET /api/products) ────────────────────────────────

export interface ProductDatasetGrant {
  dataset_id: string;
  title?: string;
  granted: boolean;
}

/** One product the staff member holds a grant for. Unavailable products only carry id, reason and null navigation. */
export interface ProductSummary {
  product_id: string;
  display_name?: string;
  available: boolean;
  /** Why the product is not available (e.g. NOT_REGISTERED, NOT_ENABLED); null when available. */
  reason: string | null;
  lifecycle_status?: string;
  contract_revision?: number | null;
  protocol?: { major: number; minor: number } | null;
  effective_scope?: ProductScope;
  role?: string | null;
  capability_states?: Record<string, number>;
  datasets?: ProductDatasetGrant[];
  navigation: { section: string; key: string; label: string } | null;
}

export interface ProductList {
  products: ProductSummary[];
}

// ── Catalog (manifest, capabilities, datasets) ────────────────────

export type CapabilityKind = "METADATA" | "READ" | "COMMAND";
export type CapabilityState = "AVAILABLE" | "READ_ONLY" | "DISABLED" | "BLOCKED_POLICY" | "BLOCKED_DEPENDENCY" | "UNAVAILABLE";
export type RiskLevel = "R0" | "R1" | "R2" | "R3" | "R4";

export interface Blocker {
  code: string;
  detail: string;
}

export interface ProductCapability {
  id: string;
  version: string;
  kind: CapabilityKind;
  state: CapabilityState;
  risk: RiskLevel;
  description: string;
  datasets: string[];
  blockers: Blocker[];
  requires_recent_mfa: boolean;
  requires_independent_approval: boolean;
  request_schema?: Record<string, unknown> | null;
}

export interface ProductManifest {
  product_id: string;
  display_name: string;
  environment: string;
  contract_revision: number;
  protocol: { major: number; minor: number };
  build_sha: string;
  manifest_revision: number;
  manifest_digest: string;
  catalog_digest: string;
  manifest_expires_at: string | null;
  drift_status: string;
  capabilities: ProductCapability[];
  event_families: Record<string, unknown>[];
}

/** Live capability discovery. `capabilities` is protocol-defined; other keys are product-specific. */
export interface ProductCapabilities {
  capabilities: ProductCapability[];
  [productSpecific: string]: unknown;
}

export interface ProductMetricDefinition {
  metric_id: string;
  version: string;
  unit: string;
  currency: string | null;
  grain: string;
  aggregation: string;
  definition: string;
}

export interface ProductDataset {
  dataset_id: string;
  version: string;
  privacy_class: string;
  semantic_grain: string;
  currency: string | null;
  freshness_target_seconds: number;
  scope_dimensions: ScopeDimension[];
  metrics: ProductMetricDefinition[];
  synchronization: { coverage: Coverage; gap_status: string; last_source_observation_at: string | null };
}

export interface ProductDatasets {
  contract_revision: number;
  datasets: ProductDataset[];
}

// ── Metrics ───────────────────────────────────────────────────────

export interface MetricObservation {
  window_start: string;
  window_end: string;
  grain: string;
  unit: string;
  currency: string | null;
  /** Null unless value_state is OBSERVED. Unavailable is never zero. */
  value: number | null;
  value_state: "OBSERVED" | "UNAVAILABLE";
  source_observed_at: string | null;
  freshness: Freshness;
  coverage: Coverage;
  source_entity_version: number;
  projection_version: number;
  contract_revision: number;
}

export interface MetricResult {
  metric: ProductMetricDefinition & { dataset_id: string };
  scope: ScopeQuery;
  observations: MetricObservation[];
}

// ── Resources and reports (protocol 1.1) ──────────────────────────

/**
 * Scoped resource read. `data` is the product's payload (lists usually carry
 * `data.items`); `continuation` is the opaque token for the next page, or null.
 */
export interface ResourceRead<TData = unknown> {
  module?: string;
  capability_id?: string;
  collection_id?: string;
  kind?: "LIST" | "DETAIL";
  source?: Record<string, unknown>;
  scope?: ScopeQuery;
  filters?: Record<string, unknown>;
  quality?: string;
  source_freshness?: string;
  observed_at?: string | null;
  first_page_observed_at?: string | null;
  bridge_correlation_id?: string | null;
  data: TData;
  continuation?: string | null;
}

/** Common list payload shape (`data.items`). Products may add keys. */
export interface ResourceListData<TItem = Record<string, unknown>> {
  items: TItem[];
  [productSpecific: string]: unknown;
}

// ── Events status ─────────────────────────────────────────────────

export interface EventsSubscriptionStatus {
  dataset_id: string;
  enabled: boolean;
  status: string;
  coverage: Coverage;
  gap_status: string;
  quarantined_count: number;
  last_success_at: string | null;
  last_source_observation_at: string | null;
  lag_seconds: number | null;
}

export interface EventsCursorStatus {
  partition_key: string;
  last_sequence: number;
  acked_sequence: number;
  head_sequence: number | null;
  sequence_lag: number | null;
  gap: { from: number; to: number } | null;
}

export interface EventsStatus {
  registry: Record<string, unknown>;
  connection: Record<string, unknown>;
  drift: Record<string, unknown>;
  sync: Record<string, unknown>;
  quarantine: Record<string, unknown>;
  subscriptions: EventsSubscriptionStatus[];
  cursors: EventsCursorStatus[];
}

// ── Operations ────────────────────────────────────────────────────

/** Requested scope of a command; market and organization are required. */
export interface CommandScope extends ProductScope {
  market: string[];
  organization: string[];
}

/** operation-command.v1 — exactly these fields (additionalProperties: false). */
export interface OperationCommand<TParams extends Record<string, unknown> = Record<string, unknown>> {
  command_id: string;
  /** ^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$ */
  idempotency_key: string;
  capability_id: string;
  target: { type: string; id: string; expected_version: number | null };
  params: TParams;
  /** ^[A-Z][A-Z0-9_]{2,63}$ */
  reason_code: string;
  case_reference: string | null;
  scope: CommandScope;
}

/** Params shape for Bridge-mapped commands (e.g. CF Meet): the exact source body and an optional approval reference. */
export interface BridgeCommandParams extends Record<string, unknown> {
  body: Record<string, unknown>;
  approval_ref?: string;
}

/** Operation status. UNKNOWN_OUTCOME is only ever settled by readback, never by resending. */
export type OperationStatus = "RECORDED" | "DISPATCHING" | "SUCCEEDED" | "FAILED" | "REJECTED" | "UNKNOWN_OUTCOME";

export type ReadbackState =
  | "SETTLED_BY_READBACK"
  | "STILL_UNKNOWN"
  | "NO_READBACK_CONTRACT"
  | "READBACK_REQUIRES_STAFF_CONTEXT"
  | "READBACK_UNAVAILABLE";

export interface OperationReadback {
  state: ReadbackState | string;
  reason?: string;
  source_status?: string | null;
}

export interface OperationView {
  operation_id: string;
  capability_id: string;
  status: OperationStatus | string;
  reason_code: string | null;
  created_at: string;
  updated_at: string;
  /** True only when the source confirmed the change (SUCCEEDED). */
  executed: boolean;
  /** True when the final outcome is known (SUCCEEDED, FAILED or REJECTED). */
  outcome_known: boolean;
  source_status?: string | null;
  source_version?: number | null;
  evidence?: Record<string, unknown> | null;
  approval_ref?: string | null;
  /** The submit was a replay of an existing command (same command_id). */
  replay?: boolean;
  approval?: Record<string, unknown>;
  /** Present on GET /operations/{id}: what the authoritative readback found (null when settled already). */
  readback?: OperationReadback | null;
}

export interface OperationAuditRecord {
  occurred_at: string;
  correlation_id: string | null;
  endpoint: string;
  method: string;
  service_id: string | null;
  staff_ref: string | null;
  action: string;
  outcome: string;
  reason_code: string | null;
}

export interface OperationAudit {
  operation_id: string;
  records: OperationAuditRecord[];
}

// ── Grants (read-only views; recent MFA required) ─────────────────

export type GrantStatus = "ACTIVE" | "EXPIRED" | "NOT_YET_VALID" | "REVOKED";

export interface ProductGrant {
  grant_id: string;
  grant_kind: string;
  product_id: string;
  staff_id: string;
  role: string | null;
  effect: string;
  actions: string[];
  datasets: string[] | null;
  scope: ProductScope;
  not_before: string | null;
  expires_at: string | null;
  granted_by: string | null;
  created_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revocation_reason: string | null;
  status: GrantStatus;
}

export interface ProductGrantList {
  product_id: string;
  grants: ProductGrant[];
  limit: number;
  next_cursor: string | null;
}
