"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { PINNED_BRIDGE_CONTRACT } = require("../src/bridge/contracts");
const { DRAFT_DIR } = require("../scripts/pin-bridge-contract");

// Until Track A's A0 is pinned the checkout is HQ's contract-draft; CI sets
// CFMEET_CHECKOUT to a cfmeet checkout at the pinned commit afterwards.
const CHECKOUT = process.env.CFMEET_CHECKOUT || (PINNED_BRIDGE_CONTRACT.contract_status === "DRAFT" ? DRAFT_DIR : "/home/user/cosmicforgehealthnet/cfmeet");

const ROOT = path.join(__dirname, "..");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|json|sql)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("CF Meet Admin never reaches HQ code, Prisma or operational databases", () => {
  const forbidden = [
    /central-admin-api/, /@prisma\//, /PrismaClient/, /dispatchDatabase/, /mainDatabase/, /dispatchPrisma/, /mainPrisma/,
    /DISPATCH_DATABASE_URL/, /MAIN_DATABASE_URL/, /KARRYGO_DATABASE_URL/, /CFMEET_DATABASE_URL/, /MEETING_DATABASE_URL/, /\bDATABASE_URL\b(?<!ADMIN_DATABASE_URL)/,
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

test("pinned CF Meet bridge contract matches a local checkout when one is available", (t) => {
  const checkout = CHECKOUT;
  if (!fs.existsSync(path.join(checkout, "services/admin-bridge/docs/contract"))) {
    // CI sets CFMEET_REQUIRE_CHECKOUT so a missing checkout fails instead of silently skipping.
    assert.ok(process.env.CFMEET_REQUIRE_CHECKOUT !== "1", "CFMEET_CHECKOUT is required but not present: " + checkout);
    t.skip("CF Meet checkout not available");
    return;
  }
  for (const [rel, sha] of Object.entries(PINNED_BRIDGE_CONTRACT.artifacts)) {
    const actual = createHash("sha256").update(fs.readFileSync(path.join(checkout, rel))).digest("hex");
    assert.equal(actual, sha, "drift in " + rel);
  }
  const matrix = JSON.parse(fs.readFileSync(path.join(checkout, "services/admin-bridge/docs/contract/CFMEET_ADMIN_CAPABILITY_MATRIX.json"), "utf8"));
  const counts = {};
  for (const cap of matrix) counts[cap.state] = (counts[cap.state] || 0) + 1;
  assert.equal(matrix.length, PINNED_BRIDGE_CONTRACT.capability_matrix.total);
  assert.deepEqual(counts, PINNED_BRIDGE_CONTRACT.capability_matrix.by_state);
  const openapi = JSON.parse(fs.readFileSync(path.join(checkout, "services/admin-bridge/docs/contract/openapi.json"), "utf8"));
  assert.equal(Object.keys(openapi.paths).length, PINNED_BRIDGE_CONTRACT.openapi.path_count);
  assert.equal(openapi.info.version, PINNED_BRIDGE_CONTRACT.openapi.info_version);
});

test("pinned CF Meet capability registry, schemas and event adapters regenerate identically from the checkout", (t) => {
  const checkout = CHECKOUT;
  if (!fs.existsSync(path.join(checkout, "services/admin-bridge/docs/contract"))) {
    assert.ok(process.env.CFMEET_REQUIRE_CHECKOUT !== "1", "CFMEET_CHECKOUT is required but not present: " + checkout);
    t.skip("CF Meet checkout not available");
    return;
  }
  const { outputs } = require("../scripts/pin-bridge-contract");
  const committed = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  // Registry, schemas, event adapters and pinned metadata regenerate byte for byte.
  for (const [file, text] of outputs(checkout, { commit: PINNED_BRIDGE_CONTRACT.source_commit, reviewedAt: PINNED_BRIDGE_CONTRACT.reviewed_at })) {
    assert.equal(committed(file), text, path.basename(file) + " drifted: review and re-pin (scripts/pin-bridge-contract.js)");
  }
  const adapters = require("../src/bridge/contracts/cfmeet-event-adapters.v1.json");
  for (const [rel, sha] of Object.entries(adapters.source_files)) {
    const file = path.join(checkout, rel);
    if (!fs.existsSync(file)) {
      assert.ok(process.env.CFMEET_REQUIRE_CHECKOUT !== "1", "event adapter source missing from checkout: " + rel);
      continue;
    }
    // LF-normalized: a Windows checkout may convert .go files to CRLF.
    const actual = createHash("sha256").update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")).digest("hex");
    assert.equal(actual, sha, "event adapter drift in " + rel + ": review cfmeet-event-adapters.v1.json");
  }
});

test("pinned registry agrees with the pinned contract metadata and every schema compiles", () => {
  const R = require("../src/bridge/contracts/registry");
  const { compileBridgeSchema } = require("../src/bridge/contracts/schema");
  const components = require("../src/bridge/contracts/cfmeet-bridge-schemas.v1.json").components.schemas;
  const s = R.summary();
  assert.equal(s.totals.capabilities, PINNED_BRIDGE_CONTRACT.capability_matrix.total);
  assert.deepEqual(s.totals.by_state, PINNED_BRIDGE_CONTRACT.capability_matrix.by_state);
  assert.equal(s.source_artifacts.openapi_sha256, PINNED_BRIDGE_CONTRACT.artifacts["services/admin-bridge/docs/contract/openapi.json"]);
  assert.equal(s.source_artifacts.capability_matrix_sha256, PINNED_BRIDGE_CONTRACT.artifacts["services/admin-bridge/docs/contract/CFMEET_ADMIN_CAPABILITY_MATRIX.json"]);
  for (const cap of R.CAPABILITIES) {
    if (cap.result_schema && cap.success_media === "application/json") compileBridgeSchema(cap.result_schema, components);
    if (cap.request_body) compileBridgeSchema(cap.request_body, components);
    assert.ok(cap.path.startsWith("/") && !cap.path.includes(".."), cap.id);
  }
  // The read-oriented POST contracts keep their source method.
  assert.equal(R.capability("pricing.charges.simulate").method, "POST");
  assert.equal(R.capability("pricing.charges.simulate").kind, "READ");
  assert.equal(R.capability("accounts.exports.download").kind, "RETRIEVAL");
  assert.equal(R.capability("hq.events.ack").kind, "SYNC");
  assert.equal(R.capability("hq.events.feed").kind, "SYNC");
  // Every CF Meet route is zone- and tenant-scoped, in one of the agreed shapes.
  for (const cap of R.CAPABILITIES) {
    assert.ok(Object.keys(R.SHAPE_PARAMS).includes(cap.query_shape), cap.id);
    assert.ok(R.needsZoneTenant(cap), cap.id);
    assert.ok(["NONE", "TWO_PERSON"].includes(cap.approval), cap.id);
  }
  // Unsupported schema keywords are refused at compile time.
  assert.throws(() => compileBridgeSchema({ type: "object", unevaluatedProperties: false }, components), /unsupported_schema_keyword/);
  assert.throws(() => compileBridgeSchema({ $ref: "#/components/schemas/Nope" }, components), /unresolved_ref/);
});

test("request URIs are built only from the pinned shape with validated values", () => {
  const R = require("../src/bridge/contracts/registry");
  const cap = R.capability("meetings.meetings.read");
  const now = Date.parse("2026-11-19T12:00:00Z");
  const base = { market: "GLOBAL", organization: "cfmeet", zone: "production", tenant: "tenant-a", purpose: "support-review" };
  assert.equal(R.buildUri(cap, { query: base, pathParams: { meeting_id: "mtg-1" }, now }),
    "/internal/cfmeet-admin/v1/meetings/meetings/mtg-1?market=GLOBAL&organization=cfmeet&zone=production&tenant=tenant-a&purpose=support-review");
  const win = R.capability("meetings.meetings.list");
  assert.equal(R.buildUri(win, { query: { ...base, limit: 10, start: "2026-11-18T12:00:00Z", end: "2026-11-19T12:00:00Z" }, now }),
    "/internal/cfmeet-admin/v1/meetings/meetings?market=GLOBAL&organization=cfmeet&zone=production&tenant=tenant-a&purpose=support-review&limit=10&start=2026-11-18T12%3A00%3A00Z&end=2026-11-19T12%3A00%3A00Z");
  const search = R.capability("accounts.users.list");
  assert.equal(R.buildUri(search, { query: { ...base, limit: 5, q: "ada lovelace" }, now }),
    "/internal/cfmeet-admin/v1/accounts/users?market=GLOBAL&organization=cfmeet&zone=production&tenant=tenant-a&purpose=support-review&limit=5&q=ada%20lovelace");
  const bad = [
    [win, { ...base, limit: 10, start: "2026-11-18T12:00:00Z", end: "2026-11-19T12:00:00Z", extra: "x" }, "QUERY_PARAMETER_NOT_IN_CONTRACT"],
    [cap, { ...base, zone: undefined }, "QUERY_PARAMETER_REQUIRED"],
    [cap, { ...base, purpose: "case_review" }, "QUERY_PARAMETER_INVALID"],
    [cap, { ...base, purpose: "admin_ui_capabilities" }, "QUERY_PARAMETER_INVALID"],
    [win, { ...base, limit: 101, start: "2026-11-18T12:00:00Z", end: "2026-11-19T12:00:00Z" }, "QUERY_PARAMETER_INVALID"],
    [cap, { ...base, market: "bad value" }, "QUERY_PARAMETER_INVALID"],
    [win, { ...base, limit: 10, start: "2026-09-01T00:00:00Z", end: "2026-11-19T12:00:00Z" }, "TIME_WINDOW_INVALID"],
    [win, { ...base, limit: 10, start: "2026-11-29T00:00:00Z", end: "2026-11-30T00:00:00Z" }, "TIME_WINDOW_INVALID"],
    [search, { ...base, limit: 5, q: "a/b<script>" }, "QUERY_PARAMETER_INVALID"],
  ];
  for (const [c, query, reason] of bad) assert.throws(() => R.buildUri(c, { query, pathParams: c === cap ? { meeting_id: "mtg-1" } : {}, now }), (e) => e.reason === reason, reason);
  for (const value of ["../x", "a/b", "", "%2e%2e"]) assert.throws(() => R.buildUri(cap, { query: base, pathParams: { meeting_id: value }, now }), (e) => e.reason === "PATH_PARAMETER_INVALID", value);
  assert.throws(() => R.buildUri(cap, { query: base, pathParams: { meeting_id: "mtg-1", host: "evil" }, now }), (e) => e.reason === "PATH_PARAMETER_NOT_IN_CONTRACT");
  // uuid path parameters are enforced.
  const vcase = R.capability("verification.cases.read");
  assert.throws(() => R.buildUri(vcase, { query: base, pathParams: { case_id: "not-a-uuid" }, now }), (e) => e.reason === "PATH_PARAMETER_INVALID");
});

test("a DRAFT contract can never enable the Bridge in staging or production", () => {
  const { loadConfig } = require("../src/config");
  const F = require("./helpers/fixtures");
  if (PINNED_BRIDGE_CONTRACT.contract_status !== "DRAFT") return;
  const m = F.material();
  try {
    for (const environment of ["staging", "production"]) {
      assert.throws(() => loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_ENVIRONMENT: environment, CFMEET_BRIDGE_ENABLED: "true" })), (e) => e.reason === "CFMEET_BRIDGE_CONTRACT_NOT_PINNED", environment);
    }
  } finally { m.cleanup(); }
});
