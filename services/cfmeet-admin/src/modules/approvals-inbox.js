"use strict";

// Approvals inbox (design §10, HQ "waiting for me" / "my requests"): read-only
// views of CF Meet Admin's LOCAL two-person approval records, served as
// Protocol 1.1 resource reads of the local capability cfmeet.governance.read.
// No source call and no write.
//
//   approvals-pending   PROPOSED, unexpired approvals the caller may decide
//                       now: not proposed by the caller and passing the
//                       decide path's second-person rule; newest first.
//   approvals-mine      approvals the caller requested, any status; newest first.
//   approvals/{id}      one approval, only for its requester or a staff member
//                       who passes the second-person rule. Anything else
//                       answers exactly like an unknown ID.
//
// Same order of checks as the source-backed reads: delegation action
// resource.read; strict query (scope, purpose, bounded page); requested scope
// inside the delegated scope; recent MFA; continuation sealed and bound to
// staff, collection, scope and filters. Every item's scope must also sit
// inside the delegated scope. Items carry a fixed, body-free field set, are
// scanned for forbidden fields and audited (no audit, no data).

const { contracts } = require("../packages");
const { ContinuationError } = require("./continuation");
const { scanForbidden, READ_PURPOSES } = require("./reads");
const { withinScope, approverIneligibility, decidableBy } = require("../operations/service");

const P = contracts.ProtocolError;
const GOVERNANCE_READ = "cfmeet.governance.read";
const MODULE = "governance";
const PRIVACY = "INTERNAL";
const RISK = "R1";
const COLLECTIONS = Object.freeze({
  "approvals-pending": Object.freeze({ kind: "LIST", title: "Waiting for me: approvals you can decide now" }),
  "approvals-mine": Object.freeze({ kind: "LIST", title: "My requests: approvals you proposed, any status" }),
  approvals: Object.freeze({ kind: "DETAIL", title: "One approval, for its requester or an eligible approver" }),
});
const RULES = Object.freeze([
  "Local approval records only; no request bodies are stored or shown",
  "Waiting for me lists only approvals you could decide now (not your own, whole scope held, approved role for high risk)",
  "Deciding still goes through cfmeet.governance.approval.decide with recent MFA",
]);
const DIMS = Object.freeze(["market", "organization", "zone", "tenant"]);
const SCOPE = new RegExp(contracts.PATTERNS.scopeValue);
const PURPOSE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CONTINUATION = /^[A-Za-z0-9_-]{16,2048}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Sealed keyset: "<requested_at, ISO 8601 UTC>|<approval id>".
const KEY = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([0-9a-f-]{36})$/;
const MAX_MFA_AGE_SECONDS = 300;
const DEFAULT_LIMIT = 50;
// Rows read per store call, and the most store calls one page may make. A
// page that hits the bound returns what it found with a continuation.
const SCAN_BATCH = 100;
const MAX_SCAN_BATCHES = 10;

function governanceReadCapability() {
  return {
    id: GOVERNANCE_READ, version: "1.0.0", kind: "READ", state: "READ_ONLY", risk: RISK,
    description: "Two-person approvals inbox: approvals waiting for the caller and the caller's own requests (local records; no source call)",
    datasets: [], blockers: [], requires_recent_mfa: true, requires_independent_approval: false, request_schema: null,
  };
}

// Capability discovery entry, same shape as the Bridge-backed modules.
function governanceModuleSummary(localCommands) {
  return {
    module: MODULE, title: "Two-person approvals", read_capability_id: GOVERNANCE_READ, rules: RULES, inventory_capabilities: 0,
    collections: Object.entries(COLLECTIONS).map(([id, c]) => ({ collection_id: id, detail: c.kind === "DETAIL", exposure_state: "READ_ONLY", privacy: PRIVACY, risk: RISK })),
    commands: localCommands,
  };
}

function parseQuery(searchParams, { list }) {
  const allowed = new Set(["market", "organization", "zone", "tenant", "purpose", ...(list ? ["limit", "continuation"] : [])]);
  const q = {};
  for (const [key, raw] of searchParams) {
    if (!allowed.has(key)) throw new P("INVALID_REQUEST", "UNKNOWN_OR_UNSUPPORTED_PARAMETER");
    if (Object.prototype.hasOwnProperty.call(q, key)) throw new P("INVALID_REQUEST", "DUPLICATE_PARAMETER");
    if (raw.length > 2048) throw new P("INVALID_REQUEST", "PARAMETER_TOO_LONG");
    q[key] = raw;
  }
  for (const dim of ["market", "organization"]) if (q[dim] === undefined) throw new P("INVALID_REQUEST", "SCOPE_" + dim.toUpperCase() + "_REQUIRED");
  for (const dim of DIMS) if (q[dim] !== undefined && !SCOPE.test(q[dim])) throw new P("INVALID_REQUEST", "SCOPE_INVALID");
  if (!q.purpose || !PURPOSE.test(q.purpose)) throw new P("INVALID_REQUEST", "PURPOSE_REQUIRED");
  if (!READ_PURPOSES.includes(q.purpose)) throw new P("INVALID_REQUEST", "PURPOSE_NOT_ALLOWED");
  if (list) {
    if (q.limit !== undefined && !/^(?:[1-9][0-9]?|100)$/.test(q.limit)) throw new P("INVALID_REQUEST", "LIMIT_OUT_OF_BOUNDS");
    q.limit = q.limit === undefined ? DEFAULT_LIMIT : Number(q.limit);
    if (q.continuation !== undefined && !CONTINUATION.test(q.continuation)) throw new P("INVALID_REQUEST", "CONTINUATION_INVALID");
  }
  return q;
}

// The fixed, body-free view of one approval.
function itemOf(a, nowMs) {
  return {
    approval_id: a.approval_id,
    capability: a.capability_id,
    status: a.status,
    risk: a.risk,
    // The stored status of an expired, never-used approval stays PROPOSED or APPROVED.
    expired: (a.status === "PROPOSED" || a.status === "APPROVED") && Date.parse(a.expires_at) <= nowMs,
    requester_ref: a.requested_by,
    approver_ref: a.decided_by,
    intent_summary: {
      capability: a.capability_id,
      target: a.target_type && a.target_id ? { type: a.target_type, id: a.target_id } : null,
      expected_version: a.expected_version,
      reason_code: a.request_reason_code,
      case_reference: a.case_reference,
      scope: a.scope,
    },
    intent_digest: a.intent_digest,
    created_at: a.requested_at,
    decided_at: a.decided_at,
    expires_at: a.expires_at,
  };
}

function createApprovalsInbox({ config, approvals, continuation, audit, accessLog, now = Date.now }) {
  const productId = config.productId;

  async function record(ctx, collection, scope, purpose, outcome, itemCount) {
    await audit.record({
      correlation_id: ctx.correlationId, request_id: ctx.requestId, endpoint: ctx.endpointId, method: "GET",
      service_id: ctx.service && ctx.service.serviceId, staff_ref: ctx.delegation.sub, action: "resource.read",
      outcome, reason_code: null, metadata: { module: MODULE, collection, privacy: PRIVACY, risk: RISK, items: Number.isInteger(itemCount) ? itemCount : -1 },
    });
    await accessLog.record({ correlationId: ctx.correlationId, staffRef: ctx.delegation.sub, capabilityId: GOVERNANCE_READ + ":" + collection, privacyClass: PRIVACY, purpose, scope, outcome, itemCount });
  }

  // One page: keep reading store batches (newest first) until `limit`
  // visible items plus one more prove a next page, the store is exhausted,
  // or the scan bound is reached.
  async function page(filter, visible, limit, after) {
    const items = [];
    let lastIncluded = null;
    let scanned = after;
    for (let batch = 0; batch < MAX_SCAN_BATCHES; batch += 1) {
      const rows = await approvals.list({ ...filter, after: scanned, limit: SCAN_BATCH });
      for (const row of rows) {
        if (visible(row.approval)) {
          if (items.length === limit) return { items, next: lastIncluded };
          items.push(row.approval);
          lastIncluded = row.key;
        }
        scanned = row.key;
      }
      if (rows.length < SCAN_BATCH) return { items, next: null };
    }
    return { items, next: scanned };
  }

  async function read(ctx, { list }) {
    if (!ctx.delegation || ctx.delegation.action !== "resource.read") throw new P("FORBIDDEN", "DELEGATION_ACTION_MISMATCH");
    const collectionId = ctx.params.collectionId;
    const collection = Object.prototype.hasOwnProperty.call(COLLECTIONS, collectionId) ? COLLECTIONS[collectionId] : null;
    if (!collection) throw new P("NOT_FOUND", "UNKNOWN_COLLECTION");
    if (list && collection.kind !== "LIST") throw new P("INVALID_REQUEST", "COLLECTION_REQUIRES_RESOURCE_ID");
    if (!list && collection.kind !== "DETAIL") throw new P("INVALID_REQUEST", "COLLECTION_IS_NOT_A_DETAIL");
    const q = parseQuery(ctx.query, { list });

    // Requested scope inside the delegated scope; nothing implicit.
    const delegation = ctx.delegation;
    const delegated = delegation.scope || {};
    for (const dim of DIMS) {
      if (q[dim] !== undefined && !(Array.isArray(delegated[dim]) && delegated[dim].includes(q[dim]))) {
        throw new P("FORBIDDEN", dim === "market" || dim === "organization" ? "SCOPE_NOT_GRANTED" : dim.toUpperCase() + "_NOT_GRANTED");
      }
    }
    const nowMs = now();
    const nowS = Math.floor(nowMs / 1000);
    const mfaAt = delegation.mfa_at;
    if (!Number.isInteger(mfaAt) || mfaAt <= 0 || mfaAt > nowS + 5 || nowS - mfaAt > MAX_MFA_AGE_SECONDS) throw new P("FORBIDDEN", "RECENT_MFA_REQUIRED");

    const scope = { market: q.market, organization: q.organization };
    for (const dim of ["zone", "tenant"]) if (q[dim] !== undefined) scope[dim] = q[dim];
    const filter = { market: q.market, organization: q.organization, zone: q.zone, tenant: q.tenant };
    const inRequestedScope = (a) => DIMS.every((dim) => scope[dim] === undefined || (Array.isArray(a.scope[dim]) && a.scope[dim].includes(scope[dim])));
    const observedAt = new Date(nowMs).toISOString();

    let data;
    let next = null;
    let more = false;
    let snapshotAsOf = null;
    let items;
    if (list) {
      const mine = collectionId === "approvals-mine";
      const binding = { staff: delegation.sub, capability: GOVERNANCE_READ, collection: collectionId, scope, filters: { purpose: q.purpose, limit: q.limit } };
      let after = null;
      if (q.continuation) {
        if (!continuation) throw new P("INVALID_REQUEST", "CONTINUATION_INVALID");
        let opened;
        try { opened = continuation.open(q.continuation, binding); } catch (err) {
          throw new P("INVALID_REQUEST", err instanceof ContinuationError ? err.reason : "CONTINUATION_INVALID");
        }
        const m = KEY.exec(opened.bridgeCursor);
        if (!m) throw new P("INVALID_REQUEST", "CONTINUATION_INVALID");
        after = { at: m[1], id: m[2] };
        snapshotAsOf = opened.snapshotAsOf;
      }
      const visible = mine
        ? (a) => a.requested_by === delegation.sub && withinScope(a.scope, delegated) && inRequestedScope(a)
        : (a) => decidableBy(a, delegation, { config, nowMs }) && inRequestedScope(a);
      let result;
      try {
        result = await page({ ...filter, ...(mine ? { requestedBy: delegation.sub } : { notRequestedBy: delegation.sub, openAt: nowMs }) }, visible, q.limit, after);
      } catch {
        await record(ctx, collectionId, scope, q.purpose, "READ_FAILED", null).catch(() => {});
        throw new P("UNAVAILABLE", "APPROVAL_STORE_UNAVAILABLE", { retryable: true });
      }
      items = result.items.map((a) => itemOf(a, nowMs));
      if (result.next) {
        more = true;
        if (continuation) next = continuation.seal(binding, result.next.at + "|" + result.next.id, snapshotAsOf || observedAt, null);
      }
      data = { items };
    } else {
      const id = ctx.params.resourceId;
      let a = null;
      try { a = UUID.test(id) ? await approvals.get(id) : null; } catch {
        await record(ctx, collectionId, scope, q.purpose, "READ_FAILED", null).catch(() => {});
        throw new P("UNAVAILABLE", "APPROVAL_STORE_UNAVAILABLE", { retryable: true });
      }
      const visible = a && inRequestedScope(a) && (a.requested_by === delegation.sub
        ? withinScope(a.scope, delegated)
        : approverIneligibility(a, delegation, { config, nowS }) === null);
      if (!visible) {
        await record(ctx, collectionId, scope, q.purpose, "READ_NOT_FOUND", 0).catch(() => {});
        throw new P("NOT_FOUND", "APPROVAL_NOT_FOUND");
      }
      items = [itemOf(a, nowMs)];
      data = items[0];
    }
    if (scanForbidden(data)) {
      await record(ctx, collectionId, scope, q.purpose, "READ_SUPPRESSED_SENSITIVE", null).catch(() => {});
      throw new P("CONTRACT_MISMATCH", "SENSITIVE_FIELD_SUPPRESSED");
    }
    // No audit, no data.
    try { await record(ctx, collectionId, scope, q.purpose, "READ_AUTHORIZED", items.length); } catch {
      throw new P("UNAVAILABLE", "AUDIT_UNAVAILABLE", { retryable: true });
    }
    // Without a continuation key a further page cannot be offered: say so.
    const complete = !(more && !next);
    return {
      body: contracts.okEnvelope({
        productId, correlationId: ctx.correlationId, asOf: observedAt, freshness: "FRESH", coverage: complete ? "COMPLETE" : "PARTIAL",
        result: {
          module: MODULE, capability_id: GOVERNANCE_READ, collection_id: collectionId, kind: list ? "LIST" : "DETAIL",
          source: { kind: "LOCAL", owner: "cfmeet-admin", privacy: PRIVACY, risk: RISK },
          scope, filters: { purpose: q.purpose, limit: list ? q.limit : null }, quality: complete ? "LIVE" : "PARTIAL_COVERAGE",
          observed_at: observedAt, first_page_observed_at: snapshotAsOf,
          data, continuation: next, has_more: more,
        },
      }, nowMs),
    };
  }

  return {
    serves: (capabilityId) => capabilityId === GOVERNANCE_READ,
    list: (ctx) => read(ctx, { list: true }),
    get: (ctx) => read(ctx, { list: false }),
  };
}

module.exports = { GOVERNANCE_READ, COLLECTIONS, governanceReadCapability, governanceModuleSummary, createApprovalsInbox, parseQuery, itemOf };
