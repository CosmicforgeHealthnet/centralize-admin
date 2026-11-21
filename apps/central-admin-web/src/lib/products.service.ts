// Typed client for the HQ product gateway (services/central-admin-api
// product-gateway/routes.js), mounted at /api/products. Product-neutral:
// every Product Admin (CF Meet, Karryam, HealthNet, ...) is read the same way.
//
// Rules this client keeps:
//  - Path segments are validated against the gateway patterns and inserted
//    verbatim (the gateway matches the raw path, so they are never
//    percent-encoded). An invalid segment fails locally with INVALID_REQUEST.
//  - A contact-like search term (an "@" or 7+ digits) never goes in a URL:
//    listResources() switches to POST .../search for it automatically.
//  - Every failure becomes a ProductApiError keeping code, reason, retryable
//    and correlation_id, whichever of the three error shapes produced it
//    (protocol envelope, PIC error, HQ gateway error).
//  - submitOperation() never resends. A response that leaves the outcome open
//    becomes kind "unknown_outcome" carrying the operation_id to read back.

import axios, { type AxiosRequestConfig } from "axios";
import api from "@/lib/api";
import type {
  CommandScope,
  DataQuality,
  EventsStatus,
  GrantListQuery,
  MetricQuery,
  MetricResult,
  OperationAudit,
  OperationCommand,
  OperationView,
  ProductCapabilities,
  ProductDatasets,
  ProductEnvelope,
  ProductEnvelopeOk,
  ProductGrant,
  ProductGrantList,
  ProductList,
  ProductManifest,
  ProductSummary,
  ReportQuery,
  ResourceDetailQuery,
  ResourceListQuery,
  ResourceRead,
} from "@/types/products.types";

export type * from "@/types/products.types";

const BASE = "/api/products";
const PRODUCT_ID = /^[a-z][a-z0-9-]{1,31}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

/** Reasons/codes meaning "confirm with your authenticator, then retry". */
export const MFA_REQUIRED_CODES = Object.freeze(["RECENT_MFA_REQUIRED", "MFA_STEP_UP_REQUIRED"] as const);

/** Gateway codes raised before anything is forwarded (a definite refusal, never an unknown outcome). */
const PRE_FORWARD_GATEWAY_CODES = new Set([
  "PRODUCT_INTEGRATION_DISABLED",
  "PRODUCT_INTEGRATION_NOT_CONFIGURED",
  "MFA_STEP_UP_REQUIRED",
  "SESSION_REQUIRED",
  "INVALID_QUERY",
  "NOT_FOUND",
]);

// ── Errors ────────────────────────────────────────────────────────

/**
 * UI-level classification of a product error.
 *  - mfa_required: confirm with the authenticator (MfaStepUp), then retry once.
 *  - blocked: the capability or product is switched off / blocked by policy (show the reason).
 *  - forbidden: no grant or scope for this.
 *  - unavailable: the source or the integration cannot answer right now (never shown as zero).
 *  - unknown_outcome: a command may or may not have run; read the operation back, never resend.
 */
export type ProductErrorKind =
  | "mfa_required"
  | "unauthenticated"
  | "forbidden"
  | "blocked"
  | "not_found"
  | "invalid"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "unknown_outcome"
  | "internal"
  | "network"
  | "cancelled";

/** Which layer produced the error. */
export type ProductErrorSource = "envelope" | "pic" | "gateway" | "network" | "client";

export interface ProductApiErrorInit {
  status: number | null;
  code: string;
  reason?: string | null;
  retryable?: boolean;
  correlation_id?: string | null;
  operation_id?: string | null;
  source: ProductErrorSource;
  message?: string;
  envelope?: ProductEnvelope<unknown> | null;
  kind?: ProductErrorKind;
}

export class ProductApiError extends Error {
  name = "ProductApiError";
  /** HTTP status, or null when no response arrived. */
  readonly status: number | null;
  /** Protocol code (FORBIDDEN, UNAVAILABLE, ...) or gateway code (MFA_STEP_UP_REQUIRED, INVALID_QUERY, ...). */
  readonly code: string;
  /** Most specific reason (e.g. RECENT_MFA_REQUIRED, CAPABILITY_DISABLED); gateway errors repeat their code here. */
  readonly reason: string | null;
  readonly retryable: boolean;
  readonly correlation_id: string | null;
  /** Operation to read back (set on unknown outcomes and on errors that name an operation). */
  readonly operation_id: string | null;
  readonly source: ProductErrorSource;
  readonly kind: ProductErrorKind;
  /** The error envelope, when the Product Admin answered with one (keeps as_of/freshness/coverage). */
  readonly envelope: ProductEnvelope<unknown> | null;

  constructor(init: ProductApiErrorInit) {
    super(init.message || `${init.code}${init.reason && init.reason !== init.code ? `: ${init.reason}` : ""}`);
    this.status = init.status;
    this.code = init.code;
    this.reason = init.reason ?? null;
    this.retryable = init.retryable ?? false;
    this.correlation_id = init.correlation_id ?? null;
    this.operation_id = init.operation_id ?? null;
    this.source = init.source;
    this.envelope = init.envelope ?? null;
    this.kind = init.kind ?? classify(init.status, init.code, this.reason, init.source);
  }
}

function classify(status: number | null, code: string, reason: string | null, source: ProductErrorSource): ProductErrorKind {
  if (source === "network") return code === "CANCELLED" ? "cancelled" : "network";
  if ((MFA_REQUIRED_CODES as readonly string[]).includes(code) || (reason !== null && (MFA_REQUIRED_CODES as readonly string[]).includes(reason))) return "mfa_required";
  switch (code) {
    case "UNAUTHENTICATED": return "unauthenticated";
    case "DISABLED":
    case "BLOCKED_POLICY": return "blocked";
    case "FORBIDDEN":
    case "SESSION_REQUIRED": return "forbidden";
    case "NOT_FOUND": return "not_found";
    case "INVALID_REQUEST":
    case "INVALID_QUERY":
    case "SENSITIVE_SEARCH_REQUIRES_POST":
    case "VALIDATION_ERROR":
    case "PAYLOAD_TOO_LARGE":
    case "METHOD_NOT_ALLOWED": return "invalid";
    case "CONFLICT": return "conflict";
    case "RATE_LIMITED": return "rate_limited";
    case "UNAVAILABLE":
    case "CONTRACT_MISMATCH":
    case "DEPENDENCY_UNAVAILABLE": return "unavailable";
    case "INTERNAL": return "internal";
  }
  if (code.startsWith("PRODUCT_INTEGRATION_")) return "unavailable";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status !== null && status >= 400 && status < 500) return "invalid";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  return "internal";
}

type UnknownRecord = Record<string, unknown>;
const asRecord = (v: unknown): UnknownRecord | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as UnknownRecord) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function isEnvelope(value: unknown): value is ProductEnvelope<unknown> {
  const r = asRecord(value);
  return !!r && typeof r.contract_version === "string" && typeof r.product_id === "string" && "result" in r && "error" in r;
}

function fromEnvelope(envelope: ProductEnvelope<unknown>, status: number | null): ProductApiError {
  const error = envelope.error;
  return new ProductApiError({
    status,
    code: error?.code ?? "CONTRACT_MISMATCH",
    reason: error?.reason ?? "RESULT_MISSING",
    retryable: error?.retryable ?? false,
    correlation_id: envelope.correlation_id,
    operation_id: error?.operation_id ?? null,
    source: "envelope",
    envelope,
  });
}

/** True when the value is any error this module can describe. */
export function isProductApiError(error: unknown): error is ProductApiError {
  return error instanceof ProductApiError;
}

/**
 * Normalizes anything thrown by axios (or this module) into a ProductApiError.
 * Understands the protocol envelope, the PIC `{ error: { code, reason } }` body
 * and the HQ `{ code, retryable, message, correlationId }` body.
 */
export function toProductApiError(error: unknown): ProductApiError {
  if (error instanceof ProductApiError) return error;
  if (axios.isCancel(error)) return new ProductApiError({ status: null, code: "CANCELLED", source: "network", message: "Request cancelled" });
  const root = asRecord(error);
  const response = asRecord(root?.response);
  if (!response) {
    // No answer at all: the request may or may not have reached the server.
    return new ProductApiError({ status: null, code: "NETWORK_ERROR", retryable: true, source: "network", message: "The product service could not be reached" });
  }
  const status = typeof response.status === "number" ? response.status : null;
  const data = response.data;
  if (isEnvelope(data)) return fromEnvelope(data, status);
  const body = asRecord(data);
  const picError = asRecord(body?.error);
  if (picError && typeof picError.code === "string") {
    return new ProductApiError({
      status,
      code: picError.code,
      reason: str(picError.reason),
      retryable: typeof picError.retryable === "boolean" ? picError.retryable : false,
      correlation_id: str(body?.correlation_id),
      source: "pic",
    });
  }
  const code = str(body?.code);
  return new ProductApiError({
    status,
    code: code ?? (status === 502 || status === 503 || status === 504 ? "UNAVAILABLE" : status !== null && status >= 500 ? "INTERNAL" : "HTTP_" + (status ?? "ERROR")),
    reason: code,
    retryable: typeof body?.retryable === "boolean" ? body.retryable : status === 502 || status === 503 || status === 504,
    correlation_id: str(body?.correlationId) ?? str(body?.correlation_id),
    source: "gateway",
    message: str(body?.message) ?? undefined,
  });
}

/** True for RECENT_MFA_REQUIRED (PIC / Product Admin) and MFA_STEP_UP_REQUIRED (HQ gateway). */
export function isMfaStepUpRequired(error: unknown): boolean {
  if (!error) return false;
  return toProductApiError(error).kind === "mfa_required";
}

/**
 * React Query `retry` predicate for product reads: never on 4xx, MFA, scope
 * or policy refusals; at most 2 retries for network failures and retryable 5xx.
 */
export function shouldRetryProductQuery(failureCount: number, error: unknown): boolean {
  const e = toProductApiError(error);
  if (failureCount >= 2) return false;
  if (e.status !== null && e.status >= 400 && e.status < 500) return false;
  if (e.kind === "network") return true;
  return e.retryable && e.status !== null && e.status >= 500;
}

const FRIENDLY: Partial<Record<ProductErrorKind, string>> = {
  mfa_required: "Confirm with your authenticator app to continue.",
  unauthenticated: "Your session has expired. Please sign in again.",
  forbidden: "You do not have a grant for this product data or scope.",
  blocked: "This is switched off or blocked by policy for this product.",
  not_found: "This record was not found.",
  invalid: "The request was refused as invalid.",
  conflict: "This changed since you loaded it. Reload and try again.",
  rate_limited: "Too many requests. Try again shortly.",
  unavailable: "This product data is unavailable right now. Other Admin functions keep working.",
  unknown_outcome: "The outcome is not known yet. It will be settled by reading the operation back; the command is never resent.",
  internal: "The product service could not process this request.",
  network: "The product service could not be reached.",
  cancelled: "The request was cancelled.",
};

/** One-line, user-facing description. Codes/reasons are shown separately (see ProductDataState). */
export function describeProductError(error: unknown): string {
  const e = toProductApiError(error);
  return FRIENDLY[e.kind] ?? "Product data could not be loaded.";
}

// ── Request helpers ───────────────────────────────────────────────

/** Request options accepted by every function (React Query passes its `signal`). */
export interface ProductRequestOptions {
  signal?: AbortSignal;
}

function clientError(reason: string, message: string): ProductApiError {
  return new ProductApiError({ status: null, code: "INVALID_REQUEST", reason, source: "client", message });
}

function seg(value: string, pattern: RegExp, name: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw clientError("PATH_PARAMETER_INVALID", `Invalid ${name}`);
  return value;
}

const productPath = (productId: string) => `${BASE}/${seg(productId, PRODUCT_ID, "product id")}`;

/** Drops undefined/null/empty values; never sends a key twice. */
function cleanQuery(query: object | undefined): Record<string, string | number> | undefined {
  if (!query) return undefined;
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" && typeof value !== "number") throw clientError("INVALID_PARAMETER", `Invalid query parameter ${key}`);
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Same rule as the gateway's isContactLike: an "@" or 7+ digits once separators are removed. */
export function isContactLike(q: string): boolean {
  return q.includes("@") || q.replace(/[\s._:-]/g, "").replace(/[^0-9]/g, "").length >= 7;
}

function assertEnvelope<T>(data: unknown, status: number | null): ProductEnvelopeOk<T> {
  if (!isEnvelope(data)) {
    throw new ProductApiError({ status, code: "CONTRACT_MISMATCH", reason: "ENVELOPE_INVALID", source: "client", message: "The product service returned an unexpected response" });
  }
  if (data.error || data.result === null || data.result === undefined) throw fromEnvelope(data, status);
  return data as ProductEnvelopeOk<T>;
}

async function envelopeRequest<T>(config: AxiosRequestConfig): Promise<ProductEnvelopeOk<T>> {
  let response;
  try {
    response = await api.request(config);
  } catch (err) {
    throw toProductApiError(err);
  }
  return assertEnvelope<T>(response.data, response.status);
}

/** PIC `{ success: true, data }` routes (navigation list, grant views). */
async function dataRequest<T>(config: AxiosRequestConfig): Promise<T> {
  let response;
  try {
    response = await api.request(config);
  } catch (err) {
    throw toProductApiError(err);
  }
  const body = asRecord(response.data);
  if (!body || body.success !== true || !asRecord(body.data)) {
    throw new ProductApiError({ status: response.status, code: "CONTRACT_MISMATCH", reason: "RESPONSE_INVALID", source: "client", correlation_id: str(body?.correlation_id), message: "The product service returned an unexpected response" });
  }
  return body.data as T;
}

/** The as-of / freshness / coverage triple of an envelope (for FreshnessBadge). */
export function qualityOf(envelope: Pick<ProductEnvelope<unknown>, "as_of" | "freshness" | "coverage">): DataQuality {
  return { as_of: envelope.as_of, freshness: envelope.freshness, coverage: envelope.coverage };
}

// ── Navigation and catalog ────────────────────────────────────────

/** GET /api/products — products this staff member holds a grant for, with availability reasons. */
export async function listProducts(options: ProductRequestOptions = {}): Promise<ProductSummary[]> {
  const data = await dataRequest<ProductList>({ method: "GET", url: BASE, signal: options.signal });
  return Array.isArray(data.products) ? data.products : [];
}

/** GET /{p}/manifest — the approved contract (diagnostic; readable even when sync is gated). */
export function getProductManifest(productId: string, options: ProductRequestOptions = {}) {
  return envelopeRequest<ProductManifest>({ method: "GET", url: `${productPath(productId)}/manifest`, signal: options.signal });
}

/** GET /{p}/capabilities — live capability states from the Product Admin. */
export function getProductCapabilities<T extends ProductCapabilities = ProductCapabilities>(productId: string, options: ProductRequestOptions = {}) {
  return envelopeRequest<T>({ method: "GET", url: `${productPath(productId)}/capabilities`, signal: options.signal });
}

/** GET /{p}/datasets — approved datasets visible to this staff member, with sync coverage. */
export function getProductDatasets(productId: string, options: ProductRequestOptions = {}) {
  return envelopeRequest<ProductDatasets>({ method: "GET", url: `${productPath(productId)}/datasets`, signal: options.signal });
}

/** GET /{p}/metrics/{metric} — exact-scope observations; no observation is UNAVAILABLE (503), never zero. */
export function getMetricObservations(productId: string, metricId: string, query: MetricQuery = {}, options: ProductRequestOptions = {}) {
  return envelopeRequest<MetricResult>({
    method: "GET",
    url: `${productPath(productId)}/metrics/${seg(metricId, OPAQUE, "metric id")}`,
    params: cleanQuery(query),
    signal: options.signal,
  });
}

/** GET /{p}/events/status — synchronization state (registry, drift, subscriptions, cursors). */
export function getEventsStatus(productId: string, options: ProductRequestOptions = {}) {
  return envelopeRequest<EventsStatus>({ method: "GET", url: `${productPath(productId)}/events/status`, signal: options.signal });
}

// ── Resources and reports ─────────────────────────────────────────

const resourcePath = (productId: string, capabilityId: string, collectionId: string) =>
  `${productPath(productId)}/resources/${seg(capabilityId, OPAQUE, "capability id")}/${seg(collectionId, OPAQUE, "collection id")}`;

/**
 * POST /{p}/resources/{capability}/{collection}/search — the query travels in
 * the JSON body (never in a URL). Use for any search; required for
 * contact-like terms. `q` is required by the gateway.
 */
export function searchResources<TData = unknown>(
  productId: string,
  capabilityId: string,
  collectionId: string,
  query: ResourceListQuery & { q: string },
  options: ProductRequestOptions = {},
) {
  if (!query.q) throw clientError("INVALID_PARAMETER", "A search term is required");
  return envelopeRequest<ResourceRead<TData>>({
    method: "POST",
    url: `${resourcePath(productId, capabilityId, collectionId)}/search`,
    data: cleanQuery(query),
    signal: options.signal,
  });
}

/**
 * GET /{p}/resources/{capability}/{collection} — one page of a scoped list.
 * Pass the previous page's `result.continuation` as `query.continuation` for
 * the next page. A contact-like `q` is sent as POST .../search automatically.
 */
export function listResources<TData = unknown>(
  productId: string,
  capabilityId: string,
  collectionId: string,
  query: ResourceListQuery,
  options: ProductRequestOptions = {},
) {
  if (query.q && isContactLike(query.q)) return searchResources<TData>(productId, capabilityId, collectionId, { ...query, q: query.q }, options);
  return envelopeRequest<ResourceRead<TData>>({
    method: "GET",
    url: resourcePath(productId, capabilityId, collectionId),
    params: cleanQuery(query),
    signal: options.signal,
  });
}

/** GET /{p}/resources/{capability}/{collection}/{id} — one scoped resource. */
export function getResource<TData = unknown>(
  productId: string,
  capabilityId: string,
  collectionId: string,
  resourceId: string,
  query: ResourceDetailQuery,
  options: ProductRequestOptions = {},
) {
  return envelopeRequest<ResourceRead<TData>>({
    method: "GET",
    url: `${resourcePath(productId, capabilityId, collectionId)}/${seg(resourceId, OPAQUE, "resource id")}`,
    params: cleanQuery(query),
    signal: options.signal,
  });
}

/** GET /{p}/reports/{report} — one scoped product report. */
export function getReport<TResult = unknown>(productId: string, reportId: string, query: ReportQuery, options: ProductRequestOptions = {}) {
  return envelopeRequest<TResult>({
    method: "GET",
    url: `${productPath(productId)}/reports/${seg(reportId, OPAQUE, "report id")}`,
    params: cleanQuery(query),
    signal: options.signal,
  });
}

// ── Operations ────────────────────────────────────────────────────

/** GET /{p}/operations/{id} — the operation, after an authoritative readback attempt if it was unsettled. */
export function getOperation(productId: string, operationId: string, options: ProductRequestOptions = {}) {
  return envelopeRequest<OperationView>({ method: "GET", url: `${productPath(productId)}/operations/${seg(operationId, OPAQUE, "operation id")}`, signal: options.signal });
}

/** GET /{p}/operations/{id}/audit — the requester's audit trail of one operation. */
export function getOperationAudit(productId: string, operationId: string, options: ProductRequestOptions = {}) {
  return envelopeRequest<OperationAudit>({ method: "GET", url: `${productPath(productId)}/operations/${seg(operationId, OPAQUE, "operation id")}/audit`, signal: options.signal });
}

function randomUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (!c || typeof c.getRandomValues !== "function") throw clientError("CRYPTO_UNAVAILABLE", "Secure random numbers are not available in this browser");
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** What a page supplies; buildOperationCommand adds command_id and idempotency_key. */
export interface OperationCommandInput<TParams extends Record<string, unknown> = Record<string, unknown>> {
  capability_id: string;
  target: { type: string; id: string; expected_version?: number | null };
  params: TParams;
  reason_code: string;
  case_reference?: string | null;
  scope: CommandScope;
}

/**
 * Builds one operation-command.v1 with a fresh command_id (UUID v4) and an
 * idempotency_key derived from it. Build it ONCE per user intent and keep it:
 * the command_id is also the operation id used for readback.
 */
export function buildOperationCommand<TParams extends Record<string, unknown>>(input: OperationCommandInput<TParams>): OperationCommand<TParams> {
  if (!REASON_CODE.test(input.reason_code)) throw clientError("REASON_CODE_INVALID", "Invalid reason code");
  if (!input.scope?.market?.length || !input.scope?.organization?.length) throw clientError("SCOPE_REQUIRED", "Market and organization scope are required");
  const commandId = randomUuid();
  return {
    command_id: commandId,
    idempotency_key: `hq.${commandId}`,
    capability_id: input.capability_id,
    target: { type: input.target.type, id: input.target.id, expected_version: input.target.expected_version ?? null },
    params: input.params,
    reason_code: input.reason_code,
    case_reference: input.case_reference ?? null,
    scope: input.scope,
  };
}

export interface OperationSubmitResult {
  operation: OperationView;
  envelope: ProductEnvelopeOk<OperationView>;
}

/**
 * True when a failed submit may still have run (no answer, a timeout, a
 * broken/5xx answer after forwarding). Definite refusals (4xx, PIC
 * pre-forward errors, gateway pre-forward codes) are not ambiguous.
 */
function outcomeIsOpen(e: ProductApiError): boolean {
  if (e.source === "client" && e.code !== "CONTRACT_MISMATCH") return false;
  if (e.kind === "cancelled") return true; // the request may already have left the browser
  if (e.source === "network") return true;
  if (e.status !== null && e.status >= 400 && e.status < 500) return false;
  if (e.source === "pic") return false;
  if (e.source === "gateway" && PRE_FORWARD_GATEWAY_CODES.has(e.code)) return false;
  return true;
}

/**
 * POST /{p}/operations — submits one governed command exactly once.
 *
 * Never auto-retried and never resent by this module. If the outcome is open
 * (see above), the thrown ProductApiError has kind "unknown_outcome",
 * retryable false and operation_id = the command's command_id: show it with
 * OperationStatusDrawer, which settles it by reading the operation back.
 * A SUCCESSFUL submit can also report status UNKNOWN_OUTCOME; treat it the same way.
 */
export async function submitOperation<TParams extends Record<string, unknown>>(
  productId: string,
  command: OperationCommand<TParams>,
  options: ProductRequestOptions = {},
): Promise<OperationSubmitResult> {
  if (!UUID.test(command.command_id) || !IDEMPOTENCY_KEY.test(command.idempotency_key)) {
    throw clientError("COMMAND_INVALID", "Build the command with buildOperationCommand()");
  }
  const url = `${productPath(productId)}/operations`;
  try {
    const envelope = await envelopeRequest<OperationView>({ method: "POST", url, data: command, signal: options.signal });
    return { operation: envelope.result, envelope };
  } catch (err) {
    const e = toProductApiError(err);
    if (!outcomeIsOpen(e)) throw e;
    throw new ProductApiError({
      status: e.status,
      code: e.code,
      reason: e.reason ?? "UNKNOWN_OUTCOME",
      retryable: false,
      correlation_id: e.correlation_id,
      operation_id: e.operation_id ?? command.command_id,
      source: e.source,
      envelope: e.envelope,
      kind: "unknown_outcome",
      message: "The outcome is not known yet; read the operation back. The command is never resent.",
    });
  }
}

// ── Grants (read-only; recent MFA required) ───────────────────────

/** GET /{p}/grants — staff grants of one product (needs integration.grants.manage and a recent MFA step-up). */
export function listProductGrants(productId: string, query: GrantListQuery = {}, options: ProductRequestOptions = {}) {
  return dataRequest<ProductGrantList>({ method: "GET", url: `${productPath(productId)}/grants`, params: cleanQuery(query), signal: options.signal });
}

/** GET /{p}/grants/{uuid} — one grant (recent MFA step-up required). */
export function getProductGrant(productId: string, grantId: string, options: ProductRequestOptions = {}) {
  return dataRequest<ProductGrant>({ method: "GET", url: `${productPath(productId)}/grants/${seg(grantId, UUID, "grant id")}`, signal: options.signal });
}
