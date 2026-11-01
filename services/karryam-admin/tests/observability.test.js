"use strict";

// Section 12.5: private metrics, sync status, readiness detail and log
// redaction. No database here (see recovery-postgres.test.js for the
// scrape-time database gauges).

const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("./helpers/fixtures");
const { createKarryamMetrics, karryamMetricNames } = require("../src/observability/metrics");
const { createLogger, redact } = require("../src/logger");

const BASE = F.contracts.BASE_PATH;

function series(text, name) {
  return text.split("\n").filter((l) => l.startsWith(name + "{") || l.startsWith(name + " "));
}

async function metricsText(port) {
  const http = require("node:http");
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/metrics" }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], text: data }));
    }).on("error", reject);
  });
}

test("disabled service: /metrics exposes only process and disabled gauges; /sync/status is DISABLED", async (t) => {
  const app = await F.startApp(F.loadConfig({}));
  t.after(app.close);
  const m = await metricsText(app.port);
  assert.equal(m.status, 200);
  assert.match(m.type, /^text\/plain; version=0\.0\.4/);
  assert.deepEqual(series(m.text, "karryam_admin_enabled"), ["karryam_admin_enabled 0"]);
  assert.equal(series(m.text, "karryam_admin_process_start_time_seconds").length, 1);
  assert.equal(series(m.text, "karryam_admin_requests_total").length, 0);
  const s = await F.rawRequest(app.port, { path: "/sync/status" });
  assert.equal(s.status, 503);
  assert.equal(s.json.status, "DISABLED");
  assert.equal((await F.rawRequest(app.port, { method: "POST", path: "/metrics" })).status, 405);
});

test("enabled service: requests, service-auth and delegation failures are counted without identities", async (t) => {
  const m = F.material();
  t.after(m.cleanup);
  const config = F.loadConfig(F.enabledEnv(m));
  const app = await F.startApp(config);
  t.after(app.close);
  const client = F.hqClient(app.target, m.hqKey);
  assert.equal((await client.getManifest()).status, 200);
  // Unauthenticated protocol call.
  assert.equal((await F.rawRequest(app.port, { path: BASE + "/manifest" })).status, 401);
  // Wrong key: invalid service identity.
  const wrong = F.hqClient(app.target, require("node:crypto").randomBytes(32));
  assert.equal((await wrong.getManifest()).status, 401);
  // Delegated call with an expired staff delegation.
  const uri = BASE + "/operations/00000000-0000-4000-8000-000000000001";
  const expired = F.delegation(m, { uri, action: "operation.read", now: Date.now() - 3600000 });
  const res = await client.getOperation("00000000-0000-4000-8000-000000000001", { delegation: expired });
  assert.equal(res.status, 403);

  const { text } = await metricsText(app.port);
  assert.ok(series(text, "karryam_admin_requests_total").some((l) => l.includes('endpoint="manifest"') && l.includes('status_class="2xx"')), text);
  assert.ok(series(text, "karryam_admin_service_auth_failures_total").reduce((n, l) => n + Number(l.split(" ").pop()), 0) >= 2);
  assert.ok(series(text, "karryam_admin_delegation_failures_total").length >= 1);
  assert.ok(series(text, "karryam_admin_authorization_denials_total").some((l) => l.includes('reason="DELEGATION_INVALID"')));
  assert.ok(series(text, "karryam_admin_request_duration_seconds_bucket").length > 0);
  assert.ok(series(text, "karryam_admin_certificate_expiry_timestamp_seconds").some((l) => l.includes('kind="hq_service_key"')));
  // Never staff, tokens, keys or raw paths.
  for (const forbidden of ["staff-17", "session-17", expired.slice(0, 24), m.hqKey.toString("base64url"), "00000000-0000-4000-8000-000000000001"]) {
    assert.equal(text.includes(forbidden), false, "metrics leak: " + forbidden);
  }
  // Readiness has dependency detail but no secrets.
  const ready = await F.rawRequest(app.port, { path: "/health/ready" });
  assert.equal(ready.status, 200);
  assert.equal(ready.json.bridge_state.configured, false);
  assert.equal(ready.json.bridge_state.certified, false);
  assert.equal(ready.json.worker.feed, "DISABLED");
  assert.equal(JSON.stringify(ready.json).includes(m.dir), false);
  // Without a pipeline store /sync/status says so honestly.
  const s = await F.rawRequest(app.port, { path: "/sync/status" });
  assert.equal(s.status, 200);
  assert.equal(s.json.status, "FEED_DISABLED");
});

test("Bridge outcomes, command signals and label sanitization", async () => {
  const obs = createKarryamMetrics({ config: { enabled: false } });
  obs.observeBridge({ outcome: "SUCCESS" });
  obs.observeBridge({ outcome: "RATE_LIMITED" });
  obs.observeBridge({ outcome: "TRANSPORT_SECURITY" });
  obs.signal("dispatch", "UNKNOWN_OUTCOME");
  obs.signal("readback", "SETTLED_BY_READBACK");
  obs.observeRequest({ endpoint: "operationSubmit", status: 409, code: "CONFLICT", reason: "IDEMPOTENCY_KEY_REUSED", duration_ms: 3 });
  obs.observeRequest({ endpoint: "operationSubmit", status: 503, code: "UNAVAILABLE", reason: "AUDIT_UNAVAILABLE", duration_ms: 3 });
  obs.observeRequest({ endpoint: "manifest", status: 401, code: "UNAUTHENTICATED", reason: "SERVICE_AUTH_FAILED", auth_failure: "NONCE_REPLAYED", duration_ms: 1 });
  obs.observeRequest({ endpoint: "evil\"} 1\nfake_metric 9", status: 404, code: "NOT_FOUND", reason: "x".repeat(500), duration_ms: 1 });
  const text = await obs.render();
  assert.match(text, /karryam_admin_bridge_requests_total\{outcome="RATE_LIMITED"\} 1/);
  assert.match(text, /karryam_admin_command_dispatch_total\{status="UNKNOWN_OUTCOME"\} 1/);
  assert.match(text, /karryam_admin_command_readback_total\{state="SETTLED_BY_READBACK"\} 1/);
  assert.match(text, /karryam_admin_command_requests_total\{result="REFUSED",reason="IDEMPOTENCY_KEY_REUSED"\} 1/);
  assert.match(text, /karryam_admin_audit_persistence_failures_total 1/);
  assert.match(text, /karryam_admin_replay_rejections_total\{kind="service_nonce"\} 1/);
  assert.equal(/^fake_metric/m.test(text), false, "label injection is neutralised");
  assert.equal(obs.lastBridgeOutcome().outcome, "TRANSPORT_SECURITY");
});

test("every exported metric name is stable and prefixed", () => {
  const names = karryamMetricNames();
  assert.ok(names.length > 30);
  for (const n of names) assert.match(n, /^karryam_admin_[a-z0-9_]+$/);
  for (const n of ["karryam_admin_bridge_unacked_events", "karryam_admin_hq_outbox_unacked_events", "karryam_admin_entity_version_gaps_open", "karryam_admin_operations_unknown_outcome_oldest_age_seconds", "karryam_admin_schema_migrations_applied"]) assert.ok(names.includes(n), n);
});

test("logs redact credential-bearing URIs, tokens and keys", () => {
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l) });
  log({ event: "x", database: "postgresql://karryam_admin_runtime:S3cretPass@db.internal:5432/karryam_admin", note: "Authorization: Bearer abcDEF123.xyz", jwt: "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJzdGFmZi0xNyJ9.c2lnbmF0dXJl", token: "plain-token-value", nested: { note: ["-----BEGIN", "PRIVATE KEY-----\nMC4CAQ\n-----END", "PRIVATE KEY-----"].join(" ") } });
  const out = lines.join("\n");
  for (const secret of ["S3cretPass", "abcDEF123", "eyJzdWIiOiJzdGFmZi0xNyJ9", "plain-token-value", "MC4CAQ"]) assert.equal(out.includes(secret), false, secret);
  assert.match(out, /postgresql:\/\/\[redacted\]@db\.internal/);
  assert.equal(redact("https://bridge.karryam.internal:8110/"), "https://bridge.karryam.internal:8110/");
});
