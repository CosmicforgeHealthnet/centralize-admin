// Typed client for HQ product integration administration (product-neutral):
//   /api/admin/product-integrations/...        registry, onboarding lifecycle,
//                                               datasets, subscriptions,
//                                               operations switch, contracts
//   /api/admin/product-integration-grants/...  create / revoke staff grants
// Grant reads (GET /api/products/{p}/grants[/{id}]) live in products.service.
//
// The gateway (services/central-admin-api product-gateway/routes.js) requires
// a recent MFA step-up for EVERY admin route, reads included, and forwards
// only allowlisted shapes to PIC. PIC authorizes each action against the
// staff member's explicit PLATFORM grants (staff tier is never consulted) and
// answers `{ success: true, data }`, or `{ success: false, error: { code,
// reason, detail? } }` on refusal.
//
// Rules this client keeps:
//  - Path segments are validated locally (same patterns as the gateway) and
//    inserted verbatim; an invalid one fails with INVALID_REQUEST before any
//    request is made.
//  - Every failure is a ProductApiError (so the shared MFA step-up and
//    ProductDataState understand it); refusals additionally keep PIC's
//    `detail` list (e.g. GRANT_INVALID details) as AdminApiError.detail.
//  - A write that got no definite answer (network failure, timeout, 5xx after
//    forwarding) is flagged `outcomeUnknown`: the caller must re-read before
//    trying again. Nothing here resends a write by itself.

import api from "@/lib/api";
import { ProductApiError, toProductApiError, type ProductApiErrorInit, type ProductRequestOptions } from "@/lib/products.service";
import type {
  ContractCertifyResult,
  ContractProposalResult,
  DatasetDecisionInput,
  DatasetDecisionResult,
  ExactScope,
  HealthCheckResult,
  IntegrationDetail,
  IntegrationMonitoring,
  IntegrationRegistration,
  IntegrationRequestInput,
  LifecycleTransition,
  OperationsSwitchInput,
  OperationsSwitchResult,
  ProductGrantCreateInput,
  ProductGrantCreateResult,
  ProductGrantRevokeResult,
  ScopeDimension,
  SubscriptionCreateInput,
  SubscriptionToggleResult,
  TransitionInput,
} from "@/types/product-integrations.types";

export type * from "@/types/product-integrations.types";

const INTEGRATIONS = "/api/admin/product-integrations";
const GRANTS = "/api/admin/product-integration-grants";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// ── Patterns PIC enforces (kept here so forms can explain refusals early) ──

export const PATTERNS = Object.freeze({
  productId: /^[a-z][a-z0-9-]{1,31}$/,
  serviceInstanceId: /^[a-z0-9][a-z0-9.-]{2,63}$/,
  endpointRef: /^[a-z0-9][a-z0-9._-]{0,63}$/,
  workloadIdentity: /^(?:spiffe|cf):\/\/[a-z0-9.-]{1,63}(?:\/[A-Za-z0-9._-]{1,63}){1,6}$/,
  keyId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/,
  fingerprint: /^sha256:[0-9a-f]{64}$/,
  catalogId: /^[a-z][a-z0-9_.-]{1,95}$/,
  semver: /^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/,
  department: /^[a-z][a-z0-9-]{1,47}$/,
  /** Reason codes (reject, suspend, revoke, operations off, grant revoke). */
  reasonCode: /^[A-Z][A-Z0-9_]{2,63}$/,
  /** Evidence references (review, certification, operations on). */
  evidenceRef: /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,255}$/,
  /** One exact scope value. "*" is refused by PIC. */
  scopeValue: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/,
  staffId: /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/,
  role: /^[a-z][a-z0-9_.-]{1,63}$/,
  datasetId: /^[a-z][a-z0-9_.-]{1,95}$/,
});

export const SCOPE_DIMENSIONS: readonly ScopeDimension[] = ["market", "organization", "zone", "tenant"];

/** Values that look like "everything" are never sent as scope (PIC rejects wildcards). */
const WILDCARD_WORDS = new Set(["*", "all", "any", "everything"]);

/**
 * Parses one dimension's exact values from free text (comma, space or newline
 * separated). Returns the values and the first problem, if any.
 */
export function parseScopeValues(text: string): { values: string[]; error: string | null } {
  const values = text.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
  for (const v of values) {
    if (WILDCARD_WORDS.has(v.toLowerCase())) return { values, error: `"${v}" is a wildcard; enter exact values` };
    if (!PATTERNS.scopeValue.test(v)) return { values, error: `"${v}" is not a valid scope value` };
  }
  if (new Set(values).size !== values.length) return { values, error: "A value is listed twice" };
  if (values.length > 64) return { values, error: "At most 64 values per dimension" };
  return { values, error: null };
}

/** True when every value of `inner` is allowed by `outer` (dimensions missing from outer are unconstrained, as in PIC). */
export function scopeWithin(inner: ExactScope, outer: ExactScope): boolean {
  return SCOPE_DIMENSIONS.every((dim) => {
    const values = inner[dim];
    const allowed = outer[dim];
    return !values || !allowed || values.every((v) => allowed.includes(v));
  });
}

// ── Errors ────────────────────────────────────────────────────────

export class AdminApiError extends ProductApiError {
  /** PIC refusal details (e.g. GRANT_INVALID -> ["SCOPE_EMPTY:market"]); empty when none. */
  readonly detail: string[];
  /** A write that may or may not have been applied: re-read before trying again. */
  readonly outcomeUnknown: boolean;

  constructor(init: ProductApiErrorInit & { detail?: string[]; outcomeUnknown?: boolean }) {
    super(init);
    this.name = "AdminApiError";
    this.detail = init.detail ?? [];
    this.outcomeUnknown = init.outcomeUnknown ?? false;
  }
}

type UnknownRecord = Record<string, unknown>;
const asRecord = (v: unknown): UnknownRecord | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as UnknownRecord) : null);

function picDetail(err: unknown): string[] {
  const error = asRecord(asRecord(asRecord(asRecord(err)?.response)?.data)?.error);
  const detail = error?.detail;
  return Array.isArray(detail) ? detail.filter((d): d is string => typeof d === "string" && d.length > 0).slice(0, 10) : [];
}

/** A write's outcome is open when no definite refusal came back. */
function writeOutcomeOpen(e: ProductApiError): boolean {
  if (e.source === "client") return false;
  if (e.source === "network") return true;
  if (e.status !== null && e.status < 500) return false;
  if (e.source === "pic") return false; // PIC answered with a structured refusal
  // Gateway refusals raised before forwarding.
  return !["PRODUCT_INTEGRATION_DISABLED", "PRODUCT_INTEGRATION_NOT_CONFIGURED", "AUTH_SCHEMA_NOT_READY"].includes(e.code);
}

/** Normalizes any failure from an admin route. */
export function toAdminApiError(err: unknown, { write = false }: { write?: boolean } = {}): AdminApiError {
  if (err instanceof AdminApiError) return err;
  const e = toProductApiError(err);
  return new AdminApiError({
    status: e.status,
    code: e.code,
    reason: e.reason,
    retryable: write ? false : e.retryable,
    correlation_id: e.correlation_id,
    operation_id: e.operation_id,
    source: e.source,
    message: e.message,
    envelope: e.envelope,
    kind: e.kind,
    detail: picDetail(err),
    outcomeUnknown: write && writeOutcomeOpen(e),
  });
}

/** Refusal reasons meaning "this staff member lacks the platform permission". */
export const NOT_PERMITTED_REASONS: readonly string[] = ["MISSING_PLATFORM_GRANT", "EXPLICIT_DENY", "GRANT_REVOKED", "GRANT_EXPIRED", "POLICY_INVALID"];

/** True when the error says the user does not hold the permission (not a rule such as two-person review). */
export function isNotPermitted(error: unknown): boolean {
  const e = toProductApiError(error);
  return e.kind === "forbidden" && e.reason !== null && NOT_PERMITTED_REASONS.includes(e.reason);
}

const REASON_TEXT: Record<string, string> = {
  MISSING_PLATFORM_GRANT: "You do not hold the platform permission for this action.",
  EXPLICIT_DENY: "An explicit deny grant blocks this action for you.",
  GRANT_REVOKED: "Your permission for this action was revoked.",
  GRANT_EXPIRED: "Your permission for this action has expired.",
  RECENT_MFA_REQUIRED: "Confirm with your authenticator app, then try again.",
  MFA_STEP_UP_REQUIRED: "Confirm with your authenticator app, then try again.",
  MFA_STEP_UP_CANCELLED: "Confirmation with the authenticator app was cancelled. Nothing was changed.",
  INDEPENDENT_REVIEWER_REQUIRED: "Two-person rule: this step must be done by someone other than the requester (or the contract validator).",
  INDEPENDENT_APPROVER_REQUIRED: "Two-person rule: this step must be done by someone other than the certifier (or the person who requested or activated the product).",
  STALE_REVISION: "The registration changed since you loaded it. Reload and review it again.",
  TRANSITION_NOT_ALLOWED: "This step is not allowed from the current lifecycle status.",
  TERMINAL_STATE: "This registration is closed (rejected or revoked).",
  EXPLICIT_REREVIEW_REQUIRED: "A suspended product returns only through resume-review.",
  EVIDENCE_REF_REQUIRED: "An evidence reference is required.",
  EVIDENCE_REQUIRED: "An evidence reference is required.",
  EVIDENCE_REF_INVALID: "The evidence reference is not valid.",
  REASON_CODE_REQUIRED: "A reason code (e.g. POLICY_VIOLATION) is required.",
  NO_VALIDATED_CONTRACT: "There is no validated contract to certify.",
  NO_APPROVED_DATASET: "At least one dataset must be approved first.",
  CONTRACT_NOT_CERTIFIED: "The contract must be certified first.",
  CONTRACT_NOT_CERTIFIABLE: "Only a validated contract can be certified.",
  CONTRACT_BREAKING: "The new contract is breaking; it was recorded as rejected and cannot be activated.",
  NO_CONTRACT_CHANGE: "The product's manifest has not changed from the active contract.",
  NO_ACTIVE_CONTRACT: "There is no active contract to compare against.",
  CONTRACT_DRIFT_UNRESOLVED: "Unresolved contract drift blocks this until a reviewed contract is activated.",
  DATASET_NOT_IN_CURRENT_CONTRACT: "The contract in force does not declare this dataset version.",
  DATASET_NOT_CERTIFIED_BY_PRODUCT: "The product has not certified this dataset as ready.",
  DATASET_NOT_PROPOSED: "Only a proposed dataset can be decided.",
  DATASET_NOT_APPROVED: "The dataset is not approved for HQ.",
  RESTRICTED_DATASET: "Restricted (personal data) datasets are never synchronized to HQ; it was recorded as rejected.",
  DEPARTMENT_NOT_AUTHORIZED: "The dataset does not authorize this consumer department.",
  ALLOWED_SCOPE_INVALID: "The scope is invalid: exact values only, market and organization required where the dataset uses them.",
  SCOPE_EXCEEDS_PRODUCT: "The scope goes beyond the product's allowed scope.",
  SUBSCRIPTION_EXISTS: "A subscription for this dataset and department already exists.",
  UNKNOWN_SUBSCRIPTION: "The subscription was not found, or it is policy-blocked and cannot be enabled.",
  REGISTRATION_TERMINAL: "The registration is closed; its subscriptions cannot change.",
  PRODUCT_NOT_ENABLED: "Operations can be enabled only for an ENABLED product.",
  MANIFEST_EXPIRED: "The product's signed manifest has expired. Verify identity again.",
  IDENTITY_NOT_VERIFIED: "The product's identity is not verified.",
  PRODUCT_ADMIN_UNREACHABLE: "The Product Admin could not be reached.",
  MANIFEST_UNAVAILABLE: "The Product Admin did not return its manifest.",
  TRUST_STORE_CHANGED: "PIC's trust store changed on disk; PIC must be restarted before verifying.",
  SYNC_DISABLED: "Synchronization is switched off in PIC.",
  ALREADY_REGISTERED: "This product (or service instance) is already registered in this environment.",
  ENVIRONMENT_ISOLATION: "The environment does not match the environment PIC serves.",
  ENDPOINT_NOT_ALLOWLISTED: "The endpoint reference is not in PIC's endpoint allowlist.",
  ENDPOINT_PRODUCT_MISMATCH: "The endpoint reference belongs to another product or environment.",
  SIGNER_NOT_ENROLLED: "The signer key is not enrolled for this product and environment.",
  SIGNER_NOT_CURRENT: "The signer key is not current.",
  INVALID_REGISTRATION: "One or more registration fields are invalid.",
  UNKNOWN_FIELD: "The request contained a field PIC does not accept.",
  GRANT_INVALID: "The grant is invalid.",
  GRANT_EXPIRY_INVALID: "The expiry must be in the future.",
  GRANT_EFFECTIVE_DATE_INVALID: "The start must be a valid date before the expiry.",
  SELF_GRANT_DENIED: "You cannot grant access to yourself.",
  SELF_REVOKE_DENIED: "You cannot revoke a grant that applies to yourself.",
  PRODUCT_NOT_REGISTERED: "The product is not registered (or is rejected/revoked) in this environment.",
  UNKNOWN_GRANT: "The grant was not found or is already revoked.",
  AUDIT_UNAVAILABLE: "The audit log could not be written, so nothing was done.",
  POLICY_UNAVAILABLE: "PIC could not load the permission policy, so access was denied.",
  PRODUCT_INTEGRATION_DISABLED: "Product integration is switched off on this HQ server.",
  PRODUCT_INTEGRATION_NOT_CONFIGURED: "Product integration is not configured on this HQ server.",
};

/** One honest sentence for a refusal or failure; the code itself is shown separately. */
export function describeAdminError(error: unknown): string {
  const e = error instanceof AdminApiError ? error : toAdminApiError(error);
  if (e.outcomeUnknown) return "No definite answer came back, so the change may or may not have been applied. Refresh and check before trying again.";
  const text = (e.reason && REASON_TEXT[e.reason]) || REASON_TEXT[e.code];
  if (text) return text;
  if (e.kind === "forbidden") return "The server refused this action for your account.";
  if (e.kind === "network") return "The server could not be reached.";
  if (e.kind === "unavailable") return "The integration service is unavailable right now.";
  return e.message || "The request was refused.";
}

// ── Request helpers ───────────────────────────────────────────────

function seg(value: string, pattern: RegExp, name: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new AdminApiError({ status: null, code: "INVALID_REQUEST", reason: "PATH_PARAMETER_INVALID", source: "client", message: `Invalid ${name}` });
  }
  return value;
}

const integrationPath = (id: string) => `${INTEGRATIONS}/${seg(id, UUID, "integration id")}`;

async function dataRequest<T>(method: "GET" | "POST", url: string, body: unknown, options: ProductRequestOptions = {}): Promise<T> {
  const write = method === "POST";
  let response;
  try {
    response = await api.request({ method, url, data: write ? (body ?? {}) : undefined, signal: options.signal });
  } catch (err) {
    throw toAdminApiError(err, { write });
  }
  const payload = asRecord(response.data);
  if (!payload || payload.success !== true || !("data" in payload)) {
    throw new AdminApiError({
      status: response.status,
      code: "CONTRACT_MISMATCH",
      reason: "RESPONSE_INVALID",
      source: "client",
      correlation_id: typeof payload?.correlation_id === "string" ? payload.correlation_id : null,
      message: "The integration service returned an unexpected response",
      // A 2xx with a broken body after a write: the change may have happened.
      outcomeUnknown: write,
    });
  }
  return payload.data as T;
}

// ── Registry and monitoring (integration.read) ────────────────────

/** GET / — every registration in PIC's environment. */
export function listIntegrations(options: ProductRequestOptions = {}) {
  return dataRequest<IntegrationRegistration[]>("GET", INTEGRATIONS, null, options).then((rows) => (Array.isArray(rows) ? rows : []));
}

/** GET /{id} — registration, contracts, datasets, subscriptions and the approval history. */
export function getIntegration(id: string, options: ProductRequestOptions = {}) {
  return dataRequest<IntegrationDetail>("GET", integrationPath(id), null, options);
}

/** GET /{id}/monitoring — recorded health, drift, sync, cursors, quarantine and alerts. */
export function getIntegrationMonitoring(id: string, options: ProductRequestOptions = {}) {
  return dataRequest<IntegrationMonitoring>("GET", `${integrationPath(id)}/monitoring`, null, options);
}

// ── Onboarding ────────────────────────────────────────────────────

/** POST / — registers a product as untrusted (DRAFT -> REQUESTED). integration.request. */
export function requestIntegration(input: IntegrationRequestInput) {
  return dataRequest<IntegrationRegistration>("POST", INTEGRATIONS, input);
}

/** POST /{id}/{transition} — one lifecycle step, revision-checked. Returns the updated registration. */
export function transitionIntegration(id: string, transition: LifecycleTransition, input: TransitionInput) {
  return dataRequest<IntegrationRegistration>("POST", `${integrationPath(id)}/${transition}`, input);
}

/** POST /{id}/health-check — re-checks reachability and drift now. integration.verify. */
export function runHealthCheck(id: string) {
  return dataRequest<HealthCheckResult>("POST", `${integrationPath(id)}/health-check`, {});
}

/** POST /{id}/sync — runs one synchronization pass now. integration.subscriptions.manage. */
export function runSyncNow(id: string) {
  return dataRequest<Record<string, unknown>>("POST", `${integrationPath(id)}/sync`, {});
}

/** POST /{id}/datasets/{dataset}/approve — approve or reject one proposed dataset version. integration.review. */
export function decideDataset(id: string, datasetId: string, input: DatasetDecisionInput) {
  return dataRequest<DatasetDecisionResult>("POST", `${integrationPath(id)}/datasets/${seg(datasetId, OPAQUE, "dataset id")}/approve`, input);
}

// ── Subscriptions (integration.subscriptions.manage) ──────────────

export function createSubscription(id: string, input: SubscriptionCreateInput) {
  return dataRequest<{ subscription_id: string }>("POST", `${integrationPath(id)}/subscriptions`, input);
}

export function setSubscriptionEnabled(id: string, subscriptionId: string, enabled: boolean) {
  return dataRequest<SubscriptionToggleResult>("POST", `${integrationPath(id)}/subscriptions/${seg(subscriptionId, UUID, "subscription id")}/${enabled ? "enable" : "disable"}`, {});
}

// ── Operations switch ─────────────────────────────────────────────

/** POST /{id}/operations/enable (integration.approve, evidence) or /disable (integration.suspend, reason code). */
export function setOperationsEnabled(id: string, enabled: boolean, input: OperationsSwitchInput) {
  return dataRequest<OperationsSwitchResult>("POST", `${integrationPath(id)}/operations/${enabled ? "enable" : "disable"}`, input);
}

// ── Contracts ─────────────────────────────────────────────────────

/** POST /{id}/contracts/propose — records the product's current manifest as a candidate revision. integration.verify. */
export function proposeContract(id: string) {
  return dataRequest<ContractProposalResult>("POST", `${integrationPath(id)}/contracts/propose`, {});
}

/** POST /{id}/contracts/{cid}/certify — integration.certify, by someone other than the validator. */
export function certifyContract(id: string, contractId: string, input: { evidence_ref: string }) {
  return dataRequest<ContractCertifyResult>("POST", `${integrationPath(id)}/contracts/${seg(contractId, UUID, "contract id")}/certify`, input);
}

/** POST /{id}/contracts/{cid}/activate — integration.approve, by someone other than the certifier. */
export function activateContract(id: string, contractId: string, input: { expected_revision: number }) {
  return dataRequest<IntegrationRegistration>("POST", `${integrationPath(id)}/contracts/${seg(contractId, UUID, "contract id")}/activate`, input);
}

// ── Staff product grants (integration.grants.manage) ──────────────

export function createProductGrant(input: ProductGrantCreateInput) {
  return dataRequest<ProductGrantCreateResult>("POST", GRANTS, input);
}

export function revokeProductGrant(grantId: string, input: { reason_code: string }) {
  return dataRequest<ProductGrantRevokeResult>("POST", `${GRANTS}/${seg(grantId, UUID, "grant id")}/revoke`, input);
}
