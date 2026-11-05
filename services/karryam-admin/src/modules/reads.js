"use strict";

// Scoped module reads (Protocol 1.1 resourceList / resourceGet).
//
// Order of checks, all before any network call:
//   1. delegation action resource.read (HQ already checked grant + MFA);
//   2. the capability is a module READ capability and the collection is one
//      of its pinned Bridge READ capabilities, currently exposed READ_ONLY;
//   3. strict query: only the parameters of that capability's source shape,
//      bounded window and page size, explicit purpose;
//   4. requested market/organization/zone/tenant inside the delegated scope
//      AND inside this Bridge's enrollment (no implicit "all zones");
//   5. continuation token bound to staff, capability, scope and filters.
// Then one exact Bridge request; the result is validated against the pinned
// schema, scanned for forbidden personal fields, audited (no audit, no data)
// and returned with its source observation time, freshness and coverage.

const { contracts } = require("../packages");
const R = require("../bridge/contracts/registry");
const { protocolMapping } = require("../bridge/errors");
const { bridgeStaffContext, StaffContextError } = require("../bridge/capabilities");
const { moduleFor, collectionFor, readExposure } = require("./catalog");
const { ContinuationError } = require("./continuation");
const { qualityOf } = require("./quality");

const P = contracts.ProtocolError;
const SCOPE = new RegExp(contracts.PATTERNS.scopeValue);
const PURPOSE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const CONTINUATION = /^[A-Za-z0-9_-]{16,2048}$/;
const DEFAULT_WINDOW_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_LIMIT = 50;

// Field names that must never appear in an HQ-bound administrative read,
// whatever the source returns (defence in depth on top of source minimization).
const FORBIDDEN_FIELD = /^(?:nin|bvn|ssn|national_id|passport(?:_number)?|document_number|id_number|password|passcode|pin|otp|secret|token|api_key|private_key|phone|phone_number|msisdn|email|email_address|latitude|longitude|lat|lng|lon|gps|coordinates|location_trail|account_number|iban|card_number|pan|cvv|message_body|body_text|raw_payload)$/i;
// Read-oriented Bridge contracts that the source exposes as POST with a
// body. A lookup by ID becomes a detail read; the finance report is a
// multi-figure report and is served only through reportGet.
const POST_READS = Object.freeze({
  "hq.media.legacy-mapping": { detailBody: (id) => ({ legacy_asset_id: id }) },
  "hq.finance.report": { servedBy: "SERVED_BY_REPORT" },
});
// Classes that are plain metadata and need no sensitive-access record.
const METADATA_CLASSES = new Set(["MINIMIZED_METADATA", "SUPPRESSED_COUNT_METADATA"]);

function scanForbidden(value, depth = 0) {
  if (depth > 32) return true;
  if (Array.isArray(value)) return value.some((v) => scanForbidden(v, depth + 1));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_FIELD.test(k)) return true;
      if (scanForbidden(v, depth + 1)) return true;
    }
  }
  return false;
}

function parseReadQuery(searchParams, cap, { list, now }) {
  const shape = R.SHAPE_PARAMS[cap.query_shape];
  const allowed = new Set(["market", "organization", "purpose"]);
  if (shape.includes("zone")) { allowed.add("zone"); allowed.add("tenant"); }
  if (list && shape.includes("start")) { allowed.add("start"); allowed.add("end"); }
  if (list && shape.includes("limit")) { allowed.add("limit"); allowed.add("continuation"); }
  if (!list && shape.includes("start")) { allowed.add("start"); allowed.add("end"); }
  if (shape.includes("authority")) { allowed.add("authority"); allowed.add("product_code"); }
  const q = {};
  for (const [key, raw] of searchParams) {
    if (!allowed.has(key)) throw new P("INVALID_REQUEST", "UNKNOWN_OR_UNSUPPORTED_PARAMETER");
    if (Object.prototype.hasOwnProperty.call(q, key)) throw new P("INVALID_REQUEST", "DUPLICATE_PARAMETER");
    if (raw.length > 2048) throw new P("INVALID_REQUEST", "PARAMETER_TOO_LONG");
    q[key] = raw;
  }
  for (const dim of ["market", "organization", "zone", "tenant"]) {
    if (!allowed.has(dim)) continue;
    if (q[dim] === undefined) throw new P("INVALID_REQUEST", "SCOPE_" + dim.toUpperCase() + "_REQUIRED");
    if (!SCOPE.test(q[dim])) throw new P("INVALID_REQUEST", "SCOPE_INVALID");
  }
  if (!q.purpose || !PURPOSE.test(q.purpose)) throw new P("INVALID_REQUEST", "PURPOSE_REQUIRED");
  q.explicitWindow = q.start !== undefined || q.end !== undefined;
  if (allowed.has("start")) {
    for (const k of ["start", "end"]) if (q[k] !== undefined && (!DATE_TIME.test(q[k]) || Number.isNaN(Date.parse(q[k])))) throw new P("INVALID_REQUEST", "TIME_WINDOW_INVALID");
    const end = q.end ? Date.parse(q.end) : now;
    const start = q.start ? Date.parse(q.start) : end - DEFAULT_WINDOW_MS;
    if (!(end > start) || end - start > R.MAX_WINDOW_MS || end > now + 60000) throw new P("INVALID_REQUEST", "TIME_WINDOW_INVALID");
    q.start = new Date(start).toISOString();
    q.end = new Date(end).toISOString();
  }
  if (allowed.has("limit")) {
    if (q.limit !== undefined && !/^(?:[1-9][0-9]?|100)$/.test(q.limit)) throw new P("INVALID_REQUEST", "LIMIT_OUT_OF_BOUNDS");
    q.limit = q.limit === undefined ? DEFAULT_LIMIT : Number(q.limit);
  }
  if (q.continuation !== undefined && !CONTINUATION.test(q.continuation)) throw new P("INVALID_REQUEST", "CONTINUATION_INVALID");
  if (q.authority !== undefined && !R.ANALYTICS_AUTHORITIES.includes(q.authority)) throw new P("INVALID_REQUEST", "AUTHORITY_INVALID");
  if (allowed.has("authority") && (!q.authority || !q.product_code || !SCOPE.test(q.product_code))) throw new P("INVALID_REQUEST", "ANALYTICS_FILTER_REQUIRED");
  return q;
}

function staffError(err) {
  const reason = err instanceof StaffContextError ? err.reason : "STAFF_CONTEXT_INVALID";
  return new P("FORBIDDEN", reason);
}

function exposureError(exposure) {
  if (exposure.state === "DISABLED") return new P("DISABLED", "SOURCE_CAPABILITY_DISABLED");
  const code = exposure.blockers[0] ? exposure.blockers[0].code : "BLOCKED_DEPENDENCY";
  return new P("UNAVAILABLE", code === "BRIDGE_TRUST_NOT_ENROLLED" ? code : code.startsWith("SOURCE_") ? code : "BLOCKED_DEPENDENCY_" + code, { retryable: false });
}

function createReads({ config, bridgeClient, continuation, audit, accessLog, now = Date.now, logger = () => {} }) {
  const productId = config.productId;

  async function record(ctx, cap, module, scope, purpose, outcome, itemCount) {
    await audit.record({
      correlation_id: ctx.correlationId, request_id: ctx.requestId, endpoint: ctx.endpointId, method: "GET",
      service_id: ctx.service && ctx.service.serviceId, staff_ref: ctx.delegation && ctx.delegation.sub, action: "resource.read",
      outcome, reason_code: null, metadata: { module: module.id, bridge_capability: cap.id, privacy: cap.privacy, risk: cap.risk, items: Number.isInteger(itemCount) ? itemCount : -1 },
    });
    if (!METADATA_CLASSES.has(cap.privacy) && ctx.delegation) {
      await accessLog.record({ correlationId: ctx.correlationId, staffRef: ctx.delegation.sub, capabilityId: cap.id, privacyClass: cap.privacy, purpose, scope, outcome, itemCount });
    }
  }

  async function read(ctx, { list }) {
    if (!ctx.delegation || ctx.delegation.action !== "resource.read") throw new P("FORBIDDEN", "DELEGATION_ACTION_MISMATCH");
    const module = moduleFor(ctx.params.capabilityId);
    if (!module) throw new P("NOT_FOUND", "UNKNOWN_CAPABILITY");
    const cap = collectionFor(module, ctx.params.collectionId);
    if (!cap) throw new P("NOT_FOUND", "UNKNOWN_COLLECTION");
    const pathCount = cap.path_params.length;
    const postRead = cap.method === "POST" ? POST_READS[cap.id] : null;
    if (cap.method === "POST" && (!postRead || postRead.servedBy)) throw new P("INVALID_REQUEST", postRead ? postRead.servedBy : "COLLECTION_NOT_READABLE");
    if (postRead && list) throw new P("INVALID_REQUEST", "COLLECTION_REQUIRES_RESOURCE_ID");
    if (!postRead && (list ? pathCount !== 0 : pathCount === 0)) throw new P("INVALID_REQUEST", list ? "COLLECTION_REQUIRES_RESOURCE_ID" : "COLLECTION_IS_NOT_A_DETAIL");
    const exposure = readExposure(cap, config);
    if (exposure.state !== "READ_ONLY") throw exposureError(exposure);
    if (!bridgeClient) throw new P("UNAVAILABLE", "BRIDGE_TRUST_NOT_ENROLLED");
    const q = parseReadQuery(ctx.query, cap, { list, now: now() });

    const zoneTenant = R.needsZoneTenant(cap) ? { zone: q.zone, tenant: q.tenant } : {};
    if (q.market !== config.bridge.market || q.organization !== config.bridge.organization) throw new P("FORBIDDEN", "SCOPE_NOT_ENROLLED");
    let staff;
    try { staff = bridgeStaffContext(ctx.delegation, config.bridge, Math.floor(now() / 1000), zoneTenant); } catch (err) { throw staffError(err); }

    const pathParams = {};
    let body;
    if (postRead) body = postRead.detailBody(ctx.params.resourceId);
    else if (!list) {
      const id = ctx.params.resourceId;
      if (pathCount === 1) pathParams[cap.path_params[0].name] = id;
      else {
        const split = id.indexOf(":");
        if (split <= 0 || split === id.length - 1) throw new P("INVALID_REQUEST", "RESOURCE_ID_REQUIRES_KIND_AND_ID");
        pathParams[cap.path_params[0].name] = id.slice(0, split);
        pathParams[cap.path_params[1].name] = id.slice(split + 1);
      }
    }
    const scope = { market: q.market, organization: q.organization, ...zoneTenant };
    const bound = { purpose: q.purpose, limit: q.limit || null, authority: q.authority || null, product_code: q.product_code || null };
    const binding = { staff: ctx.delegation.sub, capability: module.read, collection: cap.id, scope, filters: bound };
    let bridgeCursor;
    let snapshotAsOf = null;
    if (q.continuation) {
      if (!continuation) throw new P("INVALID_REQUEST", "CONTINUATION_INVALID");
      let window;
      try { ({ bridgeCursor, snapshotAsOf, window } = continuation.open(q.continuation, binding)); } catch (err) {
        throw new P("INVALID_REQUEST", err instanceof ContinuationError ? err.reason : "CONTINUATION_INVALID");
      }
      // Later pages read exactly the first page's window.
      if (window) {
        if (q.explicitWindow && (q.start !== window.start || q.end !== window.end)) throw new P("INVALID_REQUEST", "CONTINUATION_BINDING_MISMATCH");
        q.start = window.start;
        q.end = window.end;
      }
    }
    const filters = { ...bound, start: q.start || null, end: q.end || null };
    const query = { market: q.market, organization: q.organization, purpose: q.purpose, ...zoneTenant };
    for (const k of ["start", "end", "limit", "authority", "product_code"]) if (q[k] !== undefined && R.SHAPE_PARAMS[cap.query_shape].includes(k)) query[k] = q[k];
    if (bridgeCursor) query.cursor = bridgeCursor;
    // Detail routes still carry the source's required page size.
    if (R.SHAPE_PARAMS[cap.query_shape].includes("limit") && query.limit === undefined) query.limit = 1;

    let res;
    try {
      res = await bridgeClient.call(cap.id, { staff, query, pathParams, body });
    } catch (err) {
      const mapped = protocolMapping(err);
      logger({ event: "bridge_read_failed", bridge_capability: cap.id, category: err.category || "UNKNOWN", correlation_id: ctx.correlationId });
      await record(ctx, cap, module, scope, q.purpose, "READ_" + (err.category || "FAILED").slice(0, 40), null).catch(() => {});
      throw new P(mapped.code, mapped.reason, { retryable: mapped.retryable });
    }
    if (scanForbidden(res.result)) {
      await record(ctx, cap, module, scope, q.purpose, "READ_SUPPRESSED_SENSITIVE", null).catch(() => {});
      throw new P("CONTRACT_MISMATCH", "SENSITIVE_FIELD_SUPPRESSED");
    }
    const data = res.result && typeof res.result === "object" && !Array.isArray(res.result) ? { ...res.result } : res.result;
    let next = null;
    if (data && typeof data.next_cursor === "string") {
      if (data.next_cursor && list && continuation) next = continuation.seal(binding, data.next_cursor, snapshotAsOf || res.asOf, q.start ? { start: q.start, end: q.end } : null);
      delete data.next_cursor;
    }
    const items = data && Array.isArray(data.items) ? data.items.length : (data ? 1 : 0);
    // No audit, no data.
    try { await record(ctx, cap, module, scope, q.purpose, "READ_AUTHORIZED", items); } catch {
      throw new P("UNAVAILABLE", "AUDIT_UNAVAILABLE", { retryable: true });
    }
    const quality = qualityOf(res.freshness, data && data.coverage);
    const summary = R.summary();
    return {
      body: contracts.okEnvelope({
        productId, correlationId: ctx.correlationId, asOf: res.asOf, freshness: quality.freshness, coverage: quality.coverage,
        result: {
          module: module.id, capability_id: module.read, collection_id: cap.id, kind: list ? "LIST" : "DETAIL",
          source: { owner: cap.owner, bridge_capability_id: cap.id, permission: cap.permission, privacy: cap.privacy, risk: cap.risk, contract: summary.contract, contract_version: summary.contract_version, openapi_sha256: summary.source_artifacts.openapi_sha256 },
          scope, filters, quality: quality.label, source_freshness: res.freshness, observed_at: res.asOf,
          first_page_observed_at: snapshotAsOf, bridge_correlation_id: res.bridgeCorrelationId,
          data, continuation: next,
        },
      }, now()),
    };
  }

  return { list: (ctx) => read(ctx, { list: true }), get: (ctx) => read(ctx, { list: false }) };
}

module.exports = { createReads, parseReadQuery, scanForbidden, FORBIDDEN_FIELD };
