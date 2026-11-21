"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { PINNED_BRIDGE_CONTRACT } = require("../src/bridge/contracts");

const ROOT = path.join(__dirname, "..");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|json|sql)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("Karryam Admin never reaches HQ code, Prisma or operational databases", () => {
  const forbidden = [
    /central-admin-api/, /@prisma\//, /PrismaClient/, /dispatchDatabase/, /mainDatabase/, /dispatchPrisma/, /mainPrisma/,
    /DISPATCH_DATABASE_URL/, /MAIN_DATABASE_URL/, /KARRYGO_DATABASE_URL/, /\bDATABASE_URL\b(?<!ADMIN_DATABASE_URL)/,
  ];
  const files = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts")), ...walk(path.join(ROOT, "migrations"))];
  assert.ok(files.length > 15);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) assert.ok(!pattern.test(text), path.relative(ROOT, file) + " matches " + pattern);
  }
});

test("the only outbound HTTP client is the fixed bridge client (plus the database pool)", () => {
  const offenders = walk(path.join(ROOT, "src")).filter((file) => /require\("node:(?:https?|tls)"\)|\bfetch\(|axios/.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(ROOT, file).split(path.sep).join("/")).sort();
  // listener.js creates the inbound server; bridge/client is the only outbound HTTP caller.
  assert.deepEqual(offenders, ["src/bridge/client/index.js", "src/transport/listener.js"]);
});

test("pinned KarryGo bridge contract matches a local checkout when one is available", (t) => {
  const checkout = process.env.KARRYGO_CHECKOUT || "/home/user/cosmicforgehealthnet/karrygo";
  if (!fs.existsSync(path.join(checkout, "services/admin-backoffice-service/docs/openapi"))) {
    // CI sets KARRYGO_REQUIRE_CHECKOUT so a missing checkout fails instead of silently skipping.
    assert.ok(process.env.KARRYGO_REQUIRE_CHECKOUT !== "1", "KARRYGO_CHECKOUT is required but not present: " + checkout);
    t.skip("KarryGo checkout not available");
    return;
  }
  for (const [rel, sha] of Object.entries(PINNED_BRIDGE_CONTRACT.artifacts)) {
    const actual = createHash("sha256").update(fs.readFileSync(path.join(checkout, rel))).digest("hex");
    assert.equal(actual, sha, "drift in " + rel);
  }
  const matrix = JSON.parse(fs.readFileSync(path.join(checkout, "services/admin-backoffice-service/docs/openapi/KARRYGO_ADMIN_CAPABILITY_MATRIX.json"), "utf8"));
  const counts = {};
  for (const cap of matrix) counts[cap.state] = (counts[cap.state] || 0) + 1;
  assert.equal(matrix.length, PINNED_BRIDGE_CONTRACT.capability_matrix.total);
  assert.deepEqual(counts, PINNED_BRIDGE_CONTRACT.capability_matrix.by_state);
  const openapi = JSON.parse(fs.readFileSync(path.join(checkout, "services/admin-backoffice-service/docs/openapi/openapi.json"), "utf8"));
  assert.equal(Object.keys(openapi.paths).length, PINNED_BRIDGE_CONTRACT.openapi.path_count);
  assert.equal(openapi.info.version, PINNED_BRIDGE_CONTRACT.openapi.info_version);
});

test("pinned KarryGo capability registry, schemas and event adapters regenerate identically from the checkout", (t) => {
  const checkout = process.env.KARRYGO_CHECKOUT || "/home/user/cosmicforgehealthnet/karrygo";
  if (!fs.existsSync(path.join(checkout, "services/admin-backoffice-service/docs/openapi"))) {
    assert.ok(process.env.KARRYGO_REQUIRE_CHECKOUT !== "1", "KARRYGO_CHECKOUT is required but not present: " + checkout);
    t.skip("KarryGo checkout not available");
    return;
  }
  const { buildPinnedRegistry, serialize, REGISTRY_FILE, SCHEMAS_FILE } = require("../scripts/pin-bridge-contract");
  const { registry, schemas } = buildPinnedRegistry(checkout);
  const committed = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  assert.equal(committed(REGISTRY_FILE), serialize(registry), "capability registry drifted: review and re-pin (scripts/pin-bridge-contract.js)");
  assert.equal(committed(SCHEMAS_FILE), serialize(schemas), "Bridge schemas drifted: review and re-pin");
  const adapters = require("../src/bridge/contracts/karrygo-event-adapters.v1.json");
  for (const [rel, sha] of Object.entries(adapters.source_files)) {
    const file = path.join(checkout, rel);
    if (!fs.existsSync(file)) {
      assert.ok(process.env.KARRYGO_REQUIRE_CHECKOUT !== "1", "event adapter source missing from checkout: " + rel);
      continue;
    }
    // LF-normalized: a Windows checkout may convert .go files to CRLF.
    const actual = createHash("sha256").update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")).digest("hex");
    assert.equal(actual, sha, "event adapter drift in " + rel + ": review karrygo-event-adapters.v1.json");
  }
});

test("pinned registry agrees with the pinned contract metadata and every schema compiles", () => {
  const R = require("../src/bridge/contracts/registry");
  const { compileBridgeSchema } = require("../src/bridge/contracts/schema");
  const components = require("../src/bridge/contracts/karrygo-bridge-schemas.v1.json").components.schemas;
  const s = R.summary();
  assert.equal(s.totals.capabilities, PINNED_BRIDGE_CONTRACT.capability_matrix.total);
  assert.deepEqual(s.totals.by_state, PINNED_BRIDGE_CONTRACT.capability_matrix.by_state);
  assert.equal(s.source_artifacts.openapi_sha256, PINNED_BRIDGE_CONTRACT.artifacts["services/admin-backoffice-service/docs/openapi/openapi.json"]);
  assert.equal(s.source_artifacts.capability_matrix_sha256, PINNED_BRIDGE_CONTRACT.artifacts["services/admin-backoffice-service/docs/openapi/KARRYGO_ADMIN_CAPABILITY_MATRIX.json"]);
  for (const cap of R.CAPABILITIES) {
    if (cap.result_schema && cap.success_media === "application/json") compileBridgeSchema(cap.result_schema, components);
    if (cap.request_body) compileBridgeSchema(cap.request_body, components);
    assert.ok(cap.path.startsWith("/") && !cap.path.includes(".."), cap.id);
  }
  // The read-oriented POST contracts keep their source method.
  assert.equal(R.capability("hq.finance.report").method, "POST");
  assert.equal(R.capability("hq.finance.report").kind, "READ");
  assert.equal(R.capability("hq.events.ack").kind, "SYNC");
  // Unsupported schema keywords are refused at compile time.
  assert.throws(() => compileBridgeSchema({ type: "object", unevaluatedProperties: false }, components), /unsupported_schema_keyword/);
  assert.throws(() => compileBridgeSchema({ $ref: "#/components/schemas/Nope" }, components), /unresolved_ref/);
});

test("request URIs are built only from the pinned shape with validated values", () => {
  const R = require("../src/bridge/contracts/registry");
  const cap = R.capability("customer.resources.customers.detail");
  const now = Date.parse("2026-10-31T12:00:00Z");
  const base = { market: "NG-LAGOS", organization: "karryam-ng", purpose: "case_review", zone: "lagos-island", tenant: "tenant-a", start: "2026-10-30T12:00:00Z", end: "2026-10-31T12:00:00Z", limit: 1 };
  const id = cap.path_params[0].format === "uuid" ? "6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7" : "ref-1";
  assert.equal(R.buildUri(cap, { query: base, pathParams: { [cap.path_params[0].name]: id }, now }),
    "/internal/karryam-admin/v1/customer/resources/customers/" + id + "?market=NG-LAGOS&organization=karryam-ng&purpose=case_review&zone=lagos-island&tenant=tenant-a&start=2026-10-30T12%3A00%3A00Z&end=2026-10-31T12%3A00%3A00Z&limit=1");
  const bad = [
    [{ ...base, extra: "x" }, "QUERY_PARAMETER_NOT_IN_CONTRACT"],
    [{ ...base, zone: undefined }, "QUERY_PARAMETER_REQUIRED"],
    [{ ...base, limit: 101 }, "QUERY_PARAMETER_INVALID"],
    [{ ...base, market: "bad value" }, "QUERY_PARAMETER_INVALID"],
    [{ ...base, start: "2026-09-01T00:00:00Z" }, "TIME_WINDOW_INVALID"],
    [{ ...base, end: "2026-11-30T00:00:00Z", start: "2026-11-29T00:00:00Z" }, "TIME_WINDOW_INVALID"],
  ];
  for (const [query, reason] of bad) assert.throws(() => R.buildUri(cap, { query, pathParams: { [cap.path_params[0].name]: id }, now }), (e) => e.reason === reason, reason);
  for (const value of ["../x", "a/b", "", "%2e%2e"]) assert.throws(() => R.buildUri(cap, { query: base, pathParams: { [cap.path_params[0].name]: value }, now }), (e) => e.reason === "PATH_PARAMETER_INVALID", value);
  assert.throws(() => R.buildUri(cap, { query: base, pathParams: { id, host: "evil" }, now }), (e) => e.reason === "PATH_PARAMETER_NOT_IN_CONTRACT");
});
