"use strict";

// Universal Product Admin Protocol v1 — wire constants shared by every
// Product Admin and by Headquarters. Nothing here is product-specific.

const PROTOCOL_NAME = "cosmicforge.product-admin";
// 1.1 (additive): scoped resource and report reads (resourceList,
// resourceGet, reportGet). A 1.0 Product Admin simply does not offer them.
const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 1 });
const CONTRACT_VERSION = "1.0";
const BASE_PATH = "/internal/product-admin/v1";
const MANIFEST_SCHEMA = "cosmicforge.product-admin.manifest/v1";

const PATTERNS = Object.freeze({
  productId: "^[a-z][a-z0-9-]{1,31}$",
  serviceInstanceId: "^[a-z0-9][a-z0-9.-]{2,63}$",
  catalogId: "^[a-z][a-z0-9_.-]{1,95}$",
  pathParam: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
  scopeValue: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$",
  keyId: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$",
  workloadIdentity: "^(?:spiffe|cf)://[a-z0-9.-]{1,63}(?:/[A-Za-z0-9._-]{1,63}){1,6}$",
  semver: "^(?:0|[1-9][0-9]{0,3})\\.(?:0|[1-9][0-9]{0,3})\\.(?:0|[1-9][0-9]{0,3})$",
  digest: "^sha256:[0-9a-f]{64}$",
  buildSha: "^[0-9a-f]{7,64}$",
  currency: "^[A-Z]{3}$",
  department: "^[a-z][a-z0-9-]{1,47}$",
  code: "^[A-Z][A-Z0-9_]{2,63}$",
  unit: "^[a-z][a-z0-9_]{0,31}$",
  fieldName: "^[a-z][a-z0-9_]{0,63}$",
  partitionKey: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
  correlationId: "^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$",
});

const ENVIRONMENTS = Object.freeze(["test", "development", "staging", "production"]);
const CAPABILITY_STATES = Object.freeze(["AVAILABLE", "READ_ONLY", "DISABLED", "BLOCKED_POLICY", "BLOCKED_DEPENDENCY", "UNAVAILABLE"]);
// Only these states may ever be acted upon, and only after HQ certification.
const USABLE_CAPABILITY_STATES = Object.freeze(["AVAILABLE", "READ_ONLY"]);
const CAPABILITY_KINDS = Object.freeze(["METADATA", "READ", "COMMAND"]);
const RISK_LEVELS = Object.freeze(["R0", "R1", "R2", "R3", "R4"]);
const FRESHNESS = Object.freeze(["FRESH", "STALE", "UNKNOWN"]);
const COVERAGE = Object.freeze(["COMPLETE", "PARTIAL", "NONE", "UNKNOWN"]);
const PRIVACY_CLASSES = Object.freeze(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED_PII"]);
// Restricted personal data never crosses into Headquarters projections.
const HQ_SYNCABLE_PRIVACY = Object.freeze(["PUBLIC", "INTERNAL", "CONFIDENTIAL"]);
const SCOPE_DIMENSIONS = Object.freeze(["market", "organization", "zone", "tenant"]);
const GRAINS = Object.freeze(["EVENT", "HOUR", "DAY", "WEEK", "MONTH", "SNAPSHOT"]);
const AGGREGATIONS = Object.freeze(["SUM", "COUNT", "AVG", "RATIO", "MIN", "MAX", "GAUGE"]);
const DATASET_READINESS = Object.freeze(["CERTIFIED_BY_PRODUCT", "PROPOSED", "NOT_CERTIFIED", "BLOCKED"]);
const EVENT_FAMILY_STATUS = Object.freeze(["ACTIVE", "DEPRECATED", "NOT_CERTIFIED"]);
const PROJECTIONS = Object.freeze(["METRIC_OBSERVATION", "NONE"]);
const VALUE_STATES = Object.freeze(["OBSERVED", "UNAVAILABLE"]);
const FIELD_TYPES = Object.freeze(["string", "integer", "number", "boolean", "date-time"]);

// Stable error codes with their default HTTP status. Reasons are free-form
// SCREAMING_SNAKE codes (e.g. SOURCE_NOT_CERTIFIED) and never carry data.
const ERROR_CODES = Object.freeze({
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  INVALID_REQUEST: 400,
  DISABLED: 403,
  BLOCKED_POLICY: 403,
  UNAVAILABLE: 503,
  CONTRACT_MISMATCH: 502,
  INTERNAL: 500,
});

// Fixed endpoint table. Clients build paths only from this table; a manifest
// or response can never introduce another path or destination.
const ENDPOINTS = Object.freeze({
  manifest: Object.freeze({ method: "GET", path: "/manifest", auth: "service" }),
  healthLive: Object.freeze({ method: "GET", path: "/health/live", auth: "none" }),
  healthReady: Object.freeze({ method: "GET", path: "/health/ready", auth: "none" }),
  capabilities: Object.freeze({ method: "GET", path: "/capabilities", auth: "service" }),
  datasets: Object.freeze({ method: "GET", path: "/datasets", auth: "service" }),
  datasetSnapshots: Object.freeze({ method: "GET", path: "/datasets/{datasetId}/snapshots", auth: "service" }),
  events: Object.freeze({ method: "GET", path: "/events", auth: "service" }),
  eventsAck: Object.freeze({ method: "POST", path: "/events/ack", auth: "service" }),
  syncStatus: Object.freeze({ method: "GET", path: "/sync/status", auth: "service" }),
  operationGet: Object.freeze({ method: "GET", path: "/operations/{operationId}", auth: "service+delegation" }),
  operationSubmit: Object.freeze({ method: "POST", path: "/operations", auth: "service+delegation" }),
  auditGet: Object.freeze({ method: "GET", path: "/audit/{operationId}", auth: "service+delegation" }),
  // Protocol 1.1: staff-delegated, scoped reads of one READ capability's
  // collection, one resource of it, or one product report.
  resourceList: Object.freeze({ method: "GET", path: "/resources/{capabilityId}/{collectionId}", auth: "service+delegation", since: "1.1" }),
  resourceGet: Object.freeze({ method: "GET", path: "/resources/{capabilityId}/{collectionId}/{resourceId}", auth: "service+delegation", since: "1.1" }),
  reportGet: Object.freeze({ method: "GET", path: "/reports/{reportId}", auth: "service+delegation", since: "1.1" }),
});

// Query keys HQ may forward for 1.1 reads (exact allowlist; values are
// validated again by the Product Admin against its own source contract).
const RESOURCE_QUERY = Object.freeze(["market", "organization", "zone", "tenant", "purpose", "start", "end", "limit", "continuation"]);
const REPORT_QUERY = Object.freeze(["market", "organization", "zone", "tenant", "purpose", "start", "end", "timezone", "authority", "product_code"]);
const READ_QUERY_SCHEMAS = Object.freeze({
  market: { type: "string", pattern: PATTERNS.scopeValue },
  organization: { type: "string", pattern: PATTERNS.scopeValue },
  zone: { type: "string", pattern: PATTERNS.scopeValue },
  tenant: { type: "string", pattern: PATTERNS.scopeValue },
  purpose: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$" },
  start: { type: "string", format: "date-time" },
  end: { type: "string", format: "date-time" },
  limit: { type: "integer", minimum: 1, maximum: 100 },
  continuation: { type: "string", pattern: "^[A-Za-z0-9_-]{16,2048}$" },
  timezone: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_+/-]{0,63}$" },
  authority: { type: "string", pattern: "^[A-Z][A-Z_]{1,31}$" },
  product_code: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$" },
});

// True when a contract's protocol version offers this endpoint.
function endpointSupported(endpointId, protocol) {
  const endpoint = ENDPOINTS[endpointId];
  if (!endpoint || !protocol) return false;
  if (!endpoint.since) return true;
  const [major, minor] = endpoint.since.split(".").map(Number);
  return protocol.major === major && protocol.minor >= minor;
}

const PATH_PARAM = new RegExp(PATTERNS.pathParam);

function endpointPath(endpointId, params = {}) {
  const endpoint = ENDPOINTS[endpointId];
  if (!endpoint) throw new Error("unknown_endpoint");
  const path = endpoint.path.replace(/\{([A-Za-z]+)\}/g, (_, name) => {
    const value = params[name];
    if (typeof value !== "string" || !PATH_PARAM.test(value)) throw new Error("invalid_path_param:" + name);
    return value;
  });
  return BASE_PATH + path;
}

// Matches an incoming pathname against the fixed table (server side).
function matchEndpoint(method, pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith(BASE_PATH + "/")) return null;
  const rest = pathname.slice(BASE_PATH.length);
  for (const [id, endpoint] of Object.entries(ENDPOINTS)) {
    const names = [];
    const source = "^" + endpoint.path.replace(/\{([A-Za-z]+)\}/g, (_, name) => { names.push(name); return "([^/]+)"; }) + "$";
    const match = new RegExp(source).exec(rest);
    if (!match) continue;
    const params = {};
    for (let i = 0; i < names.length; i += 1) {
      if (!PATH_PARAM.test(match[i + 1])) return { id, endpoint, params: null, methodAllowed: endpoint.method === method };
      params[names[i]] = match[i + 1];
    }
    return { id, endpoint, params, methodAllowed: endpoint.method === method };
  }
  return null;
}

function isSupportedProtocol(protocol, supported = PROTOCOL_VERSION) {
  return Boolean(protocol) && Number.isInteger(protocol.major) && Number.isInteger(protocol.minor) &&
    // A minor newer than this HQ understands is an unknown contract: rejected.
    protocol.major === supported.major && protocol.minor >= 0 && protocol.minor <= supported.minor;
}

module.exports = {
  PROTOCOL_NAME, PROTOCOL_VERSION, CONTRACT_VERSION, BASE_PATH, MANIFEST_SCHEMA, PATTERNS,
  ENVIRONMENTS, CAPABILITY_STATES, USABLE_CAPABILITY_STATES, CAPABILITY_KINDS, RISK_LEVELS,
  FRESHNESS, COVERAGE, PRIVACY_CLASSES, HQ_SYNCABLE_PRIVACY, SCOPE_DIMENSIONS, GRAINS,
  AGGREGATIONS, DATASET_READINESS, EVENT_FAMILY_STATUS, PROJECTIONS, VALUE_STATES, FIELD_TYPES,
  ERROR_CODES, ENDPOINTS, endpointPath, matchEndpoint, isSupportedProtocol,
  RESOURCE_QUERY, REPORT_QUERY, READ_QUERY_SCHEMAS, endpointSupported,
};
