"use strict";

// Governed action pipeline (Section 4.3-4.5) behind POST /operations.
//
//  1. Typed command (operation-command.v1) with an operation.submit
//     delegation; scope must stay inside the delegation.
//  2. Exact capability mapping: karryam.<bridge capability> commands from
//     the pinned registry, or the two local approval commands. Anything not
//     AVAILABLE is durably REJECTED (nothing executes).
//  3. The exact Bridge body is validated against the pinned source schema;
//     server-bound fields (operation_id, idempotency_key, reason_code,
//     expected_version, case_ref) must equal the command's own values.
//  4. Intent + audit are persisted BEFORE dispatch; an approval reference,
//     when present or required, is validated and consumed exactly once.
//  5. One dispatch. A definite refusal is FAILED; a timeout, 5xx or broken
//     response after the request may have arrived is UNKNOWN_OUTCOME and is
//     never resubmitted: only authoritative readback of the original
//     operation (GET /operations/{id}) can settle it.

const { contracts } = require("../packages");
const R = require("../bridge/contracts/registry");
const { protocolMapping } = require("../bridge/errors");
const { bridgeStaffContext, StaffContextError } = require("../bridge/capabilities");
const { commandExposure } = require("../modules/catalog");
const { ApprovalError } = require("../db/approvals");

const P = contracts.ProtocolError;
const validateCommand = contracts.compile(contracts.schemas.SCHEMAS["operation-command.v1"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STALE_DISPATCH_MS = 60 * 1000;
const REQUESTED_AT_SKEW_MS = 5 * 60 * 1000;

const LOCAL = Object.freeze({
  "karryam.governance.approval.propose": {
    risk: "R2", description: "Propose an independent approval bound to one capability, intent digest and exact scope (local record; no source call)",
    schema: { type: "object", additionalProperties: false, required: ["capability_id", "intent_digest", "ttl_seconds"], properties: {
      capability_id: { type: "string", pattern: "^[a-z][a-z0-9_.-]{1,95}$" }, intent_digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" }, ttl_seconds: { type: "integer", minimum: 60, maximum: 3600 } } },
  },
  "karryam.governance.approval.decide": {
    risk: "R2", description: "Approve or reject a proposed approval as an independent second staff member with recent MFA (local record; no source call)",
    schema: { type: "object", additionalProperties: false, required: ["approval_id", "decision"], properties: {
      approval_id: { type: "string", format: "uuid" }, decision: { type: "string", enum: ["APPROVE", "REJECT"] } } },
  },
});
const validateLocal = Object.fromEntries(Object.entries(LOCAL).map(([id, l]) => [id, contracts.compile(l.schema)]));

// Readback: GET <command path>/{x} where body[x] names the original operation.
const READBACK = (() => {
  const gets = R.CAPABILITIES.filter((c) => c.method === "GET");
  const out = new Map();
  for (const c of R.CAPABILITIES.filter((x) => x.kind === "COMMAND" || x.kind === "RETRIEVAL")) {
    const rb = gets.find((g) => g.path_params.length === 1 && g.path.startsWith(c.path + "/{") && g.path.split("/").length === c.path.split("/").length + 1);
    if (rb) out.set(c.id, { capability: rb, field: rb.path_params[0].name });
  }
  return out;
})();

function localCapabilities() {
  return Object.entries(LOCAL).map(([id, l]) => ({
    id, version: "1.0.0", kind: "COMMAND", state: "AVAILABLE", risk: l.risk, description: l.description, datasets: [], blockers: [],
    requires_recent_mfa: true, requires_independent_approval: false, request_schema: l.schema,
  }));
}

function withinScope(requested, delegated) {
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) return false;
  if (!delegated || typeof delegated !== "object" || Array.isArray(delegated)) return false;
  const required = new Set(["market", "organization", ...Object.keys(delegated)]);
  for (const dim of required) if (!Array.isArray(requested[dim]) || requested[dim].length === 0) return false;
  return Object.entries(requested).every(([dim, values]) => Array.isArray(values) && values.length > 0 && Array.isArray(delegated[dim]) && values.every((v) => delegated[dim].includes(v)));
}

// Source result -> settled status. Only explicit owner evidence settles.
function settle(result) {
  const status = result && typeof result === "object" ? result.status : undefined;
  if (status === undefined) return { status: "SUCCEEDED", sourceStatus: "ACCEPTED_RECORD_RETURNED" };
  if (["CONFIRMED", "APPROVED", "CONSUMED", "COMPLETED"].includes(status)) return { status: "SUCCEEDED", sourceStatus: status };
  if (["REJECTED", "FAILED_TERMINAL", "EXPIRED", "CANCELLED_WHEN_SAFE"].includes(status)) return { status: "FAILED", sourceStatus: status };
  return { status: "UNKNOWN_OUTCOME", sourceStatus: status };
}

function evidenceOf(res, sourceStatus) {
  const r = res.result && typeof res.result === "object" ? res.result : {};
  const version = Number.isSafeInteger(r.source_version) ? r.source_version : Number.isSafeInteger(r.receipt && r.receipt.recorded_version) ? r.receipt.recorded_version : null;
  return { source_status: sourceStatus, source_version: version, observed_at: res.asOf, bridge_correlation_id: res.bridgeCorrelationId, bridge_capability_id: res.capability.id };
}

function createOperations({ config, catalog, operations, approvals, bridgeClient, now = Date.now, logger = () => {} }) {
  const findCapability = (id) => catalog.capabilities.find((c) => c.id === id) || null;

  function auditBase(ctx, cap, outcome, reasonCode, extra = {}) {
    return { correlation_id: ctx.correlationId, request_id: ctx.requestId, endpoint: "operationSubmit", method: "POST", service_id: ctx.service.serviceId,
      staff_ref: ctx.delegation.sub, action: "operation.submit", outcome, reason_code: reasonCode, metadata: { capability_id: cap.id, risk: cap.risk, ...extra } };
  }

  function view(op, extra = {}) {
    return {
      operation_id: op.operation_id, capability_id: op.capability_id, status: op.status, reason_code: op.reason_code, created_at: op.created_at, updated_at: op.updated_at,
      executed: op.status === "SUCCEEDED", outcome_known: ["SUCCEEDED", "FAILED", "REJECTED"].includes(op.status),
      source_status: op.source_status, source_version: op.source_version, evidence: op.outcome_evidence, approval_ref: op.approval_ref, ...extra,
    };
  }

  async function reject(ctx, cap, command, reasonCode, code = "DISABLED") {
    const outcome = await operations.recordRejection({
      id: command.command_id, serviceId: ctx.service.serviceId, idempotencyKey: command.idempotency_key, requestDigest: contracts.digestOf(command),
      capabilityId: cap.id, staffRef: ctx.delegation.sub, reasonCode,
    }, auditBase(ctx, cap, "OPERATION_REJECTED", reasonCode));
    if (outcome.kind === "KEY_CONFLICT") throw new P("CONFLICT", "IDEMPOTENCY_KEY_REUSED");
    if (outcome.kind === "COMMAND_CONFLICT") throw new P("CONFLICT", "COMMAND_ID_REUSED");
    const prior = outcome.operation;
    if (prior.status !== "REJECTED") return { body: contracts.okEnvelope({ productId: config.productId, correlationId: ctx.correlationId, result: view(prior, { replay: true }) }, now()) };
    const priorCode = prior.reason_code === "CAPABILITY_BLOCKED_POLICY" ? "BLOCKED_POLICY" : code;
    throw new P(priorCode, prior.reason_code, { operationId: prior.operation_id, retryable: false });
  }

  function single(scope, dim) {
    return Array.isArray(scope[dim]) && scope[dim].length === 1 ? scope[dim][0] : null;
  }

  // Server-bound body fields must equal the command's own values. The
  // source operation identity (operation_id, request_id, or the field the
  // readback route is keyed by) is always the command ID, so a readback of
  // the original operation is possible after an uncertain outcome.
  function bindingErrors(body, command, nowMs, sourceId) {
    const readback = READBACK.get(sourceId);
    const idField = ["operation_id", "request_id"].find((f) => Object.prototype.hasOwnProperty.call(body, f)) ||
      (readback && Object.prototype.hasOwnProperty.call(body, readback.field) ? readback.field : null);
    if (idField && body[idField] !== command.command_id) return "BODY_FIELD_NOT_BOUND:" + idField;
    const checks = {
      idempotency_key: command.idempotency_key,
      reason_code: command.reason_code,
      expected_version: command.target.expected_version,
      case_ref: command.case_reference || "",
    };
    for (const [field, expected] of Object.entries(checks)) {
      if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== expected) return "BODY_FIELD_NOT_BOUND:" + field;
    }
    if (Object.prototype.hasOwnProperty.call(body, "requested_at") && Math.abs(Date.parse(body.requested_at) - nowMs) > REQUESTED_AT_SKEW_MS) return "BODY_FIELD_NOT_BOUND:requested_at";
    return null;
  }

  async function submitLocal(ctx, cap, command) {
    if (!validateLocal[cap.id](command.params).valid) throw new P("INVALID_REQUEST", "PARAMS_INVALID");
    const mfaAt = ctx.delegation.mfa_at;
    const nowS = Math.floor(now() / 1000);
    if (!Number.isInteger(mfaAt) || nowS - mfaAt > 300 || mfaAt > nowS + 5) throw new P("FORBIDDEN", "RECENT_MFA_REQUIRED");
    const intent = await operations.recordIntent({
      id: command.command_id, serviceId: ctx.service.serviceId, idempotencyKey: command.idempotency_key, requestDigest: contracts.digestOf(command), capabilityId: cap.id,
      staffRef: ctx.delegation.sub, risk: cap.risk, intentDigest: contracts.digestOf({ capability: cap.id, params: command.params, scope: command.scope, staff: ctx.delegation.sub }),
      scope: command.scope, requestReasonCode: command.reason_code, caseReference: command.case_reference,
    }, auditBase(ctx, cap, "OPERATION_RECORDED", null));
    if (intent.kind === "KEY_CONFLICT") throw new P("CONFLICT", "IDEMPOTENCY_KEY_REUSED");
    if (intent.kind === "COMMAND_CONFLICT") throw new P("CONFLICT", "COMMAND_ID_REUSED");
    if (intent.kind === "REPLAY") return { body: contracts.okEnvelope({ productId: config.productId, correlationId: ctx.correlationId, result: view(intent.operation, { replay: true }) }, now()) };
    const op = await operations.transition(command.command_id, "RECORDED", "DISPATCHING", {}, null);
    let result;
    try {
      if (cap.id === "karryam.governance.approval.propose") {
        const target = findCapability(command.params.capability_id);
        if (!target || target.kind !== "COMMAND" || LOCAL[target.id]) throw new ApprovalError("APPROVAL_TARGET_INVALID");
        result = await approvals.propose({ id: command.command_id, capabilityId: target.id, intentDigest: command.params.intent_digest, scope: command.scope, requestedBy: ctx.delegation.sub, ttlSeconds: command.params.ttl_seconds });
      } else {
        result = await approvals.decide({ id: command.params.approval_id, decidedBy: ctx.delegation.sub, approve: command.params.decision === "APPROVE", mfaAt });
      }
    } catch (err) {
      const reason = err instanceof ApprovalError ? err.reason : "APPROVAL_STORE_UNAVAILABLE";
      await operations.transition(op.operation_id, "DISPATCHING", "FAILED", { reasonCode: reason }, auditBase(ctx, cap, "OPERATION_FAILED", reason));
      throw new P(err instanceof ApprovalError ? "CONFLICT" : "UNAVAILABLE", reason, { operationId: op.operation_id, retryable: !(err instanceof ApprovalError) });
    }
    const done = await operations.transition(op.operation_id, "DISPATCHING", "SUCCEEDED", { sourceStatus: result.status, evidence: { approval_id: result.approval_id, status: result.status, expires_at: result.expires_at } }, auditBase(ctx, cap, "OPERATION_SUCCEEDED", null));
    return { body: contracts.okEnvelope({ productId: config.productId, correlationId: ctx.correlationId, result: view(done, { approval: result }) }, now()) };
  }

  async function submit(ctx) {
    if (!ctx.body || !validateCommand(ctx.body).valid) throw new P("INVALID_REQUEST", "COMMAND_INVALID");
    if (!ctx.delegation || ctx.delegation.action !== "operation.submit") throw new P("FORBIDDEN", "DELEGATION_ACTION_MISMATCH");
    const command = ctx.body;
    if (!withinScope(command.scope, ctx.delegation.scope)) throw new P("FORBIDDEN", "SCOPE_DENIED");
    const cap = findCapability(command.capability_id);
    if (!cap) throw new P("NOT_FOUND", "UNKNOWN_CAPABILITY");
    if (cap.kind !== "COMMAND") throw new P("INVALID_REQUEST", "CAPABILITY_NOT_COMMAND");
    if (LOCAL[cap.id]) return submitLocal(ctx, cap, command);
    if (cap.state !== "AVAILABLE") return reject(ctx, cap, command, cap.state === "BLOCKED_POLICY" ? "CAPABILITY_BLOCKED_POLICY" : "CAPABILITY_DISABLED", cap.state === "BLOCKED_POLICY" ? "BLOCKED_POLICY" : "DISABLED");

    // Re-check exposure against live configuration (defence in depth).
    const source = R.capability(cap.id.slice("karryam.".length));
    if (!source || commandExposure(source, config).state !== "AVAILABLE") return reject(ctx, cap, command, "CAPABILITY_DISABLED");
    if (!bridgeClient) return reject(ctx, cap, command, "BRIDGE_TRUST_NOT_ENROLLED", "UNAVAILABLE");
    const params = command.params || {};
    if (!params || typeof params.body !== "object" || Array.isArray(params.body) || Object.keys(params).some((k) => !["body", "approval_ref"].includes(k))) throw new P("INVALID_REQUEST", "PARAMS_INVALID");
    if (params.approval_ref !== undefined && !UUID.test(String(params.approval_ref))) throw new P("INVALID_REQUEST", "PARAMS_INVALID");
    const scope = { market: single(command.scope, "market"), organization: single(command.scope, "organization"), zone: single(command.scope, "zone"), tenant: single(command.scope, "tenant") };
    if (!scope.market || !scope.organization || (R.needsZoneTenant(source) && (!scope.zone || !scope.tenant))) throw new P("INVALID_REQUEST", "SINGLE_EXACT_SCOPE_REQUIRED");
    if (scope.market !== config.bridge.market || scope.organization !== config.bridge.organization) throw new P("FORBIDDEN", "SCOPE_NOT_ENROLLED");
    let staff;
    try { staff = bridgeStaffContext(ctx.delegation, config.bridge, Math.floor(now() / 1000), R.needsZoneTenant(source) ? { zone: scope.zone, tenant: scope.tenant } : {}); }
    catch (err) { throw new P("FORBIDDEN", err instanceof StaffContextError ? err.reason : "STAFF_CONTEXT_INVALID"); }
    if (source.request_body && !R.validateBody(source, params.body).valid) throw new P("INVALID_REQUEST", "BODY_DOES_NOT_MATCH_SOURCE_CONTRACT");
    const bound = bindingErrors(params.body, command, now(), source.id);
    if (bound) throw new P("INVALID_REQUEST", bound.split(":")[0]);
    const pathParams = {};
    if (source.path_params.length === 1) pathParams[source.path_params[0].name] = command.target.id;
    else if (source.path_params.length > 1) throw new P("INVALID_REQUEST", "UNSUPPORTED_COMMAND_SHAPE");
    const approvalRequired = cap.requires_independent_approval;
    if (approvalRequired && !params.approval_ref) throw new P("FORBIDDEN", "INDEPENDENT_APPROVAL_REQUIRED");
    const intentDigest = contracts.digestOf({ capability: cap.id, target: command.target, body: params.body, scope, staff: ctx.delegation.sub });

    // 4. Intent + audit before any source call.
    const intent = await operations.recordIntent({
      id: command.command_id, serviceId: ctx.service.serviceId, idempotencyKey: command.idempotency_key, requestDigest: contracts.digestOf(command), capabilityId: cap.id,
      staffRef: ctx.delegation.sub, risk: cap.risk, bridgeCapabilityId: source.id, intentDigest, scope, requestReasonCode: command.reason_code,
      caseReference: command.case_reference, expectedVersion: command.target.expected_version, approvalRef: params.approval_ref || null,
    }, auditBase(ctx, cap, "OPERATION_RECORDED", null, { bridge_capability: source.id }));
    if (intent.kind === "KEY_CONFLICT") throw new P("CONFLICT", "IDEMPOTENCY_KEY_REUSED");
    if (intent.kind === "COMMAND_CONFLICT") throw new P("CONFLICT", "COMMAND_ID_REUSED");
    if (intent.kind === "REPLAY") {
      // A retried submission never dispatches again; it reports the original.
      return { body: contracts.okEnvelope({ productId: config.productId, correlationId: ctx.correlationId, result: view(intent.operation, { replay: true }) }, now()) };
    }
    if (params.approval_ref) {
      try {
        await approvals.consume({ id: params.approval_ref, operationId: command.command_id, capabilityId: cap.id, intentDigest, scope: command.scope, requestedBy: ctx.delegation.sub });
      } catch (err) {
        const reason = err instanceof ApprovalError ? err.reason : "APPROVAL_STORE_UNAVAILABLE";
        await operations.transition(command.command_id, "RECORDED", "REJECTED", { reasonCode: reason }, auditBase(ctx, cap, "OPERATION_REJECTED", reason));
        throw new P(err instanceof ApprovalError ? "FORBIDDEN" : "UNAVAILABLE", reason, { operationId: command.command_id, retryable: false });
      }
    }
    const dispatching = await operations.transition(command.command_id, "RECORDED", "DISPATCHING", {}, auditBase(ctx, cap, "OPERATION_DISPATCHED", null));
    if (!dispatching) throw new P("CONFLICT", "OPERATION_ALREADY_DISPATCHED", { operationId: command.command_id });

    // 5. Exactly one dispatch.
    let next;
    try {
      const res = await bridgeClient.call(source.id, { staff, query: { market: scope.market, organization: scope.organization, purpose: command.reason_code.toLowerCase(), ...(R.needsZoneTenant(source) ? { zone: scope.zone, tenant: scope.tenant } : {}), ...(R.SHAPE_PARAMS[source.query_shape].includes("start") ? { start: new Date(now() - 3600000).toISOString(), end: new Date(now()).toISOString(), limit: 1 } : {}) }, pathParams, body: params.body });
      const s = settle(res.result);
      next = { status: s.status, fields: { sourceStatus: s.sourceStatus, sourceVersion: evidenceOf(res, s.sourceStatus).source_version, evidence: evidenceOf(res, s.sourceStatus), reasonCode: s.status === "SUCCEEDED" ? "SOURCE_CONFIRMED" : s.status === "FAILED" ? "SOURCE_REJECTED" : "AWAITING_OWNER_EVIDENCE" } };
    } catch (err) {
      const mapped = protocolMapping(err);
      next = err.unknownOutcome
        ? { status: "UNKNOWN_OUTCOME", fields: { reasonCode: "UNKNOWN_OUTCOME", evidence: { dispatch_error: err.category } } }
        : { status: "FAILED", fields: { reasonCode: mapped.reason, evidence: { dispatch_error: err.category, source_operation_id: err.operationId || null } } };
      logger({ event: "operation_dispatch_failed", capability: source.id, category: err.category || "UNKNOWN", correlation_id: ctx.correlationId });
    }
    const final = await operations.transition(command.command_id, "DISPATCHING", next.status, next.fields, auditBase(ctx, cap, "OPERATION_" + next.status, next.fields.reasonCode));
    return { body: contracts.okEnvelope({ productId: config.productId, correlationId: ctx.correlationId, result: view(final || dispatching) }, now()) };
  }

  // Authoritative readback of an unsettled operation. Never resubmits.
  async function readback(ctx, op) {
    let current = op;
    if (current.status === "DISPATCHING" && now() - Date.parse(current.dispatched_at || current.updated_at) > STALE_DISPATCH_MS) {
      current = (await operations.transition(op.operation_id, "DISPATCHING", "UNKNOWN_OUTCOME", { reasonCode: "DISPATCH_INTERRUPTED" }, null)) || await operations.get(op.operation_id);
    }
    if (current.status !== "UNKNOWN_OUTCOME") return { operation: current, readback: null };
    const rb = READBACK.get(current.bridge_capability_id);
    if (!rb || !bridgeClient) return { operation: current, readback: { state: "NO_READBACK_CONTRACT" } };
    const scope = current.scope || {};
    let staff;
    try { staff = bridgeStaffContext(ctx.delegation, config.bridge, Math.floor(now() / 1000), R.needsZoneTenant(rb.capability) ? { zone: scope.zone, tenant: scope.tenant } : {}); }
    catch (err) { return { operation: current, readback: { state: "READBACK_REQUIRES_STAFF_CONTEXT", reason: err.reason || "STAFF_CONTEXT_INVALID" } }; }
    const query = { market: scope.market, organization: scope.organization, purpose: "operation_readback", ...(R.needsZoneTenant(rb.capability) ? { zone: scope.zone, tenant: scope.tenant } : {}), ...(R.SHAPE_PARAMS[rb.capability.query_shape].includes("start") ? { start: new Date(now() - 30 * 86400000).toISOString(), end: new Date(now()).toISOString(), limit: 1 } : {}) };
    let res;
    try { res = await bridgeClient.call(rb.capability.id, { staff, query, pathParams: { [rb.field]: current.operation_id } }); }
    catch (err) { return { operation: current, readback: { state: "READBACK_UNAVAILABLE", reason: protocolMapping(err).reason } }; }
    const s = settle(res.result);
    const evidence = evidenceOf(res, s.sourceStatus);
    if (s.status === "UNKNOWN_OUTCOME") {
      await operations.noteReadback(current.operation_id, evidence);
      return { operation: await operations.get(current.operation_id), readback: { state: "STILL_UNKNOWN", source_status: s.sourceStatus } };
    }
    const settled = await operations.transition(current.operation_id, "UNKNOWN_OUTCOME", s.status, { sourceStatus: s.sourceStatus, sourceVersion: evidence.source_version, evidence, reasonCode: s.status === "SUCCEEDED" ? "SOURCE_CONFIRMED_BY_READBACK" : "SOURCE_REJECTED_BY_READBACK" },
      { correlation_id: ctx.correlationId, request_id: ctx.requestId, endpoint: "operationGet", method: "GET", service_id: ctx.service.serviceId, staff_ref: ctx.delegation.sub, action: "operation.read", outcome: "OPERATION_" + s.status, reason_code: "READBACK", metadata: { capability_id: current.capability_id } });
    return { operation: settled || await operations.get(current.operation_id), readback: { state: "SETTLED_BY_READBACK", source_status: s.sourceStatus } };
  }

  return { submit, readback, view, localCapabilities };
}

module.exports = { createOperations, localCapabilities, withinScope, settle, READBACK, LOCAL };
