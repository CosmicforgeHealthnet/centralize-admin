"use strict";

// Generates the pinned, reviewed CF Meet Admin Bridge capability registry
// from a cfmeet checkout (or from the HQ draft in contract-draft/ until Track
// A publishes A0). Nothing is guessed: every method, path, query and path
// parameter, request body schema and result schema is copied from the source
// OpenAPI and capability matrix (interface v1, work plan §3).
//
//   CFMEET_CHECKOUT=/path/to/cfmeet node scripts/pin-bridge-contract.js --write --commit <sha>
//   CFMEET_CHECKOUT=contract-draft  node scripts/pin-bridge-contract.js --write          (DRAFT)
//
// Without --write it only reports whether the committed files match the
// checkout (exit 1 on drift). Re-pinning is a reviewed change.

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const CONTRACT_DIR = "services/admin-bridge/docs/contract";
const BRIDGE_BASE = "/internal/cfmeet-admin/v1";
const OUT_DIR = path.join(__dirname, "..", "src", "bridge", "contracts");
const REGISTRY_FILE = path.join(OUT_DIR, "cfmeet-capabilities.v1.json");
const SCHEMAS_FILE = path.join(OUT_DIR, "cfmeet-bridge-schemas.v1.json");
const ADAPTERS_FILE = path.join(OUT_DIR, "cfmeet-event-adapters.v1.json");
const METADATA_FILE = path.join(OUT_DIR, "cfmeet-backoffice-v1.json");
const DRAFT_DIR = path.join(__dirname, "..", "contract-draft");
// HQ's interface-v1 TARGET registry (generated from contract-draft). The
// functional test suites run against it (tests/helpers/target-contract.js)
// so HQ behaviour stays exercised while Track A's real contract still has
// most capabilities BLOCKED_DEPENDENCY/DISABLED. Production always uses the
// pinned files in src/bridge/contracts/.
const TARGET_DIR = path.join(DRAFT_DIR, "registry");
const DRAFT_COMMIT = "DRAFT-UNPINNED";
const ARTIFACTS = ["openapi.json", "CFMEET_ADMIN_CAPABILITY_MATRIX.json", "event-adapters.v1.json", "signing-profile.md", "SHA256SUMS"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Capability ID prefix -> HQ module (agreed with Track A). Every capability
// belongs to exactly one module so coverage is never double counted.
const MODULE_BY_PREFIX = Object.freeze({
  accounts: "accounts", meetings: "meetings", messaging: "messaging", calling: "calling", communications: "communications",
  organizations: "organizations", partners: "partners", identity: "identity", apps: "apps", verification: "verification",
  pricing: "pricing", finance: "finance", notifications: "notifications", privacy: "privacy", operations: "operations",
  audit: "audit", telecom: "telecom", bridge: "platform", hq: "platform",
});

// Reviewed classification of every non-GET capability. GET is always READ
// unless it is a Stage A sync read.
//  READ       read-oriented contract that the source exposes as POST
//  RETRIEVAL  sensitive single-use content retrieval (governed)
//  SYNC       Stage A event pipeline only (never staff-facing)
//  COMMAND    anything that changes source or Bridge state
const NON_GET_KIND = Object.freeze({
  "pricing.charges.simulate": "READ",
  "accounts.exports.download": "RETRIEVAL",
  "hq.events.ack": "SYNC",
});
const SYNC_READS = new Set(["hq.events.feed"]);

function kindOf(cap) {
  if (cap.method === "GET") return SYNC_READS.has(cap.id) ? "SYNC" : "READ";
  return NON_GET_KIND[cap.id] || "COMMAND";
}

// The agreed closed set of query shapes; the order is signed.
const QUERY_SHAPES = Object.freeze({
  "market,organization,zone,tenant,purpose": "SCOPED",
  "market,organization,zone,tenant,purpose,limit,cursor": "SCOPED_PAGE",
  "market,organization,zone,tenant,purpose,limit,cursor,start,end": "SCOPED_WINDOW",
  "market,organization,zone,tenant,purpose,limit,cursor,q": "SCOPED_SEARCH",
});

function queryShape(names) {
  const shape = QUERY_SHAPES[names.join(",")];
  if (!shape) throw new Error("UNKNOWN_QUERY_SHAPE:" + names.join(","));
  return shape;
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

// Naming rules agreed with Track A (also enforced by the Bridge's own contract
// tests): HQ classifies reads by them, so a violation is never pinned.
//  - a collection id ends in .list or .search, is a GET READ, and uses
//    SCOPED_PAGE, SCOPED_WINDOW or SCOPED_SEARCH; nothing else ends that way;
//  - .search always means SCOPED_SEARCH (it carries q);
//  - read-type POSTs are exactly the reviewed NON_GET_KIND READ/SYNC entries.
const COLLECTION_SHAPES = new Set(["SCOPED_PAGE", "SCOPED_WINDOW", "SCOPED_SEARCH"]);
function namingErrors(capabilities) {
  for (const c of capabilities) {
    const collection = /\.(list|search)$/.test(c.id);
    if (collection && (c.method !== "GET" || c.kind !== "READ" || !COLLECTION_SHAPES.has(c.query_shape))) throw new Error("COLLECTION_NAMING_VIOLATION:" + c.id);
    if (c.id.endsWith(".search") && c.query_shape !== "SCOPED_SEARCH") throw new Error("SEARCH_WITHOUT_Q:" + c.id);
  }
}

function readArtifacts(checkout) {
  const dir = path.join(checkout, CONTRACT_DIR);
  const raw = {};
  for (const name of ARTIFACTS) raw[name] = fs.readFileSync(path.join(dir, name));
  return raw;
}

function buildPinnedRegistry(checkout) {
  const raw = readArtifacts(checkout);
  const openapi = JSON.parse(raw["openapi.json"].toString("utf8"));
  const matrix = JSON.parse(raw["CFMEET_ADMIN_CAPABILITY_MATRIX.json"].toString("utf8"));
  if (!Array.isArray(matrix)) throw new Error("MATRIX_NOT_AN_ARRAY");
  const byOperation = new Map();
  for (const [p, item] of Object.entries(openapi.paths)) {
    for (const [method, op] of Object.entries(item)) byOperation.set(op.operationId, { path: p, method: method.toUpperCase(), op });
  }
  const seen = new Set();
  const capabilities = matrix.map((cap) => {
    if (seen.has(cap.id)) throw new Error("DUPLICATE_CAPABILITY:" + cap.id);
    seen.add(cap.id);
    const found = byOperation.get(cap.id);
    if (!found) throw new Error("CAPABILITY_WITHOUT_OPERATION:" + cap.id);
    if (found.method !== cap.method || found.path !== BRIDGE_BASE + cap.bridge_endpoint) throw new Error("MATRIX_OPENAPI_MISMATCH:" + cap.id);
    if (!["NONE", "TWO_PERSON"].includes(cap.approval)) throw new Error("APPROVAL_VALUE_INVALID:" + cap.id);
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
  namingErrors(capabilities);
  const byState = {};
  for (const c of capabilities) byState[c.matrix_state] = (byState[c.matrix_state] || 0) + 1;
  const registry = {
    contract: "cfmeet-admin-bridge",
    contract_version: openapi.info.version,
    bridge_base_path: BRIDGE_BASE,
    source_artifacts: {
      openapi_sha256: sha256(raw["openapi.json"]),
      capability_matrix_sha256: sha256(raw["CFMEET_ADMIN_CAPABILITY_MATRIX.json"]),
    },
    totals: { capabilities: capabilities.length, by_state: byState },
    capabilities,
  };
  const schemas = { components: { schemas: openapi.components.schemas } };
  const adapters = JSON.parse(raw["event-adapters.v1.json"].toString("utf8"));
  return { registry, schemas, adapters, raw, openapi };
}

// Pinned metadata. A pin from the HQ draft (or without a reviewed commit)
// is DRAFT, and cfmeet-admin refuses to enable the Bridge in staging or
// production while it is.
function buildMetadata(built, { commit, reviewedAt }) {
  const draft = !commit || commit === DRAFT_COMMIT || built.openapi.info["x-hq-draft"] === true;
  const artifacts = {};
  for (const name of ARTIFACTS) artifacts[CONTRACT_DIR + "/" + name] = sha256(built.raw[name]);
  return {
    contract: "cfmeet-admin-bridge",
    contract_version: built.openapi.info.version,
    contract_status: draft ? "DRAFT" : "PINNED",
    source_repository: draft ? "CosmicforgeHealthnet/centralize-admin (services/cfmeet-admin/contract-draft)" : "CosmicforgeHealthnet/cfmeet",
    source_commit: draft ? DRAFT_COMMIT : commit,
    reviewed_at: reviewedAt,
    bridge_base_path: BRIDGE_BASE,
    hq_principal: "cosmicforge-hq-cfmeet-admin",
    product: "cfmeet",
    authentication: [
      "private transport",
      "TLS 1.3 mutual TLS with enrolled HQ client certificate fingerprint",
      "HMAC v2 service signature (X-Service-Signature-Version: 2, X-HQ-Key-ID)",
      "Ed25519 staff assertion bound to request_digest; approval claim on TWO_PERSON capabilities",
    ],
    artifacts,
    openapi: { openapi: built.openapi.openapi, info_version: built.openapi.info.version, path_count: Object.keys(built.openapi.paths).length },
    capability_matrix: { total: built.registry.totals.capabilities, by_state: { ...built.registry.totals.by_state } },
    authorization_rule: "Source-matrix AVAILABLE is artifact state, never runtime authorization: HQ grants, recent MFA, operator enablement, certification, independent approval and the Bridge's signed access policy all apply.",
  };
}

const serialize = (value) => JSON.stringify(value, null, 1) + "\n";

function outputs(checkout, opts, dir = OUT_DIR) {
  const built = buildPinnedRegistry(checkout);
  return [
    [path.join(dir, path.basename(REGISTRY_FILE)), serialize(built.registry)],
    [path.join(dir, path.basename(SCHEMAS_FILE)), serialize(built.schemas)],
    [path.join(dir, path.basename(ADAPTERS_FILE)), serialize(built.adapters)],
    [path.join(dir, path.basename(METADATA_FILE)), serialize(buildMetadata(built, opts))],
  ];
}

// The target registry: always from the HQ draft, always DRAFT metadata.
function targetOutputs() {
  return outputs(DRAFT_DIR, { commit: DRAFT_COMMIT, reviewedAt: "target" }, TARGET_DIR);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (require.main === module) {
  const checkout = process.env.CFMEET_CHECKOUT ? path.resolve(process.env.CFMEET_CHECKOUT) : DRAFT_DIR;
  const prior = fs.existsSync(METADATA_FILE) ? JSON.parse(fs.readFileSync(METADATA_FILE, "utf8")) : {};
  const write = process.argv.includes("--write");
  const commit = arg("--commit") || (write ? undefined : prior.source_commit);
  if (commit && commit !== DRAFT_COMMIT && !/^[0-9a-f]{40}$/.test(commit)) { console.error("--commit must be a full 40-hex commit SHA"); process.exit(2); }
  const reviewedAt = arg("--reviewed-at") || (write ? new Date().toISOString().slice(0, 10) : prior.reviewed_at);
  const target = process.argv.includes("--target");
  if (target && process.env.CFMEET_CHECKOUT) { console.error("--target always builds from contract-draft; unset CFMEET_CHECKOUT"); process.exit(2); }
  if (target && write) fs.mkdirSync(TARGET_DIR, { recursive: true });
  const files = target ? targetOutputs() : outputs(checkout, { commit, reviewedAt });
  const totals = JSON.parse(files[0][1]).totals;
  if (write) {
    for (const [file, text] of files) fs.writeFileSync(file, text);
    console.log(JSON.stringify({ written: files.map(([f]) => path.basename(f)), totals }));
  } else {
    const drift = files.filter(([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== text).map(([f]) => path.basename(f));
    console.log(JSON.stringify({ drift, totals }));
    if (drift.length) process.exit(1);
  }
}

module.exports = { buildPinnedRegistry, buildMetadata, outputs, targetOutputs, TARGET_DIR, serialize, MODULE_BY_PREFIX, QUERY_SHAPES, REGISTRY_FILE, SCHEMAS_FILE, ADAPTERS_FILE, METADATA_FILE, DRAFT_DIR, DRAFT_COMMIT, CONTRACT_DIR, kindOf };
