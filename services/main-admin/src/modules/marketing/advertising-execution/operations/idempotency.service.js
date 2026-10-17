const crypto = require("crypto");
const { executionError } = require("../execution.errors");
const { canonicalJson, hashExecutionJson } = require("../execution-json.validator");

const REQUIRED_FIELDS = ["version", "provider", "connectionId", "accountExternalId", "approvedPlanId", "approvedPlanVersion", "itemId", "operationType", "resourceType", "materialHash"];

function operationIdentity(input) {
  const normalized = {
    version: Number(input.version ?? 2), provider: String(input.provider || "").trim().toUpperCase(),
    connectionId: String(input.connectionId || "").trim().toLowerCase(), accountExternalId: String(input.accountExternalId || "").trim(),
    approvedPlanId: String(input.approvedPlanId || "").trim().toLowerCase(), approvedPlanVersion: Number(input.approvedPlanVersion),
    itemId: String(input.itemId || "").trim().toLowerCase(), operationType: String(input.operationType || "").trim().toUpperCase(),
    resourceType: String(input.resourceType || "").trim().toUpperCase(), materialHash: String(input.materialHash || "").trim().toLowerCase(),
  };
  for (const field of REQUIRED_FIELDS) if (normalized[field] === "" || normalized[field] == null || Number.isNaN(normalized[field])) throw executionError("INVALID_EXECUTION_PLAN", { field, reasonCode: "IDEMPOTENCY_FIELD_REQUIRED" });
  if (!Number.isInteger(normalized.version) || normalized.version < 1 || !Number.isInteger(normalized.approvedPlanVersion) || normalized.approvedPlanVersion < 1) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "INVALID_IDEMPOTENCY_VERSION" });
  if (!/^[a-f0-9]{64}$/.test(normalized.materialHash)) throw executionError("INVALID_EXECUTION_PLAN", { field: "materialHash", reasonCode: "INVALID_MATERIAL_HASH" });
  return Object.freeze(normalized);
}

function createProviderOperationKey(input) {
  const identity = operationIdentity(input);
  return crypto.createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex");
}

function assertBeforeStateCurrent({ approvedHash, currentState }) {
  const currentHash = hashExecutionJson(currentState, "beforeState").hash;
  if (!approvedHash || approvedHash !== currentHash) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "PROVIDER_BEFORE_STATE_CHANGED", approvedHash: approvedHash || null, currentHash });
  return currentHash;
}

module.exports = { REQUIRED_FIELDS, operationIdentity, createProviderOperationKey, assertBeforeStateCurrent };
