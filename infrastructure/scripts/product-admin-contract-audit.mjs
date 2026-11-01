#!/usr/bin/env node
// Section 13.2 (spec 9.2) contract audit -> product-admin-contract-audit.json
//
// Checks, without network access:
//   1. Pinned Karryam Backoffice Bridge contract: source commit, artifact
//      digests, exactly 435 unique capabilities, each with method, path, kind,
//      risk and module; totals agree with the pinned metadata; every schema
//      compiles.
//   2. With KARRYGO_CHECKOUT: artifact digests recomputed from the checkout,
//      every capability's exact method + path present in the source OpenAPI,
//      and the committed registry/schemas regenerate byte-identically (the
//      existing pin-bridge-contract logic).
//   3. Product Admin Protocol is v1.1 and the published JSON schemas and
//      OpenAPI regenerate byte-identically from source (write-schemas.js run
//      in a scratch copy, never in the repository).
//   4. The committed Karryam Admin API catalog matches buildCatalog().
//   5. Every HQ gateway route shape forwards to an existing PIC route with the
//      same method (real PIC request router, disposable loopback listener;
//      no database is touched because authentication is checked first).
//
// Exit 1 on any failed check (undocumented breaking drift). Usage:
//   node infrastructure/scripts/product-admin-contract-audit.mjs [--out <dir>] [--require-checkout]
// Env: KARRYGO_CHECKOUT, KARRYGO_REQUIRE_CHECKOUT=1, CONTRACT_AUDIT_DIR.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const EXPECTED_CAPABILITIES = 435;
const EXPECTED_PROTOCOL = { major: 1, minor: 1 };

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const lf = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

function check(id, fn) {
  try {
    const detail = fn();
    if (detail && detail.status === "SKIP") return { id, status: "SKIP", reason: detail.reason };
    return { id, status: "PASS", detail: detail || null };
  } catch (err) {
    return { id, status: "FAIL", reason: String(err && err.message || err).slice(0, 2000) };
  }
}

function assert(cond, message) { if (!cond) throw new Error(message); }

function bridgeContractChecks(checkout, requireCheckout) {
  const ka = path.join(ROOT, "services", "karryam-admin");
  const R = require(path.join(ka, "src/bridge/contracts/registry"));
  const { PINNED_BRIDGE_CONTRACT: P } = require(path.join(ka, "src/bridge/contracts"));
  const { compileBridgeSchema } = require(path.join(ka, "src/bridge/contracts/schema"));
  const components = require(path.join(ka, "src/bridge/contracts/karrygo-bridge-schemas.v1.json")).components.schemas;
  const out = [];
  out.push(check("bridge.pinned_metadata", () => {
    assert(/^[0-9a-f]{40}$/.test(P.source_commit), "source_commit is not a full SHA");
    assert(P.product === "karryam", "pinned product is not karryam");
    for (const [rel, sha] of Object.entries(P.artifacts)) assert(/^[0-9a-f]{64}$/.test(sha), "artifact digest malformed: " + rel);
    return { contract: P.contract, contract_version: P.contract_version, source_repository: P.source_repository, source_branch: P.source_branch, source_commit: P.source_commit, reviewed_at: P.reviewed_at, bridge_base_path: P.bridge_base_path, artifacts: P.artifacts };
  }));
  out.push(check("bridge.capability_registry", () => {
    const caps = R.CAPABILITIES;
    assert(caps.length === EXPECTED_CAPABILITIES, `expected ${EXPECTED_CAPABILITIES} capabilities, found ${caps.length}`);
    assert(caps.length === P.capability_matrix.total, "registry total differs from pinned matrix total");
    const ids = new Set();
    const problems = [];
    const tally = { kind: {}, risk: {}, module: {}, method: {}, matrix_state: {} };
    for (const c of caps) {
      if (ids.has(c.id)) problems.push("duplicate id " + c.id);
      ids.add(c.id);
      for (const k of ["id", "method", "path", "kind", "risk", "module", "matrix_state", "permission"]) if (typeof c[k] !== "string" || c[k] === "") problems.push(`${c.id}: missing ${k}`);
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(c.method)) problems.push(`${c.id}: method ${c.method}`);
      if (!/^R[0-4]$/.test(c.risk)) problems.push(`${c.id}: risk ${c.risk}`);
      if (!String(c.path).startsWith("/") || String(c.path).includes("..")) problems.push(`${c.id}: path ${c.path}`);
      for (const k of Object.keys(tally)) tally[k][c[k]] = (tally[k][c[k]] || 0) + 1;
      try {
        if (c.result_schema && c.success_media === "application/json") compileBridgeSchema(c.result_schema, components);
        if (c.request_body) compileBridgeSchema(c.request_body, components);
      } catch (err) { problems.push(`${c.id}: schema ${err.message}`); }
    }
    assert(JSON.stringify(Object.fromEntries(Object.entries(tally.matrix_state).sort())) === JSON.stringify(Object.fromEntries(Object.entries(P.capability_matrix.by_state).sort())), "matrix states differ from pinned metadata");
    assert(problems.length === 0, problems.slice(0, 20).join("; "));
    const s = R.summary();
    assert(s.source_artifacts.openapi_sha256 === P.artifacts["services/admin-backoffice-service/docs/openapi/openapi.json"], "registry built from a different OpenAPI than pinned");
    assert(s.source_artifacts.capability_matrix_sha256 === P.artifacts["services/admin-backoffice-service/docs/openapi/KARRYGO_ADMIN_CAPABILITY_MATRIX.json"], "registry built from a different matrix than pinned");
    return { capabilities: caps.length, unique_ids: ids.size, digest: sha256(JSON.stringify(caps.map((c) => [c.id, c.method, c.path, c.kind, c.risk, c.module, c.matrix_state]))), ...tally };
  }));
  out.push(check("bridge.registry_files", () => {
    const dir = path.join(ka, "src/bridge/contracts");
    return Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => [f, sha256(Buffer.from(lf(path.join(dir, f))))]));
  }));
  const have = checkout && fs.existsSync(path.join(checkout, "services/admin-backoffice-service/docs/openapi"));
  const skipOrFail = (id) => check(id, () => {
    assert(!requireCheckout, "KARRYGO_CHECKOUT is required but not present" + (checkout ? ": " + checkout : ""));
    return { status: "SKIP", reason: "KARRYGO_CHECKOUT not available" };
  });
  if (!have) {
    out.push(skipOrFail("bridge.source_artifact_digests"), skipOrFail("bridge.source_methods_and_paths"), skipOrFail("bridge.registry_regenerates"));
    return out;
  }
  out.push(check("bridge.source_artifact_digests", () => {
    const drift = [];
    for (const [rel, sha] of Object.entries(P.artifacts)) {
      const actual = sha256(fs.readFileSync(path.join(checkout, rel)));
      if (actual !== sha) drift.push(rel);
    }
    assert(drift.length === 0, "drift in " + drift.join(", "));
    return { checked: Object.keys(P.artifacts).length };
  }));
  out.push(check("bridge.source_methods_and_paths", () => {
    const openapi = JSON.parse(fs.readFileSync(path.join(checkout, "services/admin-backoffice-service/docs/openapi/openapi.json"), "utf8"));
    assert(openapi.info.version === P.openapi.info_version, "OpenAPI info.version differs");
    assert(Object.keys(openapi.paths).length === P.openapi.path_count, "OpenAPI path count differs");
    const missing = R.CAPABILITIES.filter((c) => { const p = openapi.paths[R.BRIDGE_BASE + c.path]; return !p || !p[c.method.toLowerCase()]; }).map((c) => `${c.id} ${c.method} ${c.path}`);
    assert(missing.length === 0, "capabilities without an exact source method+path: " + missing.slice(0, 20).join("; "));
    return { matched: R.CAPABILITIES.length, openapi_paths: Object.keys(openapi.paths).length };
  }));
  out.push(check("bridge.registry_regenerates", () => {
    const { buildPinnedRegistry, serialize, REGISTRY_FILE, SCHEMAS_FILE } = require(path.join(ka, "scripts/pin-bridge-contract"));
    const { registry, schemas } = buildPinnedRegistry(checkout);
    assert(lf(REGISTRY_FILE) === serialize(registry), "capability registry drifted: review and re-pin (scripts/pin-bridge-contract.js)");
    assert(lf(SCHEMAS_FILE) === serialize(schemas), "Bridge schemas drifted: review and re-pin");
    return { registry: path.basename(REGISTRY_FILE), schemas: path.basename(SCHEMAS_FILE) };
  }));
  return out;
}

function protocolChecks() {
  const pkg = path.join(ROOT, "packages", "admin-contracts");
  const C = require(pkg);
  const out = [];
  out.push(check("protocol.version", () => {
    assert(C.PROTOCOL_VERSION.major === EXPECTED_PROTOCOL.major && C.PROTOCOL_VERSION.minor === EXPECTED_PROTOCOL.minor, `protocol is ${C.PROTOCOL_VERSION.major}.${C.PROTOCOL_VERSION.minor}, expected 1.1`);
    assert(C.isSupportedProtocol({ major: 1, minor: 0 }), "protocol 1.0 peers must stay compatible");
    assert(!C.isSupportedProtocol({ major: 2, minor: 0 }), "a major version change must not be accepted silently");
    return { name: C.PROTOCOL_NAME, version: `${C.PROTOCOL_VERSION.major}.${C.PROTOCOL_VERSION.minor}`, contract_version: C.CONTRACT_VERSION, base_path: C.BASE_PATH, endpoints: Object.keys(C.ENDPOINTS).length, error_codes: C.ERROR_CODES };
  }));
  out.push(check("protocol.published_schemas_in_sync", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pa-contract-audit-"));
    try {
      const copy = path.join(scratch, "admin-contracts");
      for (const sub of ["src", "scripts", "schemas", "openapi"]) fs.cpSync(path.join(pkg, sub), path.join(copy, sub), { recursive: true });
      fs.copyFileSync(path.join(pkg, "package.json"), path.join(copy, "package.json"));
      execFileSync(process.execPath, [path.join(copy, "scripts", "write-schemas.js")], { cwd: copy, stdio: "ignore" });
      const files = [...fs.readdirSync(path.join(pkg, "schemas")).map((f) => "schemas/" + f), ...fs.readdirSync(path.join(pkg, "openapi")).map((f) => "openapi/" + f)];
      const regenerated = [...fs.readdirSync(path.join(copy, "schemas")).map((f) => "schemas/" + f), ...fs.readdirSync(path.join(copy, "openapi")).map((f) => "openapi/" + f)];
      const drift = regenerated.filter((f) => !files.includes(f) || lf(path.join(pkg, f)) !== lf(path.join(copy, f)));
      assert(drift.length === 0, "published contract drift (run npm --prefix packages/admin-contracts run schemas:write): " + drift.join(", "));
      return Object.fromEntries(files.sort().map((f) => [f, sha256(Buffer.from(lf(path.join(pkg, f))))]));
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }));
  out.push(check("protocol.event_envelope_in_sync", () => {
    const E = require(path.join(ROOT, "packages", "event-contracts"));
    const file = path.join(ROOT, "packages", "event-contracts", "schemas", "event-envelope.v1.json");
    assert(lf(file) === JSON.stringify(E.publishedEnvelopeSchema(), null, 2) + "\n", "event envelope schema drift (npm --prefix packages/event-contracts run schemas:write)");
    return { "schemas/event-envelope.v1.json": sha256(Buffer.from(lf(file))) };
  }));
  return out;
}

function catalogCheck() {
  return check("karryam_admin.api_catalog_in_sync", () => {
    const { buildCatalog, OUT } = require(path.join(ROOT, "services", "karryam-admin", "scripts", "api-catalog.js"));
    const json = JSON.stringify(buildCatalog(), null, 2) + "\n";
    assert(fs.existsSync(OUT) && lf(OUT) === json, "API catalog drift: run node services/karryam-admin/scripts/api-catalog.js and review the change");
    const cat = JSON.parse(json);
    assert(cat.bridge_contract.capabilities === EXPECTED_CAPABILITIES, "catalog capability count differs");
    const mismatched = cat.section_10_2_hq_bridge_contracts.filter((c) => !c.matches_specification).map((c) => c.capability_id || c.id);
    assert(mismatched.length === 0, "Section 10.2 contracts differ from the specification: " + mismatched.join(", "));
    return { file: path.relative(ROOT, OUT).split(path.sep).join("/"), sha256: sha256(Buffer.from(json)), families: cat.families.length, section_10_2_contracts: cat.section_10_2_hq_bridge_contracts.length };
  });
}

// Expands a gateway route regex source into concrete sample paths.
export function samplePaths(source, fragments) {
  let s = source.replace(/^\^/, "").replace(/\$$/, "");
  for (const [frag, value] of fragments) s = s.split(frag).join(value);
  const group = /\(\?:([^()]+)\)/;
  let list = [s];
  while (list.some((p) => group.test(p))) {
    list = list.flatMap((p) => { const m = group.exec(p); return m ? m[1].split("|").map((alt) => p.replace(m[0], alt)) : [p]; });
  }
  return list.map((p) => p.replace(/\\\//g, "/"));
}

async function gatewayCheck() {
  const id = "hq_gateway.routes_map_to_pic";
  let routesModule;
  const Module = require("node:module");
  const originalLoad = Module._load;
  // The gateway module needs express only to build routers; the route tables
  // are plain data. Stub express when the API's dependencies are not installed.
  Module._load = function load(request, parent, isMain) {
    if (request === "express") {
      try { return originalLoad.call(this, request, parent, isMain); } catch { return { Router: () => ({ use() {} }) }; }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try { routesModule = require(path.join(ROOT, "services/central-admin-api/src/modules/product-gateway/routes.js")); }
  catch (err) { return { id, status: "FAIL", reason: "gateway routes not loadable: " + err.message }; }
  finally { Module._load = originalLoad; }
  const { PRODUCT_ROUTES, ADMIN_MOUNTS, PIC_BASE } = routesModule;
  let createApp;
  try { ({ createApp } = require(path.join(ROOT, "services/product-integration-core/src/api/app.js"))); }
  catch (err) { return { id, status: "FAIL", reason: "PIC router not loadable (install services/product-integration-core dependencies): " + err.message }; }
  const fragments = [
    ["[a-z][a-z0-9-]{1,31}", "karryam"],
    ["[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "00000000-0000-4000-8000-000000000001"],
    ["[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", "sample.id-1"],
  ];
  const cases = [];
  for (const [method, pattern] of PRODUCT_ROUTES) {
    for (const rel of samplePaths(pattern.source, fragments)) cases.push({ method, gateway: "/api/products" + (rel === "/" ? "" : rel), pic: PIC_BASE + "/products" + (rel === "/" ? "" : rel) });
  }
  for (const [mount, { prefix, routes }] of Object.entries(ADMIN_MOUNTS)) {
    for (const [method, pattern] of routes) {
      for (const rel of samplePaths(pattern.source, fragments)) cases.push({ method, gateway: mount + (rel === "/" ? "" : rel), pic: PIC_BASE + prefix + (rel === "/" ? "" : rel) });
    }
  }
  const pool = { query: async () => { throw new Error("audit must not reach the database"); }, connect: async () => { throw new Error("audit must not reach the database"); } };
  const handler = createApp({ pool, endpoints: new Map(), trustStore: {}, hqDelegationKeys: {}, environment: "test", nonceStore: { claim: async () => { throw new Error("no nonce store in audit"); } }, logger: () => {} });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const send = (c) => new Promise((resolve, reject) => {
    const body = c.method === "POST" ? "{}" : "";
    const req = http.request({ host: "127.0.0.1", port, method: c.method, path: c.pic, headers: c.method === "POST" ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {} }, (res) => {
      let data = ""; res.on("data", (d) => { data += d; }); res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode, reason: json && json.error ? json.error.reason : null }); });
    });
    req.on("error", reject);
    req.end(body);
  });
  const unmapped = [];
  try {
    for (const c of cases) {
      const r = await send(c);
      // 401 DELEGATION_REQUIRED proves the PIC route exists for this method;
      // 404/405 means the gateway would forward to nothing.
      c.pic_status = r.status;
      if (!(r.status === 401 && r.reason === "DELEGATION_REQUIRED")) unmapped.push(`${c.method} ${c.gateway} -> ${c.pic} (${r.status} ${r.reason})`);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
  if (unmapped.length) return { id, status: "FAIL", reason: "gateway routes without a PIC route: " + unmapped.join("; ") };
  return { id, status: "PASS", detail: { routes_checked: cases.length, product_routes: PRODUCT_ROUTES.length, admin_mounts: Object.keys(ADMIN_MOUNTS), mapping: cases.map((c) => `${c.method} ${c.gateway} -> ${c.pic}`) } };
}

function gitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return null; }
}

export async function runAudit({ checkout = process.env.KARRYGO_CHECKOUT || null, requireCheckout = process.env.KARRYGO_REQUIRE_CHECKOUT === "1" } = {}) {
  const started = new Date().toISOString();
  const checks = [...bridgeContractChecks(checkout, requireCheckout), ...protocolChecks(), catalogCheck(), await gatewayCheck()];
  const failed = checks.filter((c) => c.status === "FAIL");
  return {
    artifact: "product-admin-contract-audit",
    schema_version: 1,
    source_sha: gitSha(),
    environment: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
    node_version: process.version,
    tool: "infrastructure/scripts/product-admin-contract-audit.mjs",
    karrygo_checkout: checkout && fs.existsSync(checkout) ? "PRESENT" : "ABSENT",
    started_at: started,
    finished_at: new Date().toISOString(),
    checks,
    summary: { pass: checks.filter((c) => c.status === "PASS").length, fail: failed.length, skip: checks.filter((c) => c.status === "SKIP").length },
    status: failed.length ? "FAIL" : "PASS",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const outDir = path.resolve(outIdx >= 0 ? argv[outIdx + 1] : process.env.CONTRACT_AUDIT_DIR || path.join(ROOT, "artifacts"));
  const report = await runAudit({ requireCheckout: argv.includes("--require-checkout") || process.env.KARRYGO_REQUIRE_CHECKOUT === "1" });
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "product-admin-contract-audit.json");
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  for (const c of report.checks) process.stderr.write(`${c.status.padEnd(4)} ${c.id}${c.reason ? " — " + c.reason : ""}\n`);
  process.stderr.write(`contract audit: ${report.status} -> ${file}\n`);
  process.exitCode = report.status === "PASS" ? 0 : 1;
}
