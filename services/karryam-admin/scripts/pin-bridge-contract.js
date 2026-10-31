"use strict";

// Generates the pinned, reviewed Karryam Backoffice Bridge capability
// registry from a KarryGo checkout. Nothing is guessed: every method, path,
// query parameter, path parameter, request body schema and result schema is
// copied from the source OpenAPI and capability matrix.
//
//   KARRYGO_CHECKOUT=/path/to/KarryGo node scripts/pin-bridge-contract.js [--write]
//
// Without --write it only reports whether the committed files match the
// checkout (exit 1 on drift). Re-pinning is a reviewed change: the output is
// committed and the contract test compares it against the source again.

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const OPENAPI_DIR = "services/admin-backoffice-service/docs/openapi";
const BRIDGE_BASE = "/internal/karryam-admin/v1";
const OUT_DIR = path.join(__dirname, "..", "src", "bridge", "contracts");
const REGISTRY_FILE = path.join(OUT_DIR, "karrygo-capabilities.v1.json");
const SCHEMAS_FILE = path.join(OUT_DIR, "karrygo-bridge-schemas.v1.json");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Capability ID prefix -> inventory module. Every capability belongs to
// exactly one inventory module so coverage is never double counted.
const MODULE_BY_PREFIX = Object.freeze({
  customer: "customer", taxi: "taxi", dispatch: "dispatch", hauling: "hauling", fleet: "fleet",
  vendor: "vendor", wallet: "wallet", pricing: "pricing", referral: "referral",
  verification: "verification", support: "support", media: "media", analytics: "analytics",
  hq: "governance", campaigns: "marketing", finance: "finance",
  bridge: "platform", overview: "platform", search: "platform", entities: "platform",
  operations: "platform", events: "platform", exports: "platform",
});

// Reviewed classification of every non-GET capability. GET is always READ.
//  READ       read-oriented contract that the source exposes as POST
//  RETRIEVAL  sensitive single-use content/evidence retrieval (governed)
//  SYNC       Stage A event pipeline only (never staff-facing)
//  COMMAND    anything that changes source or Bridge state
const NON_GET_KIND = Object.freeze({
  "hq.finance.report": "READ",
  "hq.media.legacy-mapping": "READ",
  "media.case.content.read": "RETRIEVAL",
  "hq.exports.download": "RETRIEVAL",
  "hq.events.ack": "SYNC",
});
const SYNC_READS = new Set(["hq.events.feed"]);

function kindOf(cap) {
  if (cap.method === "GET") return SYNC_READS.has(cap.id) ? "SYNC" : "READ";
  return NON_GET_KIND[cap.id] || "COMMAND";
}

function queryShape(names) {
  const key = names.join(",");
  const shapes = {
    "market,organization,purpose": "BASE",
    "market,organization,purpose,zone,tenant": "SCOPED",
    "market,organization,purpose,zone,tenant,start,end,limit,cursor": "SCOPED_WINDOW",
    "market,organization,purpose,zone,tenant,start,end,authority,product_code": "ANALYTICS",
  };
  if (!shapes[key]) throw new Error("UNKNOWN_QUERY_SHAPE:" + key);
  return shapes[key];
}

function pathParam(p) {
  const s = p.schema || {};
  const out = { name: p.name };
  if (s.format === "uuid") out.format = "uuid";
  if (s.pattern) out.pattern = s.pattern;
  if (s.maxLength) out.max_length = s.maxLength;
  if (!out.format && !out.pattern) throw new Error("PATH_PARAM_UNCONSTRAINED:" + p.name);
  return out;
}

function successSchema(op) {
  const code = Object.keys(op.responses).filter((c) => /^2/.test(c)).sort()[0];
  const response = op.responses[code];
  const media = response && response.content ? Object.keys(response.content)[0] : null;
  if (!media) return { status: Number(code), media: null, result: null };
  const schema = response.content[media].schema;
  if (media !== "application/json") return { status: Number(code), media, result: schema };
  if (!schema.properties || !schema.properties.result) throw new Error("ENVELOPE_WITHOUT_RESULT:" + op.operationId);
  return { status: Number(code), media, result: schema.properties.result };
}

function buildPinnedRegistry(checkout) {
  const dir = path.join(checkout, OPENAPI_DIR);
  const openapiRaw = fs.readFileSync(path.join(dir, "openapi.json"));
  const matrixRaw = fs.readFileSync(path.join(dir, "KARRYGO_ADMIN_CAPABILITY_MATRIX.json"));
  const openapi = JSON.parse(openapiRaw.toString("utf8"));
  const matrix = JSON.parse(matrixRaw.toString("utf8"));
  const byOperation = new Map();
  for (const [p, item] of Object.entries(openapi.paths)) {
    for (const [method, op] of Object.entries(item)) byOperation.set(op.operationId, { path: p, method: method.toUpperCase(), op });
  }
  const capabilities = matrix.map((cap) => {
    const found = byOperation.get(cap.id);
    if (!found) throw new Error("CAPABILITY_WITHOUT_OPERATION:" + cap.id);
    if (found.method !== cap.method || found.path !== BRIDGE_BASE + cap.bridge_endpoint) throw new Error("MATRIX_OPENAPI_MISMATCH:" + cap.id);
    const params = found.op.parameters || [];
    const query = params.filter((p) => p.in === "query");
    const success = successSchema(found.op);
    const module = MODULE_BY_PREFIX[cap.id.split(".")[0]];
    if (!module) throw new Error("UNMAPPED_MODULE:" + cap.id);
    const body = found.op.requestBody ? found.op.requestBody.content["application/json"].schema : null;
    return {
      id: cap.id,
      version: cap.version,
      module,
      kind: kindOf(cap),
      owner: cap.owner,
      method: cap.method,
      path: cap.bridge_endpoint,
      source_endpoint: cap.source_endpoint || null,
      path_params: params.filter((p) => p.in === "path").map(pathParam),
      query_shape: queryShape(query.map((p) => p.name)),
      query_required: query.filter((p) => p.required).map((p) => p.name),
      request_body: body,
      success_status: success.status,
      success_media: success.media,
      result_schema: success.result,
      matrix_state: cap.state,
      permission: cap.permission,
      risk: cap.risk,
      privacy: cap.privacy,
      scope: cap.scope,
      source_version_required: cap.source_version_required,
      idempotency_required: cap.idempotency_required,
      approval: cap.approval,
      feature_flag: cap.feature_flag,
      blocker: cap.blocker || null,
      source_tests: cap.tests,
    };
  });
  const byState = {};
  for (const c of capabilities) byState[c.matrix_state] = (byState[c.matrix_state] || 0) + 1;
  const registry = {
    contract: "karryam-backoffice-bridge",
    contract_version: openapi.info.version,
    bridge_base_path: BRIDGE_BASE,
    source_artifacts: {
      openapi_sha256: sha256(openapiRaw),
      capability_matrix_sha256: sha256(matrixRaw),
    },
    totals: { capabilities: capabilities.length, by_state: byState },
    capabilities,
  };
  const schemas = { components: { schemas: openapi.components.schemas } };
  return { registry, schemas };
}

const serialize = (value) => JSON.stringify(value, null, 1) + "\n";

if (require.main === module) {
  const checkout = process.env.KARRYGO_CHECKOUT;
  if (!checkout) { console.error("KARRYGO_CHECKOUT is required"); process.exit(2); }
  const { registry, schemas } = buildPinnedRegistry(checkout);
  const files = [[REGISTRY_FILE, serialize(registry)], [SCHEMAS_FILE, serialize(schemas)]];
  if (process.argv.includes("--write")) {
    for (const [file, text] of files) fs.writeFileSync(file, text);
    console.log(JSON.stringify({ written: files.map(([f]) => path.basename(f)), totals: registry.totals }));
  } else {
    const drift = files.filter(([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== text).map(([f]) => path.basename(f));
    console.log(JSON.stringify({ drift, totals: registry.totals }));
    if (drift.length) process.exit(1);
  }
}

module.exports = { buildPinnedRegistry, serialize, MODULE_BY_PREFIX, REGISTRY_FILE, SCHEMAS_FILE, kindOf };
