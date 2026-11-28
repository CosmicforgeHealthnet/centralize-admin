// Wire types for HQ product integration administration
// (/api/admin/product-integrations, /api/admin/product-integration-grants).
// The gateway forwards these routes to the Product Integration Core (PIC),
// which answers `{ success: true, data }`. Shapes mirror
// services/product-integration-core/src/onboarding/service.js and
// src/monitoring/index.js; snake_case as on the wire.

/** Onboarding lifecycle (PIC onboarding/state-machine.js). */
export type LifecycleStatus =
  | "DRAFT"
  | "REQUESTED"
  | "IDENTITY_VERIFIED"
  | "CONTRACT_VALIDATED"
  | "POLICY_REVIEWED"
  | "CERTIFIED_STAGING"
  | "ENABLED"
  | "REJECTED"
  | "SUSPENDED"
  | "REVOKED";

export type HealthStatus = "UNKNOWN" | "REACHABLE" | "UNREACHABLE" | "DEGRADED";
export type SyncStatus = "NOT_STARTED" | "HEALTHY" | "LAGGING" | "GAP_DETECTED" | "FAILING" | "STOPPED";
export type DriftStatus = "NONE" | "ADDITIVE_PENDING_REVIEW" | "BREAKING_DETECTED" | "IDENTITY_MISMATCH" | "MANIFEST_INVALID" | "MANIFEST_EXPIRED";
export type ContractStatus = "VALIDATED" | "CERTIFIED" | "ACTIVE" | "SUPERSEDED" | "REJECTED";
export type DatasetApprovalStatus = "PROPOSED" | "APPROVED" | "REJECTED" | "RETIRED";
export type PrivacyClass = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED_PII";
export type SubscriptionStatus = "ACTIVE" | "SUSPENDED" | "POLICY_BLOCKED";
export type Coverage = "COMPLETE" | "PARTIAL" | "NONE" | "UNKNOWN";

/** Exact scope values per dimension; never wildcards. */
export type ScopeDimension = "market" | "organization" | "zone" | "tenant";
export type ExactScope = Partial<Record<ScopeDimension, string[]>>;

/** One row of hq_product_admins (GET list / GET {id}.registration / transition results). */
export interface IntegrationRegistration {
  id: string;
  product_id: string;
  display_name: string;
  service_instance_id: string;
  environment: string;
  endpoint_ref: string;
  workload_identity: string;
  identity_fingerprint_ref: string | null;
  approved_signer_kid: string;
  supported_protocol_major?: number;
  allowed_scope: ExactScope;
  lifecycle_status: LifecycleStatus;
  revision: number;
  current_contract_id: string | null;
  manifest_digest: string | null;
  manifest_revision: number | null;
  manifest_expires_at: string | null;
  identity_verified_at: string | null;
  operations_enabled: boolean;
  requested_by: string;
  health_status: HealthStatus;
  health_checked_at: string | null;
  sync_status: SyncStatus;
  drift_status: DriftStatus;
  drift_detected_at: string | null;
  activated_at: string | null;
  activated_by: string | null;
  suspended_at: string | null;
  suspended_by: string | null;
  suspension_reason: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revocation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntegrationContract {
  id: string;
  revision: number;
  status: ContractStatus;
  manifest_revision: number | null;
  manifest_digest: string | null;
  catalog_digest: string | null;
  build_sha: string | null;
  compatibility: { decision?: string; changes?: unknown[] } | null;
  validated_by: string | null;
  validated_at: string | null;
  certified_by: string | null;
  certified_at: string | null;
  certification_evidence_ref: string | null;
  activated_at: string | null;
}

export interface IntegrationDataset {
  id: string;
  dataset_id: string;
  version: string;
  privacy_class: PrivacyClass;
  approval_status: DatasetApprovalStatus;
  approved_by: string | null;
  approved_at: string | null;
  authorized_departments: string[];
  scope_dimensions: ScopeDimension[];
}

export interface IntegrationSubscription {
  id: string;
  dataset_row_id: string;
  consumer_department: string;
  enabled: boolean;
  status: SubscriptionStatus;
  coverage: Coverage;
  gap_status: "NONE" | "GAP_DETECTED";
  quarantined_count: number;
  last_success_at: string | null;
  last_source_observation_at: string | null;
}

export interface OnboardingHistoryEntry {
  id: number | string;
  decision: string;
  from_status: string | null;
  to_status: string | null;
  actor_id: string;
  reason_code: string | null;
  evidence_ref: string | null;
  expected_revision: number | null;
  resulting_revision: number | null;
  contract_id: string | null;
  created_at: string;
}

/** GET /api/admin/product-integrations/{id}. */
export interface IntegrationDetail {
  registration: IntegrationRegistration;
  contracts: IntegrationContract[];
  datasets: IntegrationDataset[];
  subscriptions: IntegrationSubscription[];
  history: OnboardingHistoryEntry[];
}

/** GET /api/admin/product-integrations/{id}/monitoring (PIC monitoring/index.js). */
export interface IntegrationMonitoring {
  product_id: string;
  environment: string;
  registry: { status: LifecycleStatus; revision: number; revoked: boolean; suspended: boolean; revocation_reason: string | null; suspension_reason: string | null };
  identity: { verified_at: string | null; manifest_revision: number | null; manifest_expires_at: string | null; manifest_expired: boolean; manifest_expires_in_seconds: number | null };
  connection: { health_status: HealthStatus; checked_at: string | null };
  contract: { revision: number; status: ContractStatus; protocol_major: number; protocol_minor: number; build_sha: string | null; activated_at: string | null } | null;
  drift: { status: DriftStatus; detected_at: string | null };
  datasets: { dataset_id: string; version: string; approval_status: DatasetApprovalStatus; privacy_class: PrivacyClass }[];
  subscriptions: {
    id: string;
    dataset_id: string;
    schema_revision: string;
    consumer_department: string;
    enabled: boolean;
    status: SubscriptionStatus;
    policy_block_reason: string | null;
    coverage: Coverage;
    gap_status: "NONE" | "GAP_DETECTED";
    quarantined_count: number;
    freshness_target_seconds: number | null;
    last_success_at: string | null;
    last_source_observation_at: string | null;
    last_reconciliation_at: string | null;
    lag_seconds: number | null;
    policy_unavailable: boolean;
  }[];
  cursors: {
    subscription_id: string;
    partition_key: string;
    last_sequence: number | string;
    acked_sequence: number | string;
    head_sequence: number | string | null;
    gap_from: number | string | null;
    gap_to: number | string | null;
    gap_detected_at: string | null;
    last_success_at: string | null;
    leased: boolean;
    sequence_lag: number | null;
    unacked: number;
  }[];
  sync: { status: SyncStatus; failed_acks?: number | null; lease_failures?: number | null; failed_runs?: number | null; last_successful_run?: string | null };
  quarantine: { open: number; total: number } | null;
  alerts_24h: { reason_code: string; n: number; last_at: string }[];
}

/** POST /api/admin/product-integrations (registration request; PIC validates every field). */
export interface IntegrationRequestInput {
  product_id: string;
  display_name: string;
  service_instance_id: string;
  environment: string;
  endpoint_ref: string;
  workload_identity: string;
  approved_signer_kid: string;
  identity_fingerprint_ref?: string | null;
  allowed_scope: ExactScope;
}

/** Lifecycle transitions the gateway forwards (POST /{id}/{transition}). */
export type LifecycleTransition =
  | "verify-identity"
  | "validate-contract"
  | "review-policy"
  | "certify-staging"
  | "approve"
  | "reject"
  | "suspend"
  | "revoke"
  | "resume-review";

/** Body of a lifecycle transition. PIC ignores fields a transition does not use. */
export interface TransitionInput {
  expected_revision: number;
  evidence_ref?: string;
  reason_code?: string;
}

/** POST /{id}/health-check result (registry/health.js). */
export interface HealthCheckResult {
  health_status: HealthStatus;
  drift_status: DriftStatus;
  reason: string | null;
  stale?: boolean;
}

export interface DatasetDecisionInput {
  version: string;
  decision: "APPROVE" | "REJECT";
}

export interface DatasetDecisionResult {
  dataset_row_id: string;
  approval_status: DatasetApprovalStatus;
}

export interface SubscriptionCreateInput {
  dataset_id: string;
  version: string;
  consumer_department: string;
  allowed_scope: ExactScope;
  freshness_target_seconds?: number;
  poll_interval_seconds?: number;
  page_limit?: number;
  enabled?: boolean;
}

export interface SubscriptionToggleResult {
  id: string;
  enabled: boolean;
  status: SubscriptionStatus;
}

export type OperationsSwitchInput =
  | { expected_revision: number; evidence_ref: string }
  | { expected_revision: number; reason_code: string };

export interface OperationsSwitchResult {
  id: string;
  operations_enabled: boolean;
  revision: number;
  changed: boolean;
}

export interface ContractProposalResult {
  contract_id: string;
  revision: number;
  decision: string;
  activation: { allowed?: boolean; reason?: string; [key: string]: unknown } | null;
  changes: unknown[];
}

export interface ContractCertifyResult {
  contract_id: string;
  status: "CERTIFIED";
}

/** Product actions a PRODUCT grant may carry (packages/identity-and-permissions/src/actions.js). */
export type ProductGrantAction =
  | "product.view"
  | "product.manifest.read"
  | "product.capabilities.read"
  | "dataset.list"
  | "metric.read"
  | "events.status.read"
  | "operation.read"
  | "resource.read"
  | "report.read"
  | "operation.submit";

/** POST /api/admin/product-integration-grants (PRODUCT grants only from this screen). */
export interface ProductGrantCreateInput {
  grant_kind: "PRODUCT";
  product_id: string;
  staff_id: string;
  role?: string | null;
  effect: "ALLOW" | "DENY";
  actions: ProductGrantAction[];
  datasets?: string[];
  scope: ExactScope;
  expires_at?: string | null;
  not_before?: string | null;
}

export interface ProductGrantCreateResult {
  grant_id: string;
}

export interface ProductGrantRevokeResult {
  grant_id: string;
  revoked: true;
}
