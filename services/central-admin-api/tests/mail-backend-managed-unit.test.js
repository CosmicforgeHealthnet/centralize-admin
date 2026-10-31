"use strict";

// Backend-managed core Mail (incident repair), offline unit tests:
// config defaults, core queue decisions, worker heartbeat + pause reporting,
// heartbeat summaries, reconciliation ownership/limits/backoff, ops alerts,
// operational readiness, deploy verification and the idle worker process.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMailConfig } = require("../src/modules/mail/mail.config");
const { createRolloutService } = require("../src/modules/mail/ops/rollout.service");
const { createMailWorker } = require("../src/modules/mail/jobs/mail-worker");
const { summarizeWorkers, listWorkerHeartbeats, createWorkerHeartbeat, instanceKey } = require("../src/modules/mail/jobs/worker-heartbeat");
const { createInboundReconciler } = require("../src/modules/mail/pipelines/inbound-reconciler");
const { operationalState } = require("../src/modules/mail/ops/dependency-readiness");
const { createOpsMonitor } = require("../src/modules/mail/ops/ops-monitor.service");
const { verifyWorker } = require("../src/modules/mail/ops/worker-verification");
const { MailProviderError } = require("../src/modules/mail/adapters/mail-provider.contract");

const production = (extra = {}) => ({ NODE_ENV: "production", MAIL_DEPLOYMENT_ENV: "production", MAIL_ENABLED: "true", MAIL_SENDING_ENABLED: "true", MAIL_RECEIVING_ENABLED: "true", MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production", MAIL_DOMAIN_ALLOWLIST: "karryam.com", ...extra });

test("config: the core worker is on with Mail unless explicitly shut down", () => {
  assert.equal(loadMailConfig(production()).workerEnabled, true, "no MAIL_WORKER_ENABLED needed");
  assert.equal(loadMailConfig(production({ MAIL_WORKER_ENABLED: "" })).workerEnabled, true);
  assert.equal(loadMailConfig(production({ MAIL_WORKER_ENABLED: "true" })).workerEnabled, true);
  assert.equal(loadMailConfig(production({ MAIL_WORKER_ENABLED: "false" })).workerEnabled, false, "explicit emergency shutdown");
  assert.equal(loadMailConfig(production({ MAIL_ENABLED: "false" })).workerEnabled, false, "Mail off keeps everything off");
  assert.equal(loadMailConfig(production()).marketingEnabled, false, "marketing stays off unless separately enabled");
});

test("config: inbound reconciliation defaults on only for the receiving inbound owner", () => {
  assert.equal(loadMailConfig(production()).reconciliation.enabled, true, "production owner reconciles by default");
  assert.equal(loadMailConfig(production({ MAIL_DEPLOYMENT_ENV: "staging", NODE_ENV: "staging" })).reconciliation.enabled, false, "staging does not own inbound (shared Resend account)");
  assert.equal(loadMailConfig(production({ MAIL_RECEIVING_ENABLED: "false" })).reconciliation.enabled, false);
  assert.equal(loadMailConfig(production({ MAIL_RECONCILIATION_ENABLED: "false" })).reconciliation.enabled, false, "explicit override");
  assert.equal(loadMailConfig({ NODE_ENV: "test", MAIL_ENABLED: "true", MAIL_RECEIVING_ENABLED: "true" }).reconciliation.enabled, false, "tests/dev opt in explicitly");
  assert.equal(loadMailConfig({ NODE_ENV: "test", MAIL_ENABLED: "true", MAIL_RECEIVING_ENABLED: "true", MAIL_RECONCILIATION_ENABLED: "true" }).reconciliation.enabled, true);
});

function rolloutWith(rules = [], env = production()) {
  const client = {
    mailRolloutRule: { findMany: async () => rules },
    mailEmergencyStop: { findMany: async () => [] },
    mailRolloutCohortMember: { findMany: async () => [] },
  };
  return createRolloutService({ client, config: loadMailConfig(env), audit: { record: async () => {} }, stepUp: {} });
}
const rule = (capability, effect = "ALLOW") => ({ capability, scopeType: "ENVIRONMENT", scopeId: null, effect });

test("core queues follow backend flags with zero rollout rules (production enforcement)", async () => {
  const rollout = rolloutWith([]);
  assert.deepEqual(await rollout.workerQueueDecisions(["OUTBOUND", "INBOUND", "EVENTS", "MARKETING"]), [
    { queue: "OUTBOUND", allowed: true, reason: null },
    { queue: "INBOUND", allowed: true, reason: null },
    { queue: "EVENTS", allowed: true, reason: null },
    { queue: "MARKETING", allowed: false, reason: "MAIL_ROLLOUT_NOT_ENABLED" },
  ]);
  assert.deepEqual(await rolloutWith([rule("WORKER_INBOUND", "DENY")]).workerQueueDecisions(["INBOUND"]), [{ queue: "INBOUND", allowed: false, reason: "EMERGENCY_DENY_RULE" }]);
  assert.deepEqual(await rolloutWith([], production({ MAIL_RECEIVING_ENABLED: "false" })).workerQueueDecisions(["INBOUND"]), [{ queue: "INBOUND", allowed: false, reason: "RECEIVING_DISABLED" }]);
  assert.deepEqual(await rolloutWith([], production({ MAIL_DEPLOYMENT_ENV: "staging", NODE_ENV: "staging" })).workerQueueDecisions(["INBOUND"]), [{ queue: "INBOUND", allowed: false, reason: "INBOUND_NOT_OWNED_HERE" }]);
  assert.deepEqual(await rolloutWith([], production({ MAIL_SENDING_ENABLED: "false" })).workerQueueDecisions(["OUTBOUND"]), [{ queue: "OUTBOUND", allowed: false, reason: "SENDING_DISABLED" }]);
  assert.deepEqual(await rolloutWith([rule("WORKER_MARKETING")]).workerQueuesAllowed(["MARKETING"]), ["MARKETING"], "optional marketing still uses rollout");
});

function memoryJobs(initial = [], { recovered = [] } = {}) {
  const pending = [...initial];
  const calls = { complete: [], fail: [] };
  return {
    calls,
    recoverExpiredLeases: async () => recovered.splice(0),
    claim: async ({ queues, limit }) => {
      const taken = [];
      for (let index = pending.length - 1; index >= 0 && taken.length < limit; index -= 1) if (queues.includes(pending[index].queue)) taken.push(...pending.splice(index, 1));
      return taken;
    },
    complete: async (job) => { calls.complete.push(job.id); return true; },
    fail: async (job, input) => { calls.fail.push({ id: job.id, ...input }); return { updated: true, status: input.retryable ? "RETRY_SCHEDULED" : "FAILED" }; },
    defer: async () => ({ updated: true }),
  };
}
const quiet = { info() {}, warn() {}, error() {} };
const workerConfig = { worker: { concurrency: 4, leaseSeconds: 120, pollIntervalMs: 5, drainTimeoutMs: 1000, heartbeatIntervalSeconds: 30 } };

test("worker: paused queues are reported in the heartbeat, served queues are processed, STOPPED on shutdown", async () => {
  const beats = [];
  const jobs = memoryJobs([{ id: "in-1", queue: "INBOUND", kind: "OK" }, { id: "ev-1", queue: "EVENTS", kind: "OK" }]);
  const worker = createMailWorker({
    jobs,
    config: workerConfig,
    logger: quiet,
    handlers: { OK: async () => ({}) },
    queues: ["INBOUND", "EVENTS"],
    queueDecisions: async (queues) => queues.map((queue) => (queue === "INBOUND" ? { queue, allowed: false, reason: "EMERGENCY_DENY_RULE" } : { queue, allowed: true, reason: null })),
    heartbeat: { beat: async (state, options) => { beats.push({ ...state, force: options?.force || false }); return true; } },
  });
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await worker.stop();
  assert.deepEqual(jobs.calls.complete, ["ev-1"], "only the served queue was processed");
  const running = beats.find((beat) => beat.state === "RUNNING");
  assert.ok(running, "a RUNNING heartbeat was recorded");
  assert.deepEqual(running.activeQueues, ["EVENTS"]);
  assert.deepEqual(running.pausedQueues, [{ queue: "INBOUND", reason: "EMERGENCY_DENY_RULE" }]);
  assert.equal(beats.at(-1).state, "STOPPED");
  assert.equal(beats.at(-1).force, true);
});

test("worker restart: leases expired by a crashed worker are recovered by the next worker", async () => {
  const recovered = [{ job: { id: "in-9", queue: "INBOUND", kind: "OK" }, status: "RETRY_SCHEDULED" }];
  const jobs = memoryJobs([], { recovered });
  const worker = createMailWorker({ jobs, config: workerConfig, logger: quiet, handlers: { OK: async () => ({}) }, queues: ["INBOUND"] });
  await worker.tick();
  assert.equal(worker.metrics.recovered, 1);
});

test("heartbeats: stale = NOT_RUNNING; a core queue nobody serves = DEGRADED; keys are stable per queue set", async () => {
  const now = new Date("2026-10-31T12:00:00Z");
  const row = (key, ageSeconds, payload) => ({ idempotencyKey: `worker-heartbeat:production:${key}`, completedAt: new Date(now.getTime() - ageSeconds * 1000), payload });
  const client = { mailOutboxJob: { findMany: async () => [row("a", 20, { state: "RUNNING", activeQueues: ["OUTBOUND", "EVENTS"], pausedQueues: [{ queue: "INBOUND", reason: "EMERGENCY_DENY_RULE" }], release: "img:1", database: "cosmicforge_admin" }), row("b", 900, { state: "RUNNING", activeQueues: ["INBOUND"] })] } };
  const workers = await listWorkerHeartbeats(client, { clock: () => now, staleAfterSeconds: 180 });
  assert.equal(workers[0].state, "RUNNING");
  assert.equal(workers[1].state, "NOT_RUNNING", "a silent worker is not running whatever it last said");
  const summary = summarizeWorkers(workers, { coreQueues: ["OUTBOUND", "INBOUND", "EVENTS"] });
  assert.equal(summary.state, "DEGRADED");
  assert.deepEqual(summary.unservedCoreQueues, ["INBOUND"]);
  assert.deepEqual(summary.pausedCoreQueues, [{ queue: "INBOUND", reason: "EMERGENCY_DENY_RULE" }]);
  assert.equal(summarizeWorkers([], { coreQueues: ["EVENTS"] }).state, "NOT_RUNNING");
  assert.equal(instanceKey({ environment: "production", queues: ["INBOUND", "OUTBOUND", "EVENTS"] }), "worker-heartbeat:production:events+inbound+outbound");
});

test("heartbeat writer: upserts a non-claimable row, throttled, never throws", async () => {
  const writes = [];
  let fail = false;
  const client = {
    $queryRawUnsafe: async () => [{ name: "cosmicforge_admin" }],
    mailOutboxJob: { upsert: async (input) => { if (fail) throw Object.assign(new Error("down"), { code: "P1001" }); writes.push(input); } },
  };
  let now = 0;
  const heartbeat = createWorkerHeartbeat({ client, config: { deploymentEnvironment: "production", worker: { heartbeatIntervalSeconds: 30, release: "ghcr.io/x:production-abc" } }, queues: ["INBOUND"], clock: () => new Date(now), logger: quiet });
  assert.equal(await heartbeat.beat({ state: "RUNNING", activeQueues: ["INBOUND"], metrics: { claimed: 2 } }), true);
  assert.equal(await heartbeat.beat({ state: "RUNNING" }), false, "throttled");
  now += 31000;
  fail = true;
  assert.equal(await heartbeat.beat({ state: "RUNNING" }), false, "a failed write is reported, not thrown");
  const [first] = writes;
  assert.equal(first.create.kind, "WORKER_HEARTBEAT");
  assert.equal(first.create.status, "SUCCEEDED", "never claimable");
  assert.equal(first.create.payload.database, "cosmicforge_admin");
  assert.equal(first.create.payload.release, "ghcr.io/x:production-abc");
  assert.equal(first.create.payload.counters.claimed, 2);
});

function reconcilerFixture({ items, known = {}, config = {}, listError = null } = {}) {
  const enqueued = [];
  const audits = [];
  let listed = 0;
  const client = {
    mailMessage: { findFirst: async ({ where }) => (known[where.providerMessageId] === "DELIVERED" ? { id: "m" } : null) },
    mailWebhookEvent: { findMany: async () => [] },
    mailOutboxJob: { findMany: async ({ where }) => (known[where.OR[0].idempotencyKey.split(":").pop()] === "IN_FLIGHT" ? [{ id: "j", status: "PENDING", idempotencyKey: where.OR[0].idempotencyKey }] : []) },
  };
  const adapter = {
    async listReceivedEmails() {
      listed += 1;
      if (listError) throw listError;
      return { items, hasMore: false };
    },
  };
  const now = new Date("2026-10-31T12:00:00Z");
  const reconciler = createInboundReconciler({
    client,
    config: { receivingEnabled: true, inbound: { ownedHere: true }, domainAllowlist: ["karryam.com"], worker: { maxAttempts: 6 }, reconciliation: { enabled: true, inboundLookbackHours: 24, inboundGraceSeconds: 600, inboundMaxPages: 5, inboundMaxEnqueuePerRun: 50, ...config } },
    adapter,
    jobs: { enqueue: async (tx, spec) => { enqueued.push(spec); return { created: true }; } },
    audit: { record: async (entry) => audits.push(entry) },
    clock: () => now,
  });
  const old = new Date(now.getTime() - 3600000);
  return { reconciler, enqueued, audits, old, now, listed: () => listed };
}

test("reconciliation: only our own mail, only our own addresses, no duplicates", async () => {
  const old = new Date("2026-10-31T11:00:00Z");
  const fixture = reconcilerFixture({
    items: [
      { providerEmailId: "ours", to: ["Favour@Karryam.com", "friend@gmail.com"], cc: [], bcc: [], createdAt: old },
      { providerEmailId: "bcc-ours", to: ["list@other.com"], cc: [], bcc: ["support@karryam.com"], createdAt: old },
      { providerEmailId: "foreign", to: ["someone@healthnet.example"], cc: [], bcc: [], createdAt: old },
      { providerEmailId: "delivered", to: ["favour@karryam.com"], createdAt: old },
      { providerEmailId: "inflight", to: ["favour@karryam.com"], createdAt: old },
      { providerEmailId: "fresh", to: ["favour@karryam.com"], createdAt: new Date("2026-10-31T11:59:00Z") },
    ],
    known: { delivered: "DELIVERED", inflight: "IN_FLIGHT" },
  });
  const result = await fixture.reconciler.process();
  assert.equal(result.recovered, 2);
  assert.equal(result.foreign, 1, "another product's mail is never fetched or queued");
  assert.deepEqual(fixture.enqueued.map((spec) => spec.idempotencyKey), ["inbound:reconcile:ours", "inbound:reconcile:bcc-ours"]);
  assert.deepEqual(fixture.enqueued[0].payload.to, ["favour@karryam.com"], "other parties' addresses are never stored");
  assert.deepEqual(fixture.enqueued[1].payload.to, ["support@karryam.com"]);
  assert.equal(fixture.audits[0].metadata.foreign, 1);
});

test("reconciliation: per-run enqueue cap; provider rate limit backs off with Retry-After; disabled/foreign owner skip", async () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ providerEmailId: `e${index}`, to: ["favour@karryam.com"], createdAt: null }));
  const fixture = reconcilerFixture({ items: items.map((item) => ({ ...item, createdAt: new Date("2026-10-31T10:00:00Z") })), config: { inboundMaxEnqueuePerRun: 3 } });
  const result = await fixture.reconciler.process();
  assert.equal(result.recovered, 3);
  assert.equal(result.capped, true);
  const limited = reconcilerFixture({ items: [], listError: new MailProviderError("RETRYABLE", "RESEND_HTTP_429", "rate limited", { category: "RATE_LIMITED", retryAfterSeconds: 30 }) });
  await assert.rejects(limited.reconciler.process(), (error) => error.retryable === true && error.retryAfterSeconds === 30);
  const noHeader = reconcilerFixture({ items: [], listError: new MailProviderError("RETRYABLE", "RESEND_HTTP_429", "rate limited", { category: "RATE_LIMITED" }) });
  await assert.rejects(noHeader.reconciler.process(), (error) => error.retryAfterSeconds === 60);
  const notOwner = createInboundReconciler({ client: {}, config: { receivingEnabled: true, inbound: { ownedHere: false }, reconciliation: { enabled: true } }, adapter: {}, jobs: {}, audit: {} });
  assert.deepEqual(await notOwner.process(), { skipped: "INBOUND_NOT_ACTIVE_HERE" });
});

test("readiness: a stopped worker or stalled inbound queue is DEGRADED, never a reason to refuse durable work", () => {
  const config = loadMailConfig(production());
  const degraded = operationalState({ config, workerState: { state: "NOT_RUNNING", unservedCoreQueues: [] }, queueHealth: { INBOUND: { pending: 2, leased: 0, retrying: 0, deadLetter: 0, failed24h: 0, oldestDueSeconds: 86400 }, EVENTS: { pending: 331, leased: 0, retrying: 0, deadLetter: 1, failed24h: 0, oldestDueSeconds: 90000 } } });
  assert.equal(degraded.state, "DEGRADED");
  assert.deepEqual(degraded.reasons, ["WORKER_NOT_RUNNING", "QUEUE_STALLED:INBOUND", "QUEUE_STALLED:EVENTS", "DEAD_LETTERS:EVENTS"]);
  const ok = operationalState({ config, workerState: { state: "RUNNING", running: 1, unservedCoreQueues: [], servedQueues: ["EVENTS", "INBOUND", "OUTBOUND"] }, queueHealth: { INBOUND: { pending: 0, deadLetter: 0, oldestDueSeconds: null } } });
  assert.equal(ok.state, "OK");
  assert.deepEqual(operationalState({ config: loadMailConfig(production({ MAIL_WORKER_ENABLED: "false" })), workerState: null, queueHealth: {} }).reasons, ["WORKER_DISABLED"]);
});

test("ops alerts: worker not running is critical; an unserved INBOUND queue is critical with its reason", () => {
  const config = loadMailConfig(production());
  const ops = createOpsMonitor({ client: {}, config, notifications: {} });
  const base = { queue: { oldestDueSeconds: {}, deadLetters24h: [] }, webhooks: { backlog: 0 }, scanning: { backlog: 0 }, delivery: { staff24h: {}, outcomeUnknown24h: 0, broadcast24h: [] }, integrations: { rejections1h: [] }, retention: {}, usageToday: [] };
  const codes = (snap) => ops.evaluate({ ...base, ...snap }).map((alert) => `${alert.code}:${alert.severity}`);
  assert.deepEqual(codes({ workers: { state: "NOT_RUNNING", lastHeartbeatAgeSeconds: null } }), ["MAIL_WORKER_NOT_RUNNING:critical"]);
  assert.deepEqual(codes({ workers: { state: "DEGRADED", unservedCoreQueues: ["INBOUND"], pausedCoreQueues: [{ queue: "INBOUND", reason: "EMERGENCY_DENY_RULE" }] } }), ["MAIL_WORKER_QUEUE_UNSERVED:critical"]);
  assert.deepEqual(codes({ workers: { state: "RUNNING", unservedCoreQueues: [] } }), []);
  assert.deepEqual(codes({ queue: { oldestDueSeconds: { INBOUND: 4000 }, deadLetters24h: [] }, workers: { state: "RUNNING", unservedCoreQueues: [] } }), ["MAIL_QUEUE_STALLED:critical"], "a growing backlog alerts");
});

function verifyClient({ heartbeats = [], database = "cosmicforge_admin", completeSelfTest = true }) {
  const jobs = new Map();
  return {
    jobs,
    $queryRawUnsafe: async () => [{ name: database }],
    mailOutboxJob: {
      findMany: async () => heartbeats,
      create: async ({ data }) => { jobs.set(data.idempotencyKey, { ...data, status: completeSelfTest ? "SUCCEEDED" : "PENDING", completedAt: completeSelfTest ? new Date() : null }); return data; },
      findUnique: async ({ where }) => jobs.get(where.idempotencyKey) || null,
      updateMany: async ({ where, data }) => { const job = jobs.get(where.idempotencyKey); if (job) Object.assign(job, data); return { count: job ? 1 : 0 }; },
    },
  };
}

test("deploy verification: an exited/absent worker, a worker on another database or one that cannot process never passes", async () => {
  const config = loadMailConfig(production());
  let t = Date.parse("2026-10-31T12:00:00Z");
  const clock = () => new Date(t);
  const sleep = async (ms) => { t += ms; };
  const beat = (payload, ageSeconds = 5) => ({ idempotencyKey: "worker-heartbeat:production:events+inbound+outbound", completedAt: new Date(t - ageSeconds * 1000), payload: { state: "RUNNING", activeQueues: ["OUTBOUND", "INBOUND", "EVENTS"], database: "cosmicforge_admin", release: "img:new", ...payload } });

  const none = await verifyWorker({ client: verifyClient({}), config, waitSeconds: 10, clock, sleep });
  assert.equal(none.ok, false);
  assert.equal(none.reason, "NO_FRESH_HEARTBEAT");

  const otherDb = await verifyWorker({ client: verifyClient({ heartbeats: [beat({ database: "rtc_db" })] }), config, waitSeconds: 10, clock, sleep });
  assert.equal(otherDb.reason, "WORKER_ON_OTHER_DATABASE");

  const oldRelease = await verifyWorker({ client: verifyClient({ heartbeats: [beat({ release: "img:old" })] }), config, expectRelease: "img:new", waitSeconds: 10, clock, sleep });
  assert.equal(oldRelease.reason, "WORKER_RELEASE_MISMATCH");

  const idle = await verifyWorker({ client: verifyClient({ heartbeats: [beat({ activeQueues: ["EVENTS"] })] }), config, waitSeconds: 10, clock, sleep });
  assert.equal(idle.reason, "CORE_QUEUE_NOT_SERVED");
  assert.deepEqual(idle.unservedQueues, ["OUTBOUND", "INBOUND"]);

  const stuck = verifyClient({ heartbeats: [beat({})], completeSelfTest: false });
  const notProcessed = await verifyWorker({ client: stuck, config, expectRelease: "img:new", waitSeconds: 10, clock, sleep });
  assert.equal(notProcessed.reason, "SELF_TEST_NOT_PROCESSED");
  assert.equal([...stuck.jobs.values()][0].status, "CANCELLED", "an unprocessed probe is never left behind");

  const healthy = await verifyWorker({ client: verifyClient({ heartbeats: [beat({})] }), config, expectRelease: "img:new", waitSeconds: 10, clock, sleep });
  assert.equal(healthy.ok, true, JSON.stringify(healthy));
  assert.equal(healthy.checks.selfTest, true);

  const disabled = await verifyWorker({ client: verifyClient({}), config: loadMailConfig(production({ MAIL_WORKER_ENABLED: "false" })), clock, sleep });
  assert.equal(disabled.applicable, false);
});

test("worker process: a disabled worker idles (no exit 0 that looks healthy) and records a DISABLED heartbeat", async () => {
  const { idle } = require("../src/mail-worker");
  const beats = [];
  const handlers = {};
  let exited = null;
  const intervals = [];
  const result = idle({
    reason: "MAIL_WORKER_ENABLED=false (explicit shutdown)",
    config: { worker: { heartbeatIntervalSeconds: 30 } },
    heartbeat: { beat: async (state) => { beats.push(state.state); return true; } },
    setTimer: (fn, ms) => { intervals.push(ms); return setInterval(fn, 1e9); },
    on: (event, handler) => { handlers[event] = handler; },
    exit: (code) => { exited = code; },
  });
  assert.equal(result.idle, true);
  assert.equal(exited, null, "the process does not exit by itself");
  assert.deepEqual(beats, ["DISABLED"]);
  assert.equal(intervals[0] >= 60000, true);
  handlers.SIGTERM();
  assert.equal(exited, 0, "it exits cleanly when the supervisor stops it");
});
