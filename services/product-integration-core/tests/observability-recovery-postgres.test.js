"use strict";

// Section 12.5 for the Product Integration Core on disposable PostgreSQL:
// private /metrics (bounded labels, no identities), readiness, a database
// outage with recovery, and a PIC process restart (new pool, new worker
// identity) that resumes from the persisted cursor without duplicates.
// Existing suites already cover crash-after-commit-before-ACK, ACK
// withholding when the gate closes, lease fencing and signer revocation
// (sync-gate-postgres, sync-postgres, sync-policy, karryam-two-stage).

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Client, Pool } = require("pg");
const { startHarness, available } = require("./helpers/harness");
const { ADMIN_URL } = require("./helpers/db");
const { createSyncEngine } = require("../src/sync/engine");
const { listMigrations } = require("../src/db/migrate");
const { createLogger } = require("../src/logger");

const skip = !available() && "PIC_TEST_DATABASE_URL not set (disposable PostgreSQL required)";

function getRaw(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* text */ } resolve({ status: res.statusCode, text: data, json, type: res.headers["content-type"] }); });
    }).on("error", reject);
  });
}

const value = (text, line) => {
  const hit = text.split("\n").find((l) => l.startsWith(line + " "));
  return hit === undefined ? undefined : Number(hit.split(" ").pop());
};
const sum = (text, prefix) => text.split("\n").filter((l) => l.startsWith(prefix)).reduce((n, l) => n + Number(l.split(" ").pop()), 0);

test("PIC metrics, readiness, database outage and restart recovery", { skip, timeout: 180000 }, async (t) => {
  const h = await startHarness();
  t.after(h.close);
  // The outage below terminates every backend, including idle harness clients.
  h.pool.on("error", () => {});
  h.database.migClient.on("error", () => {});
  const P = h.product;
  const { id } = await h.registerAndEnable();
  await h.grantViewer("staff-viewer");
  const q = (sql, params) => h.pool.query(sql, params).then((r) => r.rows);

  await t.test("/metrics: route classes, delegation and authorization failures, registry gauges; never identities", async () => {
    P.emitMetric({ value: 7 });
    await h.engine.tick();
    assert.equal((await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=NG&tenant=tenant-a")).status, 200);
    // No delegation, a delegation bound to another path, a stranger, and a foreign tenant.
    assert.equal((await h.call("staff-viewer", "GET", "/products", undefined, { raw: true })).status, 401);
    assert.equal((await h.call("staff-viewer", "GET", "/products", undefined, { tamper: { path: "/admin/product-integrations" } })).status, 401);
    assert.equal((await h.call("staff-stranger", "GET", "/products/" + P.PRODUCT_ID + "/datasets")).status, 403);
    assert.equal((await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=NG&tenant=tenant-b")).status, 403);

    const m = await getRaw(h.port, "/metrics");
    assert.equal(m.status, 200);
    assert.match(m.type, /^text\/plain; version=0\.0\.4/);
    assert.ok(m.text.includes('pic_requests_total{route="/products/:p/metrics/:p",status_class="2xx",code="OK"}'), m.text.slice(0, 3000));
    assert.ok(sum(m.text, "pic_delegation_failures_total{") >= 2);
    assert.ok(sum(m.text, "pic_authorization_denials_total{") >= 2);
    assert.equal(value(m.text, "pic_database_up"), 1);
    assert.equal(value(m.text, `pic_product_admin_state{product="${P.PRODUCT_ID}",dimension="lifecycle",state="ENABLED"}`), 1);
    assert.equal(value(m.text, `pic_cursor_unacked_events{product="${P.PRODUCT_ID}",dataset="${P.DATASET_ID}"}`), 0);
    assert.equal(value(m.text, `pic_quarantine_open{product="${P.PRODUCT_ID}"}`), 0);
    assert.ok(value(m.text, `pic_product_manifest_expires_in_seconds{product="${P.PRODUCT_ID}"}`) > 0);
    assert.equal(value(m.text, "pic_schema_migrations_applied"), listMigrations().length);
    assert.equal(value(m.text, "pic_schema_migrations_checksum_mismatch"), 0);
    for (const forbidden of ["staff-viewer", "staff-stranger", "sess-", id, "tenant-b\""]) assert.equal(m.text.includes(forbidden), false, "metrics leak: " + forbidden);
    // Path validation still applies to the private routes.
    assert.equal((await getRaw(h.port, "/%6detrics")).status, 400);
    const ready = await getRaw(h.port, "/health/ready");
    assert.equal(ready.status, 200);
    assert.equal(ready.json.trust_store, "UNBOUND");
  });

  await t.test("database outage: readiness 503 and database_up 0; recovery applies each event exactly once", async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    t.after(() => admin.end());
    const before = (await q("SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox WHERE product_admin_id = $1", [id]))[0].n;
    const acksBefore = P.state.acks.length;
    P.emitMetric({ value: 8 });
    P.emitMetric({ value: 9 });
    await admin.query(`ALTER DATABASE ${h.database.database} ALLOW_CONNECTIONS false`);
    try {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [h.database.database]);
      const ready = await getRaw(h.port, "/health/ready");
      assert.equal(ready.status, 503);
      assert.equal(ready.json.database, "UNAVAILABLE");
      const m = await getRaw(h.port, "/metrics");
      assert.equal(m.status, 200);
      assert.equal(value(m.text, "pic_database_up"), 0);
      await assert.rejects(h.engine.tick());
      assert.equal(P.state.acks.length, acksBefore, "nothing acknowledged while HQ cannot commit");
    } finally {
      await admin.query(`ALTER DATABASE ${h.database.database} ALLOW_CONNECTIONS true`);
    }
    await h.pool.query("UPDATE hq_integration.hq_product_admin_sync_cursors SET lease_expires_at = now() - interval '1 second'");
    await h.engine.tick();
    const after = (await q("SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox WHERE product_admin_id = $1", [id]))[0].n;
    assert.equal(after, before + 2);
    const [cursor] = await q("SELECT last_sequence, acked_sequence FROM hq_integration.hq_product_admin_sync_cursors");
    assert.equal(Number(cursor.acked_sequence), Number(cursor.last_sequence));
    assert.equal(P.state.acks.at(-1).sequence, Number(cursor.last_sequence));
    assert.equal((await getRaw(h.port, "/health/ready")).status, 200);
  });

  await t.test("PIC restart: a new process (pool + worker identity) resumes from the persisted cursor", async () => {
    const [{ last_sequence: committed }] = await q("SELECT last_sequence FROM hq_integration.hq_product_admin_sync_cursors");
    P.emitMetric({ value: 10 });
    const pool = new Pool({ connectionString: h.database.runtimeUrl, max: 4 });
    pool.on("error", () => {});
    t.after(() => pool.end());
    const restarted = createSyncEngine({ pool, endpoints: h.endpoints, environment: "test", trustStore: h.trustStore, now: h.now, leaseSeconds: 30, workerId: "pic-worker-restarted" });
    const out = await restarted.tick();
    const part = out[0].results[0];
    assert.equal(part.status, "SUCCEEDED", JSON.stringify(out));
    const [cursor] = await q("SELECT last_sequence, acked_sequence FROM hq_integration.hq_product_admin_sync_cursors");
    assert.equal(Number(cursor.last_sequence), Number(committed) + 1, "exactly one new event applied");
    const dupes = await q("SELECT event_id, count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox WHERE product_admin_id = $1 GROUP BY 1 HAVING count(*) > 1", [id]);
    assert.deepEqual(dupes, []);
  });

  await t.test("logs redact credential-bearing URIs and tokens", () => {
    const lines = [];
    const log = createLogger({ write: (l) => lines.push(l) });
    log({ event: "x", url: h.database.runtimeUrl, auth: "Bearer abc.def.ghi", note: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdGFmZiJ9.abcdef" });
    const out = lines.join("\n");
    assert.equal(out.includes(h.database.password), false);
    assert.equal(out.includes("eyJzdWIiOiJzdGFmZiJ9"), false);
    assert.match(out, /postgresql:\/\/\[redacted\]@/);
  });
});
