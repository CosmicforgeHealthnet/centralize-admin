// CF Meet catalog model, built from GET /api/products/cfmeet/capabilities
// (services/cfmeet-admin src/protocol/handlers.js `capabilities`). Nothing here
// invents a collection, command or report: every entry comes from the live
// capabilities response; only the query shape falls back to the pinned
// contract table (pinned-shapes.ts) because the response does not carry it.

import type { Blocker, ProductCapabilities, ProductCapability, ProductScope, ScopeDimension } from "@/types/products.types";
import { PINNED_QUERY_SHAPES, type QueryShape } from "./pinned-shapes";

export const CFMEET_PRODUCT_ID = "cfmeet";

// ── Wire shapes of the CF Meet specific capability keys ───────────

export interface CfMeetCollectionSummary {
  collection_id: string;
  /** True when the Bridge path has a path parameter (detail or nested list). */
  detail: boolean;
  exposure_state: string;
  privacy?: string;
  risk?: string;
  /** Not served today; read when a later Product Admin adds it. */
  query_shape?: QueryShape;
}

export interface CfMeetModuleSummary {
  module: string;
  title: string;
  read_capability_id: string;
  rules: string[];
  inventory_capabilities: number;
  collections: CfMeetCollectionSummary[];
  commands: string[];
}

export interface CfMeetReportSummary {
  report_id: string;
  kind: string;
  grain: string;
  units: string[];
  definition: string;
}

export interface CfMeetCapabilityMapEntry {
  bridge_capability_id: string;
  module: string;
  cfmeet_capability_id: string | null;
  kind: string;
  owner?: string;
  method?: string;
  bridge_path?: string;
  permission?: string;
  scope_dimensions?: ScopeDimension[];
  risk?: string;
  privacy?: string;
  source_state?: string;
  exposure_state: string;
  blocker_codes: string[];
  source_version_required?: boolean;
  idempotency_required?: boolean;
}

export interface CfMeetBridgeLive {
  state: string;
  reason?: string;
  observed_at?: string;
  discovery?: { result?: { capabilities?: { id: string; state: string; blocker: string | null }[] } } | null;
}

export interface CfMeetCapabilities extends ProductCapabilities {
  bridge_contract?: {
    contract?: string;
    contract_version?: string;
    source_commit?: string;
    capability_matrix?: { total?: number; by_state?: Record<string, number> };
  };
  bridge_live?: CfMeetBridgeLive | null;
  modules?: CfMeetModuleSummary[];
  reports?: CfMeetReportSummary[];
  capability_map?: CfMeetCapabilityMapEntry[];
}

// ── Read purposes (fixed list the Product Admin accepts) ──────────

export type ReadPurpose =
  | "support-review"
  | "verification-review"
  | "abuse-review"
  | "billing-review"
  | "pricing-change"
  | "ops-incident"
  | "release-request"
  | "privacy-request"
  | "metrics-read";

// ── Blockers ──────────────────────────────────────────────────────

const BLOCKER_TEXT: Record<string, string> = {
  SOURCE_BLOCKED_DEPENDENCY: "Not released by CF Meet yet: the source capability is waiting on a dependency.",
  SOURCE_DISABLED: "Switched off at the CF Meet source.",
  BRIDGE_TRUST_NOT_ENROLLED: "The private Bridge connection (mTLS identity, HMAC key and staff signing key) is not enrolled for this environment.",
  ZONE_TENANT_NOT_ENROLLED: "No zone or tenant scope is enrolled for the Bridge.",
  NO_READABLE_SOURCE_CAPABILITY: "Every source collection of this module is blocked or disabled at the source.",
  COMMAND_NOT_ENABLED: "Not enabled by the operator for this environment; the source policy must also approve it.",
  HIGH_RISK_CERTIFICATION_REQUIRED: "R3/R4 actions need a two-reviewer certification, recent MFA and an independent approval of the exact request.",
  BRIDGE_FEED_NOT_ENABLED: "The Bridge event consumer is not enabled for this environment.",
  NO_SOURCE_AGGREGATE: "CF Meet releases no aggregate for this figure; it is never estimated from lists.",
  SOURCE_RELEASES_PER_WORKSPACE_ONLY: "Released per workspace only; never summed across workspaces.",
  SOURCE_NOT_RELEASED: "Not released for HQ by CF Meet.",
  SOURCE_CONTRACT_MISSING: "The pinned CF Meet contract has no capability for this.",
  PARTIAL_COVERAGE: "Figures are withheld until the source reports complete coverage.",
  NO_AUTHORIZED_PARTITION: "No synchronized partition matches your scope.",
  SERVED_ELSEWHERE: "This source read is a POST simulation, not a list; it is not offered in this browser.",
};

/** Human explanation of a blocker or exposure code (falls back to the code). */
export function blockerText(code: string): string {
  return BLOCKER_TEXT[code] ?? code.replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

/** States in which a read capability can be called. */
export const USABLE_READ_STATES: readonly string[] = ["READ_ONLY", "AVAILABLE"];

export function isUsableState(state: string | undefined | null): boolean {
  return !!state && USABLE_READ_STATES.includes(state);
}

// ── Labels ────────────────────────────────────────────────────────

/** "organizations.global-audit.list" -> "Global audit". */
export function collectionLabel(collectionId: string): string {
  const parts = collectionId.split(".");
  const noun = parts.length >= 2 ? parts[1] : collectionId;
  const text = noun.replaceAll("-", " ").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ── Collections ───────────────────────────────────────────────────

/**
 * - list:   paged (or searchable / windowed) list, no path parameter
 * - single: one object, no path parameter (SCOPED shape)
 * - detail: one resource, addressed by id
 * - nested: a list of children of one parent resource (needs `parent`)
 * - unsupported: a POST source read that is served elsewhere
 */
export type CollectionRole = "list" | "single" | "detail" | "nested" | "unsupported";

export interface CollectionModel {
  id: string;
  label: string;
  module: string;
  readCapabilityId: string;
  shape: QueryShape;
  role: CollectionRole;
  state: string;
  usable: boolean;
  blockers: Blocker[];
  /** Bridge path relative to the base, e.g. "/organizations/organizations/{organization_id}". */
  path: string | null;
  pathParams: string[];
  scopeDimensions: ScopeDimension[];
  privacy: string | null;
  risk: string | null;
}

const NESTED = /\.(list|search)$/;
const PARAM = /\{([a-z_]+)\}/g;
const ALL_DIMENSIONS: ScopeDimension[] = ["market", "organization", "zone", "tenant"];

function relativePath(bridgePath: string | undefined): string | null {
  if (!bridgePath) return null;
  const m = bridgePath.match(/^\/internal\/[a-z-]+\/v\d+(\/.*)$/);
  return m ? m[1] : bridgePath;
}

/** The query shape of a collection: response value first, then the pinned table, else SCOPED_PAGE. */
export function queryShapeOf(collection: Pick<CfMeetCollectionSummary, "collection_id" | "query_shape">): QueryShape {
  return collection.query_shape ?? PINNED_QUERY_SHAPES[collection.collection_id] ?? "SCOPED_PAGE";
}

function runtimeBlocker(caps: CfMeetCapabilities, id: string): string | null {
  const list = caps.bridge_live?.discovery?.result?.capabilities;
  if (!Array.isArray(list)) return null;
  const hit = list.find((c) => c.id === id);
  return hit?.blocker ?? null;
}

/** All collections of one module, with role, shape, state and blockers. */
export function moduleCollections(caps: CfMeetCapabilities, module: CfMeetModuleSummary): CollectionModel[] {
  const map = new Map((caps.capability_map ?? []).map((e) => [e.bridge_capability_id, e]));
  return module.collections.map((c) => {
    const entry = map.get(c.collection_id);
    const path = relativePath(entry?.bridge_path);
    const pathParams = path ? [...path.matchAll(PARAM)].map((m) => m[1]) : c.detail ? ["id"] : [];
    const shape = queryShapeOf(c);
    let role: CollectionRole;
    if (entry?.method && entry.method !== "GET") role = "unsupported";
    else if (pathParams.length === 0) role = shape === "SCOPED" ? "single" : "list";
    else role = NESTED.test(c.collection_id) ? "nested" : "detail";
    const state = c.exposure_state || entry?.exposure_state || "UNAVAILABLE";
    const codes = entry?.blocker_codes ?? [];
    const runtime = runtimeBlocker(caps, c.collection_id);
    const blockers: Blocker[] = codes.map((code) => ({ code, detail: blockerText(code) }));
    if (runtime) blockers.push({ code: "SOURCE_RUNTIME", detail: runtime });
    if (role === "unsupported") blockers.unshift({ code: "SERVED_ELSEWHERE", detail: blockerText("SERVED_ELSEWHERE") });
    if (!isUsableState(state) && blockers.length === 0) blockers.push({ code: state, detail: blockerText(state) });
    return {
      id: c.collection_id,
      label: collectionLabel(c.collection_id),
      module: module.module,
      readCapabilityId: module.read_capability_id,
      shape,
      role,
      state,
      usable: role !== "unsupported" && isUsableState(state),
      blockers,
      path,
      pathParams,
      scopeDimensions: entry?.scope_dimensions?.length ? entry.scope_dimensions : ALL_DIMENSIONS,
      privacy: c.privacy ?? entry?.privacy ?? null,
      risk: c.risk ?? entry?.risk ?? null,
    };
  });
}

export interface ChildCollection {
  collection: CollectionModel;
  /** Field of the parent row holding the id (the path parameter name). */
  idField: string;
  /** True for the direct detail of the parent (path = parent path + "/{id}"). */
  isPrimaryDetail: boolean;
}

/**
 * Collections addressed by one row of `parent`: its detail, sub-resource
 * details and nested lists (path = parent path + "/{param}" + optional rest).
 * Only one-parameter paths are offered (two-parameter ids are not browsable).
 */
export function childCollections(parent: CollectionModel, all: CollectionModel[]): ChildCollection[] {
  if (!parent.path || parent.pathParams.length !== 0) return [];
  const prefix = parent.path + "/{";
  const out: ChildCollection[] = [];
  for (const c of all) {
    if (c === parent || !c.path || c.pathParams.length !== 1 || !c.path.startsWith(prefix)) continue;
    if (c.role !== "detail" && c.role !== "nested") continue;
    const rest = c.path.slice(prefix.length);
    const close = rest.indexOf("}");
    if (close < 0) continue;
    out.push({ collection: c, idField: rest.slice(0, close), isPrimaryDetail: rest.length === close + 1 });
  }
  return out.sort((a, b) => Number(b.isPrimaryDetail) - Number(a.isPrimaryDetail));
}

/** Detail and nested collections with no list parent in their module: reachable by id lookup only. */
export function orphanCollections(all: CollectionModel[]): CollectionModel[] {
  const reachable = new Set<string>();
  for (const c of all) if (c.role === "list") for (const child of childCollections(c, all)) reachable.add(child.collection.id);
  return all.filter((c) => (c.role === "detail" || c.role === "nested") && !reachable.has(c.id));
}

/** The resource id a row carries for a child collection (path parameter field, else "id"). */
export function rowIdFor(row: Record<string, unknown>, idField: string): string | null {
  const value = row[idField] ?? row.id;
  return typeof value === "string" && RESOURCE_ID.test(value) ? value : typeof value === "number" ? String(value) : null;
}

/** Gateway pattern for ids (path segments and `parent`). */
export const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// ── Capabilities lookups ──────────────────────────────────────────

export function capabilityById(caps: CfMeetCapabilities | undefined, id: string): ProductCapability | null {
  return caps?.capabilities.find((c) => c.id === id) ?? null;
}

export function moduleById(caps: CfMeetCapabilities | undefined, moduleId: string): CfMeetModuleSummary | null {
  return caps?.modules?.find((m) => m.module === moduleId) ?? null;
}

export interface CommandModel {
  id: string;
  bridgeId: string;
  kind: string;
  risk: string;
  state: string;
  description: string;
  requiresApproval: boolean;
  requiresRecentMfa: boolean;
  blockers: Blocker[];
}

/** Commands of one module with their exposure state and blockers (from the catalog capability when present). */
export function moduleCommands(caps: CfMeetCapabilities, moduleId: string): CommandModel[] {
  const entries = (caps.capability_map ?? []).filter((e) => e.module === moduleId && e.cfmeet_capability_id && e.kind !== "READ" && e.kind !== "SYNC");
  return entries.map((e) => {
    const cap = capabilityById(caps, e.cfmeet_capability_id as string);
    const blockers = cap?.blockers?.length ? cap.blockers : e.blocker_codes.map((code) => ({ code, detail: blockerText(code) }));
    return {
      id: e.cfmeet_capability_id as string,
      bridgeId: e.bridge_capability_id,
      kind: e.kind,
      risk: cap?.risk ?? e.risk ?? "—",
      state: cap?.state ?? e.exposure_state,
      description: cap?.description ?? `${e.method ?? ""} ${relativePath(e.bridge_path) ?? ""}`.trim(),
      requiresApproval: cap?.requires_independent_approval ?? false,
      requiresRecentMfa: cap?.requires_recent_mfa ?? true,
      blockers,
    };
  });
}

// ── Scope ─────────────────────────────────────────────────────────

/** One exact value per dimension ("" when the grant has none). */
export type CfMeetScope = Record<ScopeDimension, string>;

export const SCOPE_DIMENSIONS: readonly ScopeDimension[] = ALL_DIMENSIONS;

export function initialScope(effective: ProductScope | undefined): CfMeetScope {
  const pick = (d: ScopeDimension) => effective?.[d]?.[0] ?? "";
  return { market: pick("market"), organization: pick("organization"), zone: pick("zone"), tenant: pick("tenant") };
}

/** Dimensions the read needs that the selected scope lacks. */
export function missingDimensions(scope: CfMeetScope, needed: readonly ScopeDimension[]): ScopeDimension[] {
  return needed.filter((d) => !scope[d]);
}

/** Only the dimensions a read takes, never empty values. */
export function scopeQuery(scope: CfMeetScope, dimensions: readonly ScopeDimension[]) {
  const out: Partial<CfMeetScope> = {};
  for (const d of dimensions) if (scope[d]) out[d] = scope[d];
  return out as { market: string; organization: string; zone?: string; tenant?: string };
}

// ── Time window (SCOPED_WINDOW) ───────────────────────────────────

/** The Product Admin refuses windows over 31 days or ending more than a minute ahead. */
export const MAX_WINDOW_MS = 31 * 24 * 3600 * 1000;
export const DEFAULT_WINDOW_MS = 7 * 24 * 3600 * 1000;
const FUTURE_SLACK_MS = 60 * 1000;

export interface TimeWindow {
  start: string;
  end: string;
}

export function defaultWindow(now = Date.now()): TimeWindow {
  const end = Math.floor(now / 60000) * 60000;
  return { start: new Date(end - DEFAULT_WINDOW_MS).toISOString(), end: new Date(end).toISOString() };
}

/** Null when valid; otherwise why the backend would refuse it. */
export function windowProblem(window: TimeWindow, now = Date.now()): string | null {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return "Choose a start and an end time.";
  if (!(end > start)) return "The end must be after the start.";
  if (end - start > MAX_WINDOW_MS) return "The window can be at most 31 days.";
  if (end > now + FUTURE_SLACK_MS) return "The end cannot be in the future.";
  return null;
}

/** Same rule as the Product Admin's search parameter. */
export const SEARCH_PATTERN = /^[\p{L}\p{N} ._@:-]{1,128}$/u;
