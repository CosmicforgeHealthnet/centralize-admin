const { PROVIDERS } = require("./execution.constants");
const { executionError } = require("./execution.errors");
const { inspectExecutionInput, assertAllowedKeys } = require("./security/execution-input-sanitizer");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[a-f0-9]{64}$/i;

function uuid(value, field, required = true) {
  if ((value == null || value === "") && !required) return undefined;
  if (!UUID.test(String(value || ""))) throw executionError("INVALID_EXECUTION_PLAN", { field, reasonCode: "INVALID_UUID" });
  return String(value).toLowerCase();
}
function textValue(value, field, { required = false, min = 0, max = 2000 } = {}) {
  if (value == null && !required) return undefined;
  const valueText = String(value || "").trim();
  if (valueText.length < Math.max(min, required ? 1 : 0) || valueText.length > max) throw executionError("INVALID_EXECUTION_PLAN", { field, reasonCode: "INVALID_TEXT_LENGTH" });
  return valueText;
}
function intValue(value, field, { required = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if ((value == null || value === "") && !required) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw executionError("INVALID_EXECUTION_PLAN", { field, reasonCode: "INVALID_INTEGER" });
  return parsed;
}
function boolValue(value, field) {
  if (value == null || value === "") return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw executionError("INVALID_EXECUTION_PLAN", { field, reasonCode: "INVALID_BOOLEAN" });
}
function enumValue(value, allowed, field, required = false) {
  if ((value == null || value === "") && !required) return undefined;
  const normalized = String(value).trim().toUpperCase();
  if (!allowed.includes(normalized)) throw executionError("INVALID_EXECUTION_PLAN", { field, reasonCode: "UNSUPPORTED_VALUE", allowed });
  return normalized;
}
function dateValue(value, field) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw executionError("INVALID_EXECUTION_PLAN", { field, reasonCode: "INVALID_DATE" });
  return parsed;
}
function fingerprint(value, field = "fingerprint", required = true) {
  if (!value && !required) return undefined;
  if (!FINGERPRINT.test(String(value || ""))) throw executionError("EXECUTION_PLAN_CONFLICT", { field, reasonCode: "INVALID_FINGERPRINT" });
  return String(value).toLowerCase();
}

function pagination(query, allowed) {
  inspectExecutionInput(query, { path: "query", maxString: 500 });
  assertAllowedKeys(query, allowed, "query");
  const page = intValue(query.page, "query.page", { min: 1, max: 1000000 }) || 1;
  const limit = intValue(query.limit, "query.limit", { min: 1, max: 100 }) || 25;
  const sortDirection = enumValue(query.sortDirection, ["ASC", "DESC"], "query.sortDirection") || "DESC";
  return { page, limit, skip: (page - 1) * limit, sortDirection: sortDirection.toLowerCase() };
}

function capabilityQuery(query) {
  const allowed = ["provider", "connectionId", "accountExternalId", "objective", "campaignType", "operationType", "resourceType", "creativeFormat"];
  inspectExecutionInput(query, { path: "query" }); assertAllowedKeys(query, allowed, "query");
  const provider = enumValue(query.provider, PROVIDERS, "query.provider", false);
  const connectionId = uuid(query.connectionId, "query.connectionId", false);
  const accountExternalId = textValue(query.accountExternalId, "query.accountExternalId", { max: 255 });
  if ([connectionId, accountExternalId].filter(Boolean).length === 1) throw executionError("INVALID_EXECUTION_PLAN", { field: "query", reasonCode: "CONNECTION_AND_ACCOUNT_REQUIRED_TOGETHER" });
  return { provider, connectionId, accountExternalId, objective: textValue(query.objective, "query.objective", { max: 100 }), campaignType: textValue(query.campaignType, "query.campaignType", { max: 100 }), operationType: query.operationType, resourceType: query.resourceType, creativeFormat: textValue(query.creativeFormat, "query.creativeFormat", { max: 100 }) };
}

function body(value, allowed, required = []) {
  inspectExecutionInput(value, { path: "body" }); assertAllowedKeys(value, allowed, "body");
  for (const key of required) if (value[key] == null || value[key] === "") throw executionError("INVALID_EXECUTION_PLAN", { field: `body.${key}`, reasonCode: "REQUIRED" });
  return value;
}

module.exports = { UUID, FINGERPRINT, uuid, textValue, intValue, boolValue, enumValue, dateValue, fingerprint, pagination, capabilityQuery, body };
