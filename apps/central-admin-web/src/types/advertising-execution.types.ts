import type { MIPlatform } from "@/types/marketing-intelligence.types";

// ─── Envelope ────────────────────────────────────────────────────────────────

export interface AEApiEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
  meta?: Record<string, unknown>;
}

// Advertising Execution uses the same 5 providers as Marketing Intelligence.
export type AEProvider = MIPlatform; // "meta" | "tiktok" | "x" | "linkedin" | "google_ads"

// ─── Safety / readiness state (Section 2, 5.3) ─────────────────────────────────

export interface AEExecutionSafetyState {
  masterEnabled: boolean;
  dryRunEnabled: boolean;
  workerEnabled: boolean;
  providerWritesEnabled: Partial<Record<AEProvider, boolean>>;
  connectionWritesEnabled: Record<string, boolean>;
}

export type AELiveValidationStatus = "NOT_LIVE_VALIDATED" | "LIVE_VALIDATED";

// ─── Roles (Section 3) ──────────────────────────────────────────────────────────

export type AERole =
  | "VIEWER"
  | "AUTHOR"
  | "APPROVER"
  | "EXECUTION_ADMINISTRATOR"
  | "EMERGENCY_OPERATOR"
  | "AUDITOR";

// ─── Plan lifecycle (Section 6) ────────────────────────────────────────────────

export type AEPlanStatus =
  | "DRAFT"
  | "VALIDATING"
  | "VALIDATED"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "QUEUED"
  | "EXECUTING"
  | "PARTIAL_SUCCESS"
  | "SUCCEEDED"
  | "FAILED"
  | "ROLLBACK_PENDING"
  | "ROLLED_BACK"
  | "ROLLBACK_FAILED"
  | "CANCELLED"
  | "EXPIRED";

export type AEOperationCertainty = "KNOWN_SUCCESS" | "KNOWN_FAILURE" | "UNKNOWN";

export type AEOperationStatus =
  | "PENDING"
  | "VALIDATED"
  | "READY"
  | "EXECUTING"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "VERIFYING"
  | "VERIFIED"
  | "DRIFTED"
  | "RETRY_SCHEDULED";

export type AECreativeReviewStatus = "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "LIMITED" | "UNKNOWN";

export type AEReconciliationStatus = "VERIFIED" | "DRIFTED" | "UNKNOWN" | "EXTERNAL_CHANGE" | "COMPENSATED";

export type AEJobStatus =
  | "PENDING"
  | "CLAIMED"
  | "RUNNING"
  | "RETRY_SCHEDULED"
  | "RECONCILING"
  | "SUCCEEDED"
  | "FAILED"
  | "DEAD_LETTER"
  | "CANCELLED";

export type AESource = "MANUAL" | "RECOMMENDATION" | "COMPENSATION";

export type AEOperationType = "CREATE" | "UPDATE" | "PAUSE" | "RESUME" | "ARCHIVE" | "REMOVE_LINK";

export type AEResourceType = "BUDGET" | "CAMPAIGN" | "GROUP" | "TARGETING" | "CREATIVE" | "AD" | "ASSET_LINK";

export type AEBudgetType = "DAILY" | "LIFETIME" | "TOTAL";

// ─── Error / stable codes (Section 10) ─────────────────────────────────────────

export type AEErrorCode =
  | "AD_EXECUTION_DISABLED"
  | "EXECUTION_PLAN_CONFLICT"
  | "EXECUTION_VALIDATION_FAILED"
  | "EXECUTION_APPROVAL_REQUIRED"
  | "EXECUTION_SELF_APPROVAL_FORBIDDEN"
  | "EXECUTION_BUDGET_POLICY_VIOLATION"
  | "EXECUTION_CAPABILITY_UNAVAILABLE"
  | "EXECUTION_PRECONDITION_CHANGED"
  | "EXECUTION_PROVIDER_RATE_LIMITED"
  | "EXECUTION_PROVIDER_PERMISSION_ERROR"
  | "EXECUTION_OUTCOME_UNKNOWN"
  | "EXECUTION_RECONCILIATION_DRIFT";

// ─── Provider capability / readiness (Section 8, 7.2) ──────────────────────────

export interface AECapabilityBlocker {
  code: string;
  message: string;
}

export interface AEProviderCapability {
  provider: AEProvider;
  apiVersion: string | null;
  connectionId: string | null;
  connectionLabel: string | null;
  connectionStatus: "CONNECTED" | "DISCONNECTED" | "DEGRADED" | "NOT_CONFIGURED";
  accountId: string | null;
  accountLabel: string | null;
  accountCurrency: string | null;
  accountTimezone: string | null;
  credentialPresent: boolean;
  liveValidationStatus: AELiveValidationStatus;
  supportedOperations: AEOperationType[];
  supportedResourceTypes: AEResourceType[];
  supportedFormats: string[];
  blockers: AECapabilityBlocker[];
  staleCapability: boolean;
}

// ─── Overview (Section 7.1) ─────────────────────────────────────────────────────

export interface AEQueueSummary {
  queuedCount: number;
  executingCount: number;
  oldestQueuedAgeMinutes: number | null;
}

export interface AEIncidentSummary {
  unresolvedCount: number;
  unknownCount: number;
  driftedCount: number;
  externalChangeCount: number;
}

export interface AEApprovalQueueSummary {
  pendingCount: number;
  expiringSoonCount: number;
  eligibleForCurrentUser: number;
}

export interface AEOverviewResponse {
  safety: AEExecutionSafetyState;
  providerReadiness: Array<{ provider: AEProvider; liveValidationStatus: AELiveValidationStatus; blockerCount: number }>;
  plansByStatus: Partial<Record<AEPlanStatus, number>>;
  approvalQueue: AEApprovalQueueSummary;
  queue: AEQueueSummary;
  incidents: AEIncidentSummary;
  recentPlans: AEPlanListItem[];
  recentActivity: AEActivityEvent[];
}

// ─── Activity / audit (Section 9.3, Appendix D) ────────────────────────────────

export type AEActivityEventType =
  | "EXECUTION_PLAN_CREATED"
  | "EXECUTION_PLAN_UPDATED"
  | "EXECUTION_PLAN_VALIDATED"
  | "EXECUTION_PLAN_SUBMITTED"
  | "EXECUTION_APPROVED"
  | "EXECUTION_REJECTED"
  | "EXECUTION_REVOKED"
  | "EXECUTION_QUEUED"
  | "EXECUTION_STARTED"
  | "EXECUTION_COMPLETED"
  | "PROVIDER_OPERATION_ATTEMPTED"
  | "EXECUTION_DRIFT_DETECTED"
  | "EXECUTION_COMPENSATION_CREATED"
  | "EXECUTION_OVERRIDE_USED";

export interface AEActivityEvent {
  id: string;
  type: AEActivityEventType;
  actorLabel: string; // human actor or "System Worker"
  at: string;
  planId: string | null;
  runId: string | null;
  fingerprint: string | null;
  category: string | null;
  correlationId: string | null;
}

// ─── Plans (Section 7.3-7.11, 16.1) ─────────────────────────────────────────────

export interface AEPlanListItem {
  id: string;
  name: string;
  provider: AEProvider;
  connectionId: string;
  accountLabel: string | null;
  currency: string;
  source: AESource;
  status: AEPlanStatus;
  version: number;
  fingerprint: string | null;
  validationCurrent: boolean;
  approvalProgress: { approved: number; required: number } | null;
  itemCount: number;
  runStatus: AEJobStatus | null;
  compensationForPlanId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AEPlanFilters {
  provider: AEProvider | "all";
  connectionId: string | "all";
  status: AEPlanStatus | "all";
  source: AESource | "all";
  search: string;
  from: string;
  to: string;
}

export interface AEPlanItem {
  id: string;
  clientReference: string;
  operationType: AEOperationType;
  resourceType: AEResourceType;
  existingProviderResourceId: string | null;
  dependsOnClientReferences: string[];
  intent: Record<string, unknown>;
  beforeState: Record<string, unknown> | null;
  materialHash: string | null;
}

export interface AEBudgetExposure {
  currency: string;
  currentValue: string | null;
  proposedValue: string;
  budgetType: AEBudgetType;
  deltaAbsolute: string | null;
  deltaPct: string | null;
  policyCap: string | null;
  sharedBudgetImpact: string[];
  approvalRequired: boolean;
}

export interface AEPlanDetail extends AEPlanListItem {
  description: string | null;
  items: AEPlanItem[];
  budgetExposure: AEBudgetExposure[];
  sourceRecommendationId: string | null;
  compensationOriginalPlanId: string | null;
  activity: AEActivityEvent[];
}

export interface AEPlanContextPayload {
  provider: AEProvider;
  connectionId: string;
  accountId: string;
  name: string;
  description?: string;
  source: AESource;
  sourceRecommendationId?: string;
}

// ─── Validation (Section 7.10) ─────────────────────────────────────────────────

export type AEValidationIssueSeverity = "ERROR" | "WARNING";

export interface AEValidationIssue {
  severity: AEValidationIssueSeverity;
  code: string;
  message: string;
  fieldPath: string | null;
}

export interface AEValidationResult {
  planId: string;
  version: number;
  fingerprint: string;
  status: "SUCCEEDED" | "FAILED";
  issues: AEValidationIssue[];
  beforeStateHash: string | null;
  providerApiVersion: string | null;
  validatedAt: string;
  expiresAt: string | null;
}

// ─── Approvals (Section 7.11-7.13, 16.3) ───────────────────────────────────────

export type AEApprovalDecision = "APPROVED" | "REJECTED" | "REVOKED";

export interface AEApprovalRecord {
  id: string;
  actorLabel: string;
  decision: AEApprovalDecision;
  reason: string | null;
  decidedAt: string;
}

export interface AEApprovalPacket {
  planId: string;
  version: number;
  fingerprint: string;
  authorLabel: string;
  source: AESource;
  beforeState: Record<string, unknown>;
  desiredState: Record<string, unknown>;
  hierarchy: AEPlanItem[];
  budgetExposure: AEBudgetExposure[];
  activationExposure: string[];
  validationWarnings: AEValidationIssue[];
  requiredApprovals: number;
  approvals: AEApprovalRecord[];
  expiresAt: string | null;
  currentUserEligible: boolean;
  currentUserIneligibleReason: string | null;
}

export interface AEApprovalQueueItem {
  planId: string;
  planName: string;
  provider: AEProvider;
  accountLabel: string | null;
  authorLabel: string;
  version: number;
  fingerprint: string;
  validationExpiresAt: string | null;
  approvalProgress: { approved: number; required: number };
  spendExposure: string | null;
  activationExposure: boolean;
  warningCount: number;
  currentUserEligible: boolean;
}

// ─── Execution runs / jobs / operations (Section 7.16-7.19) ────────────────────

export interface AERunListItem {
  id: string;
  planId: string;
  planName: string;
  planVersion: number;
  fingerprint: string;
  provider: AEProvider;
  accountLabel: string | null;
  jobStatus: AEJobStatus;
  operationCounts: { total: number; succeeded: number; failed: number; unknown: number; drifted: number };
  startedAt: string | null;
  completedAt: string | null;
  compensationForRunId: string | null;
}

export interface AERunFilters {
  provider: AEProvider | "all";
  jobStatus: AEJobStatus | "all";
  onlyIncidents: boolean;
  onlyReconciliationPending: boolean;
  from: string;
  to: string;
}

export interface AEAttempt {
  id: string;
  attemptNumber: number;
  outcome: AEOperationCertainty | "PENDING";
  providerRequestId: string | null;
  errorCategory: string | null;
  retryable: boolean | null;
  attemptedAt: string;
}

export interface AEOperationListItem {
  id: string;
  runId: string;
  clientReference: string;
  resourceType: AEResourceType;
  operationType: AEOperationType;
  status: AEOperationStatus;
  certainty: AEOperationCertainty | null;
  nativeSafeId: string | null;
  nativeSafeName: string | null;
  dependsOnOperationIds: string[];
}

export interface AEOperationDetail extends AEOperationListItem {
  beforeState: Record<string, unknown> | null;
  desiredState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  attempts: AEAttempt[];
  reconciliationStatus: AEReconciliationStatus | null;
  retryEligible: boolean;
  retryIneligibleReason: string | null;
}

export interface AERunDetail extends AERunListItem {
  approvalSummary: { approved: number; required: number };
  timeline: AEActivityEvent[];
  operations: AEOperationListItem[];
  reconciliationStatus: AEReconciliationStatus | null;
  compensationPlanId: string | null;
}

export interface AERetryReviewPayload {
  operationId: string;
  reason: string;
}

// ─── Drift / incidents (Section 7.20-7.22) ─────────────────────────────────────

export type AEIncidentClassification = "DRIFTED" | "UNKNOWN" | "EXTERNAL_CHANGE";

export type AEIncidentSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface AEIncidentListItem {
  id: string;
  classification: AEIncidentClassification;
  severity: AEIncidentSeverity;
  provider: AEProvider;
  accountLabel: string | null;
  planId: string;
  runId: string;
  operationId: string;
  ageMinutes: number;
  acknowledged: boolean;
  compensationPlanId: string | null;
  summary: string;
}

export interface AEIncidentFilters {
  classification: AEIncidentClassification | "all";
  severity: AEIncidentSeverity | "all";
  provider: AEProvider | "all";
  onlyUnresolved: boolean;
  from: string;
  to: string;
}

export interface AEIncidentDetail extends AEIncidentListItem {
  expectedState: Record<string, unknown>;
  actualState: Record<string, unknown>;
  expectedHash: string | null;
  actualHash: string | null;
  readBackAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  acknowledgmentReason: string | null;
  escalated: boolean;
}

export interface AECompensationDraftPayload {
  originalPlanId: string;
  originalRunId: string;
  originalOperationId: string;
  incidentId: string;
  reason: string;
  proposedItems: AEPlanItem[];
}

// ─── Creatives (Section 7.23-7.24) ─────────────────────────────────────────────

export interface AECreativePublicationListItem {
  id: string;
  sourceAssetId: string;
  sourceAssetName: string;
  provider: AEProvider;
  accountLabel: string | null;
  revision: number;
  format: string;
  destinationDomain: string | null;
  reviewStatus: AECreativeReviewStatus;
  reuseClassification: "NEW" | "REUSED" | "REPLACED";
  createdAt: string;
}

export interface AECreativePublicationDetail extends AECreativePublicationListItem {
  copy: { headline: string | null; body: string | null; cta: string | null };
  destinationUrl: string | null;
  utm: Record<string, string> | null;
  identityLabel: string | null;
  accessibilityText: string | null;
  mediaMetadata: Record<string, unknown> | null;
  contentHash: string;
  reviewHistory: Array<{ status: AECreativeReviewStatus; at: string; note: string | null }>;
}

// ─── Recommendation conversion (Section 7.25) ──────────────────────────────────

export interface AERecommendationConversionContext {
  recommendationId: string;
  recommendationType: string;
  evidenceSummary: string;
  confidence: number;
  suggestedProvider: AEProvider;
  suggestedAccountId: string | null;
  existingDraftPlanId: string | null;
}

// ─── Policies (Section 7.26) ────────────────────────────────────────────────────

export type AEPolicyScope = "GLOBAL" | "PROVIDER" | "CONNECTION" | "ACCOUNT";

export interface AEPolicyRow {
  key: string;
  scope: AEPolicyScope;
  provider: AEProvider | null;
  connectionId: string | null;
  currency: string | null;
  configuredValue: string | number | boolean | null;
  effectiveValue: string | number | boolean | null;
  effectiveSourceScope: AEPolicyScope;
  version: number;
}

export interface AEPolicyUpdatePayload {
  key: string;
  scope: AEPolicyScope;
  provider?: AEProvider;
  connectionId?: string;
  currency?: string;
  value: string | number | boolean | null;
  reason: string;
  expectedVersion: number;
}

export interface AEKillSwitch {
  scope: "MASTER" | "PROVIDER" | "CONNECTION";
  provider: AEProvider | null;
  connectionId: string | null;
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

// ─── Emergency override (Section 7.27) ─────────────────────────────────────────

export interface AEOverrideRequestPayload {
  scope: "PLAN" | "RUN" | "OPERATION" | "PROVIDER" | "CONNECTION";
  scopeId: string;
  controlsRequested: string[];
  justification: string;
  expiresAt: string;
  mfaEvidence: string;
}

export interface AEOverrideRecord {
  id: string;
  scope: string;
  scopeId: string;
  actorLabel: string;
  controlsBypassed: string[];
  nonOverridableControls: string[];
  justification: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

// ─── Health (Section 7.28) ──────────────────────────────────────────────────────

export type AEHealthState = "READY" | "DEGRADED" | "DISABLED" | "UNAVAILABLE";

export interface AEHealthResponse {
  overallState: AEHealthState;
  schemaOk: boolean;
  safety: AEExecutionSafetyState;
  workerStatus: "RUNNING" | "STOPPED" | "DEGRADED";
  queueAgeMinutes: number | null;
  providerReadiness: Array<{ provider: AEProvider; state: AEHealthState; reason: string | null }>;
  recentFailureCategories: string[];
}