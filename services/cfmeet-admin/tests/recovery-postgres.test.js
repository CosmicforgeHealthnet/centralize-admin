"use strict";

// Functional suite: runs against HQ's interface-v1 target registry (see helpers/target-contract.js).
require("./helpers/target-contract");


// Section 12.5 recovery on disposable PostgreSQL with the disposable secure
// Bridge (TLS 1.3 mTLS, HMAC v2, Ed25519). Complements pipeline-postgres:
// that suite already covers crash before/after commit, ACK retry, lease
// expiry takeover, Bridge outage (paused), transport revocation and
// reconciliation duplicates. This suite adds:
//   - a full worker process restart (new pool, store and worker identity)
//     resuming from the persisted cursor;
//   - a PostgreSQL outage: readiness and metrics report it, nothing is ACKed,
//     and recovery applies every event exactly once;
//   - scrape-time gauges for holds, quarantine, the unacked HQ outbox and the
//     migration ledger, and the operator /sync/status view.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const { Client, Pool } = require("pg");
const { migrate, listMigrations } = require("../scripts/migrate");
const { createPipelineStore, partitionKeyFor } = require("../src/sync/store");
const { createBridgeConsumer } = require("../src/sync/bridge-consumer");
const { createBridgeClient } = require("../src/bridge/client");
const { ping } = require("../src/db/pool");
const { createCfmeetMetrics } = require("../src/observability/metrics");
const { startFakeBridge, bridgeConfigFor } = require("./helpers/fake-bridge");
const { generatePki } = require("../../../packages/service-clients/tests/helpers/pki");
const X = require("./helpers/bridge-fixtures");
const F = require("./helpers/fixtures");

const ADMIN_URL = process.env.CFMEET_ADMIN_TEST_DATABASE_URL;
const SCOPE = { market: "NG-LAGOS", organization: "cfmeet-ng", zone: "lagos-island", tenant: "tenant-r" };
const KEY = partitionKeyFor(SCOPE);

function withDb(base, db, user, password) {
  const url = new URL(base);
  url.pathname = "/" + db;
  if (user) { url.username = user; url.password = password || ""; }
  return url.toString();
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* text */ } resolve({ status: res.statusCode, text: data, json }); });
    }).on("error", reject);
  });
}

const gauge = (text, line) => {
  const hit = text.split("\n").find((l) => l.startsWith(line + " "));
  return hit === undefined ? undefined : Number(hit.split(" ").pop());
};

test("CF Meet Admin recovery: restart, PostgreSQL outage and recovery signals", { skip: !ADMIN_URL && "CFMEET_ADMIN_TEST_DATABASE_URL not set", timeout: 180000 }, async (t) => {
  let pki;
  try { pki = generatePki({ serverName: "bridge.cfmeet.internal" }); } catch { t.skip("openssl unavailable"); return; }
  const suffix = randomBytes(4).toString("hex");
  const db = "ka_rec_" + suffix;
  const migrator = "ka_rec_mig_" + suffix;
  const runtime = "ka_rec_rt_" + suffix;
  const password = randomBytes(12).toString("hex");
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE ROLE ${migrator} LOGIN PASSWORD '${password}'`);
  await admin.query(`CREATE ROLE ${runtime} LOGIN PASSWORD '${password}'`);
  await admin.query(`CREATE DATABASE ${db} OWNER ${migrator}`);
  await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${runtime}`);
  await migrate({ connectionString: withDb(ADMIN_URL, db, migrator, password), runtimeRole: runtime });
  const pools = [];
  const newPool = () => { const p = new Pool({ connectionString: withDb(ADMIN_URL, db, runtime, password), max: 4, connectionTimeoutMillis: 2000 }); p.on("error", () => {}); pools.push(p); return p; };
  t.after(async () => {
    for (const p of pools) await p.end().catch(() => {});
    await admin.query(`ALTER DATABASE ${db} ALLOW_CONNECTIONS true`).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${runtime}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${migrator}`).catch(() => {});
    await admin.end();
  });

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = randomBytes(32);
  const fake = await startFakeBridge({ pki, workloadUri: "cf://test/hq/product-integration-core", staffPublicKey: publicKey, hmacKeys: { "svc-1": { secret, expires: Date.now() + 3600000 } } });
  t.after(async () => { await fake.close(); pki.cleanup(); });
  const bridge = bridgeConfigFor(pki, fake.port, { staffPrivateKey: privateKey, hmacSecret: secret, tenants: [SCOPE.tenant] });
  const feed = { enabled: true, scopes: [SCOPE], consumer: "cfmeet-admin-recovery", subject: "svc-cfmeet-admin", role: "hq.cfmeet.read", acr: "workload", purpose: "event-sync", pageSize: 50, pollSeconds: 5, rewindEvents: 20, reconcileSeconds: 300, retentionDays: 7, leaseSeconds: 30 };
  const worker = async (pool, workerId) => {
    const store = createPipelineStore(pool, { serviceInstanceId: F.INSTANCE });
    const c = createBridgeConsumer({ feed, store, bridgeClient: createBridgeClient(bridge), workerId });
    await c.init();
    return { store, c };
  };
  const count = async (pool, sql, params) => (await pool.query(sql, params)).rows[0].n;

  // Process 1.
  const pool1 = newPool();
  const w1 = await worker(pool1, "cfmeet-worker-1");
  const ackName = w1.c.consumerName(KEY);
  let restarted = null;

  await t.test("worker restart resumes from the persisted cursor; nothing is re-applied or lost", async () => {
    for (const ref of ["r-1", "r-2", "r-3"]) fake.publish((n) => X.abuseEvent({ sequence: n, ref, scope: SCOPE }));
    const [a] = await w1.c.tick();
    assert.equal(a.status, "SUCCEEDED", JSON.stringify(a));
    assert.equal(a.applied, 3);
    const committed = Number((await pool1.query("SELECT last_sequence FROM cfmeet_admin.bridge_feed_partitions WHERE partition_key = $1", [KEY])).rows[0].last_sequence);
    assert.equal(fake.state.consumers[ackName], committed);
    // The process dies (its pool goes away); events keep arriving.
    await pool1.end();
    fake.publish((n) => X.abuseEvent({ sequence: n, ref: "r-4", scope: SCOPE }));
    fake.publish((n) => X.abuseEvent({ sequence: n, ref: "r-2", version: 2, status: "ACTIONED", scope: SCOPE }));
    // Process 2: new pool, new store, new worker identity.
    const pool2 = newPool();
    const w2 = await worker(pool2, "cfmeet-worker-2");
    restarted = { pool: pool2, w: w2 };
    const feedCalls = fake.state.requests.filter((r) => r.capability === "hq.events.feed").length;
    const [b] = await w2.c.tick();
    assert.equal(b.status, "SUCCEEDED", JSON.stringify(b));
    assert.equal(b.applied, 2, "only the two new events");
    const firstFeed = fake.state.requests.filter((r) => r.capability === "hq.events.feed")[feedCalls];
    assert.match(firstFeed.url, new RegExp("cursor=" + committed + "(&|$)"), "resumed from the persisted cursor");
    assert.equal(await count(pool2, "SELECT count(*)::int AS n FROM cfmeet_admin.bridge_event_inbox WHERE partition_key = $1", [KEY]), 5);
    assert.equal(await count(pool2, "SELECT count(*)::int AS n FROM cfmeet_admin.entity_projections WHERE partition_key = $1 AND entity_ref = 'r-2' AND entity_version = 2", [KEY]), 1);
  });

  const pool = restarted ? restarted.pool : newPool();
  const { store, c } = restarted ? restarted.w : await worker(pool, "cfmeet-worker-2");
  const obs = createCfmeetMetrics({ config: F.loadConfig({}), pool });
  const m = F.material();
  t.after(m.cleanup);
  const config = Object.freeze({ ...F.loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_CERTIFIED_DATASETS: "cfmeet.trust_safety_queue,cfmeet.sync_health" })), bridge, cursorKey: randomBytes(32), enabledCommands: [], feed });
  const app = await F.startApp(config, { pipeline: store, pool, observability: obs, dbReady: () => ping(pool) });
  t.after(app.close);

  await t.test("PostgreSQL outage: readiness 503, metrics report it, no ACK; recovery applies each event once", async () => {
    const ackBefore = fake.state.consumers[ackName];
    const inboxBefore = await count(pool, "SELECT count(*)::int AS n FROM cfmeet_admin.bridge_event_inbox");
    fake.publish((n) => X.abuseEvent({ sequence: n, ref: "r-5", scope: SCOPE }));
    fake.publish((n) => X.abuseEvent({ sequence: n, ref: "r-6", scope: SCOPE }));
    await admin.query(`ALTER DATABASE ${db} ALLOW_CONNECTIONS false`);
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [db]);

    const ready = await get(app.port, "/health/ready");
    assert.equal(ready.status, 503);
    assert.equal(ready.json.database, "UNAVAILABLE");
    const down = await get(app.port, "/metrics");
    assert.equal(down.status, 200, "metrics stay scrapeable during the outage");
    assert.equal(gauge(down.text, "cfmeet_admin_database_up"), 0);
    assert.ok(gauge(down.text, 'cfmeet_admin_metrics_collector_errors_total{collector="database"}') >= 1);
    const status = await get(app.port, "/sync/status");
    assert.equal(status.status, 503);

    const [failed] = await c.tick().catch(() => [{ status: "FAILED" }]);
    assert.notEqual(failed.status, "SUCCEEDED");
    assert.equal(fake.state.consumers[ackName], ackBefore, "nothing is ACKed while the database is down");

    await admin.query(`ALTER DATABASE ${db} ALLOW_CONNECTIONS true`);
    // A held lease from the failed attempt (if any) expires before the retry.
    await pool.query("UPDATE cfmeet_admin.bridge_feed_partitions SET lease_expires_at = now() - interval '1 second' WHERE partition_key = $1", [KEY]);
    const [ok] = await c.tick();
    assert.equal(ok.status, "SUCCEEDED", JSON.stringify(ok));
    assert.equal(ok.applied, 2);
    assert.equal(await count(pool, "SELECT count(*)::int AS n FROM cfmeet_admin.bridge_event_inbox"), inboxBefore + 2);
    const p = (await pool.query("SELECT last_sequence, acked_sequence FROM cfmeet_admin.bridge_feed_partitions WHERE partition_key = $1", [KEY])).rows[0];
    assert.equal(Number(p.acked_sequence), Number(p.last_sequence));
    assert.equal(fake.state.consumers[ackName], Number(p.last_sequence));
    assert.equal((await get(app.port, "/health/ready")).status, 200);

    const up = await get(app.port, "/metrics");
    assert.equal(gauge(up.text, "cfmeet_admin_database_up"), 1);
    assert.equal(gauge(up.text, `cfmeet_admin_bridge_unacked_events{partition="${KEY}"}`), 0);
    assert.equal(gauge(up.text, `cfmeet_admin_bridge_integrity_hold{partition="${KEY}"}`), 0);
    assert.equal(gauge(up.text, "cfmeet_admin_schema_migrations_applied"), listMigrations().length);
    assert.equal(gauge(up.text, "cfmeet_admin_schema_migrations_expected"), listMigrations().length);
    assert.equal(gauge(up.text, "cfmeet_admin_schema_migrations_checksum_mismatch"), 0);
    assert.ok(gauge(up.text, 'cfmeet_admin_hq_outbox_unacked_events{dataset="cfmeet.sync_health"}') > 0, "HQ has not acknowledged the derived outbox yet");
  });

  await t.test("an integrity incident is visible as a hold, quarantine and in /sync/status", async () => {
    const known = (await pool.query("SELECT event_id FROM cfmeet_admin.bridge_event_inbox WHERE partition_key = $1 ORDER BY sequence LIMIT 1", [KEY])).rows[0].event_id;
    fake.publish((n) => X.abuseEvent({ sequence: n, ref: "r-1", status: "ESCALATED", eventId: known, scope: SCOPE }));
    const ackBefore = fake.state.consumers[ackName];
    const [held] = await c.tick();
    assert.notEqual(held.status, "SUCCEEDED");
    assert.equal(fake.state.consumers[ackName], ackBefore, "never ACKed past the incident");
    const text = (await get(app.port, "/metrics")).text;
    assert.equal(gauge(text, `cfmeet_admin_bridge_integrity_hold{partition="${KEY}"}`), 1);
    assert.ok(gauge(text, `cfmeet_admin_quarantine_open{partition="${KEY}"}`) >= 1);
    const s = await get(app.port, "/sync/status");
    assert.equal(s.status, 200);
    const part = s.json.partitions.find((x) => x.partition_key === KEY);
    assert.ok(part.hold && part.hold.reason, JSON.stringify(part));
    assert.ok(s.json.quarantine.length >= 1);
    assert.ok(s.json.hq_outbox.some((o) => o.dataset_id === "cfmeet.sync_health" && o.unacked > 0));
    // The operator view never carries payloads or staff identities.
    assert.equal(JSON.stringify(s.json).includes("severity"), false);
    const ready = await get(app.port, "/health/ready");
    assert.equal(ready.json.worker.held, 1);
  });
});
