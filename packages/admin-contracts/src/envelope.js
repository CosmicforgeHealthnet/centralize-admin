"use strict";

const { randomUUID } = require("node:crypto");
const P = require("./protocol");
const { compile } = require("./validator");
const { responseEnvelope, metricObservationPayload } = require("./schemas");

const validateShape = compile(responseEnvelope);
const validateMetricShape = compile(metricObservationPayload);
const CLOCK_SKEW_MS = 60 * 1000;

class ProtocolError extends Error {
  constructor(code, reason, { status, retryable = false, operationId } = {}) {
    super(code + ":" + reason);
    this.name = "ProtocolError";
    this.code = code;
    this.reason = reason;
    this.status = status || P.ERROR_CODES[code] || 500;
    this.retryable = retryable;
    this.operationId = operationId;
  }
}

function newCorrelationId() {
  return randomUUID();
}

// Truthfulness rules shared by every Product Admin and by HQ:
//  - error responses carry no result;
//  - COMPLETE/PARTIAL coverage and FRESH/STALE freshness require a genuine
//    source observation time (`as_of`);
//  - `as_of` can never be in the future.
function truthfulnessErrors(envelope, now = Date.now()) {
  const errors = [];
  if (envelope.error && envelope.result !== null) errors.push("ERROR_WITH_RESULT");
  if (!envelope.error && envelope.result === null) errors.push("RESULT_MISSING");
  if (["COMPLETE", "PARTIAL"].includes(envelope.coverage) && !envelope.as_of) errors.push("COVERAGE_WITHOUT_OBSERVATION");
  if (["FRESH", "STALE"].includes(envelope.freshness) && !envelope.as_of) errors.push("FRESHNESS_WITHOUT_OBSERVATION");
  if (envelope.as_of && Date.parse(envelope.as_of) > now + CLOCK_SKEW_MS) errors.push("OBSERVATION_IN_FUTURE");
  return errors;
}

function validateEnvelope(envelope, { now = Date.now(), productId } = {}) {
  const shape = validateShape(envelope);
  if (!shape.valid) return { valid: false, errors: shape.errors.map((e) => e.keyword + "@" + e.path) };
  const errors = truthfulnessErrors(envelope, now);
  if (productId && envelope.product_id !== productId) errors.push("PRODUCT_MISMATCH");
  return { valid: errors.length === 0, errors };
}

function build(fields, now) {
  const envelope = {
    contract_version: P.CONTRACT_VERSION,
    product_id: fields.productId,
    correlation_id: fields.correlationId || newCorrelationId(),
    as_of: fields.asOf || null,
    freshness: fields.freshness || "UNKNOWN",
    coverage: fields.coverage || "UNKNOWN",
    result: fields.result === undefined ? null : fields.result,
    error: fields.error || null,
  };
  const check = validateEnvelope(envelope, { now });
  if (!check.valid) throw new Error("invalid_envelope:" + check.errors.join(","));
  return envelope;
}

// Success. Metadata-only results (catalogs, manifests) legitimately have no
// source observation, so freshness/coverage default to UNKNOWN.
function okEnvelope({ productId, correlationId, asOf = null, freshness = "UNKNOWN", coverage = "UNKNOWN", result }, now = Date.now()) {
  if (result === undefined || result === null) throw new Error("invalid_envelope:RESULT_MISSING");
  return build({ productId, correlationId, asOf, freshness, coverage, result }, now);
}

// Honest unavailability: never zero, never a blank success.
function errorEnvelope({ productId, correlationId, code, reason, retryable, operationId, asOf = null, freshness = "UNKNOWN", coverage = "UNKNOWN" }, now = Date.now()) {
  if (!P.ERROR_CODES[code]) throw new Error("unknown_error_code");
  const error = { code, reason };
  if (retryable !== undefined) error.retryable = Boolean(retryable);
  if (operationId) error.operation_id = operationId;
  return build({ productId, correlationId, asOf, freshness, coverage, error }, now);
}

function errorFrom(err, productId, correlationId) {
  if (err instanceof ProtocolError) {
    return { status: err.status, body: errorEnvelope({ productId, correlationId, code: err.code, reason: err.reason, retryable: err.retryable, operationId: err.operationId }) };
  }
  return { status: 500, body: errorEnvelope({ productId, correlationId, code: "INTERNAL", reason: "INTERNAL_ERROR", retryable: true }) };
}

// A metric value may only be OBSERVED when the source proved it.
function metricObservationErrors(observation) {
  const shape = validateMetricShape(observation);
  if (!shape.valid) return shape.errors.map((e) => e.keyword + "@" + e.path);
  const errors = [];
  if (observation.value_state === "OBSERVED") {
    if (observation.value === null) errors.push("OBSERVED_WITHOUT_VALUE");
    if (!observation.observed_at) errors.push("OBSERVED_WITHOUT_OBSERVATION_TIME");
    if (!["COMPLETE", "PARTIAL"].includes(observation.coverage)) errors.push("OBSERVED_WITHOUT_COVERAGE");
  } else if (observation.value !== null) {
    errors.push("UNAVAILABLE_WITH_VALUE");
  }
  if (Date.parse(observation.window_end) <= Date.parse(observation.window_start)) errors.push("WINDOW_INVALID");
  return errors;
}

module.exports = {
  ProtocolError, newCorrelationId, validateEnvelope, truthfulnessErrors, okEnvelope, errorEnvelope,
  errorFrom, metricObservationErrors,
};
