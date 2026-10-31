"use strict";

// Worker / outbound reliability (spec 17 "worker sends only after the
// transaction commits; failure paths carry correlation/job ids; independently
// controllable worker", spec 20 reliability). Unit tests use an in-memory job
// store; the PostgreSQL part replays every migration into a disposable
// database (tests/helpers/mail-test-harness.js). Providers are the offline
// fake; nothing leaves 127.0.0.1.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createMailWorker, HEARTBEAT_QUEUES } = require("../src/modules/mail/jobs/mail-worker");
const { loadMailConfig } = require("../src/modules/mail/mail.config");

const silent = () => {
  const lines = { info: [], warn: [], error: [] };
  return { lines, info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m), error: (m) => lines.error.push(m) };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const workerConfig = (extra = {}) => ({ worker: { concurrency: 4, leaseSeconds: 120, pollIntervalMs: 5, drainTimeoutMs: 2000, ...extra } });

function memoryJobs(initial) {
  const pending = [...initial];
  const calls = { complete: [], fail: [], defer: [], heartbeat: [] };
  return {
    calls,
    pending,
    recoverExpiredLeases: async () => [],
    claim: async ({ limit }) => pending.splice(0, limit),
    heartbeat: async (job) => { calls.heartbeat.push(job.id); return true; },
    complete: async (job) => { calls.complete.push(job.id); return true; },
    fail: async (job, input) => { calls.fail.push({ id: job.id, ...input }); return { updated: true, status: input.retryable ? "RETRY_SCHEDULED" : "FAILED" }; },
    defer: async (job) => { calls.defer.push(job.id); return { updated: true, status: "RETRY_SCHEDULED" }; },
  };
}

test("worker survives jobs.complete / jobs.fail throwing (logged with the job id, no unhandled rejection)", async () => {
  const jobs = memoryJobs([{ id: "j1", kind: "OK", queue: "EVENTS" }, { id: "j2", kind: "BAD", queue: "EVENTS" }, { id: "j3", kind: "OK", queue: "EVENTS" }]);
  let completes = 0;
  jobs.complete = async (job) => {
    completes += 1;
    if (job.id === "j1") throw Object.assign(new Error("connection reset"), { code: "P1001" });
    return true;
  };
  jobs.fail = async () => { throw Object.assign(new Error("db down"), { code: "P1001" }); };
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const logger = silent();
  try {
    const worker = createMailWorker({ jobs, handlers: { OK: async () => ({}), BAD: async () => { throw Object.assign(new Error("boom"), { code: "X" }); } }, config: workerConfig({ concurrency: 1 }), logger, queues: ["EVENTS"] });
    await worker.drain({ maxTicks: 5 });
    await sleep(10);
    assert.equal(unhandled.length, 0, "no unhandled rejection");
    assert.equal(completes, 2, "the worker kept claiming after the failure");
    assert.equal(worker.metrics.settleErrors, 2);
    assert.equal(worker.metrics.succeeded, 1);
    assert.ok(logger.lines.error.some((line) => line.includes("job j1") && line.includes("P1001")), "error log carries the job id");
    assert.ok(logger.lines.error.some((line) => line.includes("job j2")));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a lost lease is never counted as success; FAILED runs onFailed, DEAD_LETTER runs onDeadLetter", async () => {
  const jobs = memoryJobs([{ id: "lost", kind: "OK", queue: "OUTBOUND" }, { id: "perm", kind: "PERM", queue: "OUTBOUND" }, { id: "dead", kind: "DEAD", queue: "OUTBOUND" }]);
  jobs.complete = async () => false;
  jobs.fail = async (job, input) => ({ updated: true, status: job.id === "dead" ? "DEAD_LETTER" : input.retryable ? "RETRY_SCHEDULED" : "FAILED" });
  const terminal = [];
  const worker = createMailWorker({
    jobs,
    handlers: { OK: async () => ({}), PERM: async () => { throw Object.assign(new Error("x"), { code: "ATTACHMENT_NOT_CLEAN", retryable: false }); }, DEAD: async () => { throw Object.assign(new Error("y"), { code: "RESEND_HTTP_503" }); } },
    onFailed: { PERM: async (job, error) => terminal.push(["failed", job.id, error.code]) },
    onDeadLetter: { DEAD: async (job, error) => terminal.push(["dead", job.id, error.code]) },
    config: workerConfig(),
    logger: silent(),
    queues: ["OUTBOUND"],
  });
  await worker.drain({ maxTicks: 2 });
  assert.equal(worker.metrics.succeeded, 0, "complete() === false is not a success");
  assert.equal(worker.metrics.leasesLost, 1);
  assert.deepEqual(terminal.sort(), [["dead", "dead", "RESEND_HTTP_503"], ["failed", "perm", "ATTACHMENT_NOT_CLEAN"]]);
  // A fail() refused by the lease fence runs no cleanup.
  const fenced = memoryJobs([{ id: "f", kind: "PERM", queue: "OUTBOUND" }]);
  fenced.fail = async () => ({ updated: false, status: "FAILED" });
  let ran = false;
  const second = createMailWorker({ jobs: fenced, handlers: { PERM: async () => { throw Object.assign(new Error("x"), { retryable: false }); } }, onFailed: { PERM: async () => { ran = true; } }, config: workerConfig(), logger: silent(), queues: ["OUTBOUND"] });
  await second.drain({ maxTicks: 1 });
  assert.equal(ran, false);
  assert.equal(second.metrics.leasesLost, 1);
});

test("OUTBOUND and INBOUND leases are heartbeated; EVENTS are not; a lost lease is flagged", async () => {
  assert.ok(HEARTBEAT_QUEUES.has("OUTBOUND") && HEARTBEAT_QUEUES.has("INBOUND") && HEARTBEAT_QUEUES.has("MARKETING"));
  const jobs = memoryJobs([{ id: "o", kind: "SLOW", queue: "OUTBOUND" }, { id: "i", kind: "SLOW", queue: "INBOUND" }, { id: "e", kind: "SLOW", queue: "EVENTS" }]);
  jobs.heartbeat = async (job) => { jobs.calls.heartbeat.push(job.id); return job.id !== "o"; };
  const seen = {};
  const worker = createMailWorker({ jobs, handlers: { SLOW: async (job) => { await sleep(60); seen[job.id] = job.lease.lost; return {}; } }, config: workerConfig(), logger: silent(), queues: ["OUTBOUND", "INBOUND", "EVENTS"], heartbeatIntervalMs: 10 });
  await worker.drain({ maxTicks: 1 });
  assert.ok(jobs.calls.heartbeat.includes("o") && jobs.calls.heartbeat.includes("i"));
  assert.equal(jobs.calls.heartbeat.includes("e"), false);
  assert.deepEqual(seen, { o: true, i: false, e: false });
});

test("stop() stops claiming and drains the running tick and in-flight jobs; a timeout reports the jobs left to lease recovery", async () => {
  const jobs = memoryJobs([{ id: "a", kind: "SLOW", queue: "EVENTS" }]);
  let claims = 0;
  const claim = jobs.claim;
  jobs.claim = async (input) => { claims += 1; await sleep(20); return claim(input); };
  const worker = createMailWorker({ jobs, handlers: { SLOW: async () => { await sleep(80); return {}; } }, config: workerConfig({ pollIntervalMs: 1 }), logger: silent(), queues: ["EVENTS"] });
  worker.start();
  await sleep(10); // first tick is inside claim()
  const result = await worker.stop();
  assert.equal(result.drained, true, JSON.stringify(result));
  assert.deepEqual(jobs.calls.complete, ["a"], "the job claimed by the running tick completed before stop() returned");
  const after = claims;
  jobs.pending.push({ id: "b", kind: "SLOW", queue: "EVENTS" });
  await sleep(30);
  assert.equal(claims, after, "nothing is claimed after stop()");

  const slow = memoryJobs([{ id: "long", kind: "SLOW", queue: "EVENTS" }]);
  const logger = silent();
  const second = createMailWorker({ jobs: slow, handlers: { SLOW: async () => { await sleep(300); return {}; } }, config: workerConfig({ pollIntervalMs: 1 }), logger, queues: ["EVENTS"] });
  second.start();
  await sleep(20);
  const timedOut = await second.stop({ timeoutMs: 50 });
  assert.equal(timedOut.drained, false);
  assert.deepEqual(timedOut.inFlightJobIds, ["long"]);
  assert.ok(logger.lines.warn.some((line) => line.includes("long") && line.includes("lease recovery")));
  await sleep(300);
});

test("liveness: each completed tick is recorded and periodically logged", async () => {
  const jobs = memoryJobs([]);
  const logger = silent();
  const worker = createMailWorker({ jobs, handlers: {}, config: workerConfig({ pollIntervalMs: 1 }), logger, queues: ["EVENTS"], livenessLogIntervalMs: 1 });
  worker.start();
  await sleep(30);
  await worker.stop();
  assert.ok(worker.metrics.lastTickCompletedAt, "last tick timestamp exported");
  assert.ok(logger.lines.info.some((line) => line.startsWith("[MailWorker] alive")));
});

test("config: the lease is clamped to the provider timeout plus margin; drain timeout is configurable", () => {
  const config = loadMailConfig({ MAIL_WORKER_LEASE_SECONDS: "15", RESEND_TIMEOUT_MS: "60000", MAIL_WORKER_DRAIN_TIMEOUT_MS: "45000" });
  assert.equal(config.worker.leaseSeconds, 90);
  assert.equal(config.worker.leaseClampedFrom, 15);
  assert.equal(config.worker.drainTimeoutMs, 45000);
  const defaults = loadMailConfig({});
  assert.equal(defaults.worker.leaseSeconds, 120);
  assert.equal(defaults.worker.leaseClampedFrom, null);
  assert.equal(defaults.worker.drainTimeoutMs, 30000);
});

test("entrypoint: an unhandled rejection is logged and triggers a graceful shutdown (exit 1)", async () => {
  const { installShutdown } = require("../src/mail-worker");
  const handlers = {};
  let stopped = 0;
  let exitCode = null;
  let disconnected = false;
  const worker = { stop: async () => { stopped += 1; return { stopped: true, drained: true, inFlight: 0 }; }, metrics: {} };
  installShutdown({ worker, config: { worker: { drainTimeoutMs: 1000 } }, disconnect: async () => { disconnected = true; }, exit: (code) => { exitCode = code; }, on: (event, handler) => { handlers[event] = handler; } });
  assert.ok(handlers.unhandledRejection && handlers.uncaughtException && handlers.SIGTERM);
  handlers.unhandledRejection(new Error("lost"));
  handlers.SIGTERM();
  await sleep(10);
  assert.equal(stopped, 1, "one graceful stop");
  assert.equal(disconnected, true);
  assert.equal(exitCode, 1);
});

// ---------------------------------------------------------------------------

test("worker / outbound reliability on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const { openDatabase, seed, createHarness } = require("./helpers/mail-test-harness");
  const { createMailApplication } = require("../src/modules/mail/application");
  const { MailProviderError } = require("../src/modules/mail/adapters/mail-provider.contract");
  const { writeJobPayload } = require("../src/modules/mail/jobs/mail-job.repository");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client, { env: { MAIL_MAX_ATTACHMENTS: "2" } });
  const seeded = await seed(client, { clock: harness.clock });
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const mail = harness.mail;
  const worker = mail.createWorker({ queues: ["OUTBOUND"] });
  t.after(async () => db.close());

  const mailbox = await client.mailMailbox.create({ data: { organizationId: cf.organization.id, type: "PERSONAL", purpose: "GENERAL", name: "dave", ownerAdminUserId: ids.dave } });
  const address = await client.mailAddress.create({ data: { organizationId: cf.organization.id, domainId: cf.domain.id, mailboxId: mailbox.id, localPart: "dave", address: "dave@cosmicforge.example", kind: "PRIMARY", status: "ACTIVE" } });
  await client.mailMembership.create({ data: { mailboxId: mailbox.id, adminUserId: ids.dave, role: "OWNER", canSend: true } });
  const dave = await client.adminUser.findUnique({ where: { id: ids.dave }, select: { id: true, email: true, name: true, tier: true, status: true, department: true, isTeamLead: true } });
  const compose = mail.services.compose;
  const send = async (input, context = {}) => {
    const draft = await compose.createDraft(dave, mailbox.id, { subject: "Reliability", text: "hello", senderAddressId: address.id, ...input });
    return compose.sendDraft(dave, draft.id, { revision: draft.revision }, context);
  };
  const sentTo = (addr) => harness.adapter.state.sent.filter((entry) => [...entry.to, ...entry.cc, ...entry.bcc].some((party) => party.address === addr));
  const jobOf = (id) => client.mailOutboxJob.findUnique({ where: { id } });
  const messageOf = (id) => client.mailMessage.findUnique({ where: { id }, include: { recipients: true } });
  const hour = 3600 * 1000;

  await t.test("MAIL_SENDING_ENABLED=false holds queued mail without consuming attempts; it sends once re-enabled", async () => {
    const sent = await send({ to: ["hold@partner.example"] });
    // Backend-managed core queues: with sending off the worker does not serve
    // OUTBOUND (paused with its reason), so the job is untouched.
    const paused = harness.build({ MAIL_SENDING_ENABLED: "false" }).createWorker({ queues: ["OUTBOUND"], heartbeat: false });
    for (let index = 0; index < 8; index += 1) {
      await paused.drain({ maxTicks: 1 });
      harness.advance(301 * 1000);
    }
    assert.deepEqual(paused.metrics.pausedQueues, [{ queue: "OUTBOUND", reason: "SENDING_DISABLED" }]);
    const job = await jobOf(sent.jobId);
    assert.ok(["PENDING", "RETRY_SCHEDULED"].includes(job.status), "held, never failed or dead-lettered");
    assert.equal(job.attemptCount, 0, "no attempt consumed");
    const message = await messageOf(sent.messageId);
    assert.equal(message.status, "QUEUED");
    assert.equal(message.recipients[0].status, "PENDING", "recipients are never failed by the pause");
    assert.equal(sentTo("hold@partner.example").length, 0);
    await worker.drain();
    assert.equal((await jobOf(sent.jobId)).status, "SUCCEEDED");
    assert.equal(sentTo("hold@partner.example").length, 1);
  });

  await t.test("non-retryable FAILED outbound job: recipients/message settled, sender told, audits carry job + request ids", async () => {
    const draft = await compose.createDraft(dave, mailbox.id, { to: ["clean@partner.example"], subject: "Attachment", text: "x", senderAddressId: address.id });
    await compose.addAttachment(dave, draft.id, { buffer: Buffer.from("numbers"), originalname: "n.txt", mimetype: "text/plain" }, { requestId: "req-attach-1" });
    const uploadAudit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_ATTACHMENT_UPLOADED", requestId: "req-attach-1" } });
    assert.ok(uploadAudit, "upload audit carries the request context");
    const current = await compose.getDraft(dave, draft.id);
    const sent = await compose.sendDraft(dave, draft.id, { revision: current.revision }, { requestId: "req-send-1" });
    const queued = await jobOf(sent.jobId);
    assert.equal(queued.payload.correlationId, "req-send-1", "request id stored on the job");
    // A rescan made the attachment non-clean after queuing.
    await client.mailAttachment.updateMany({ where: { messageId: sent.messageId }, data: { scanStatus: "INFECTED", quarantined: true } });
    await worker.drain({ maxTicks: 1 });
    const job = await jobOf(sent.jobId);
    assert.equal(job.status, "FAILED");
    assert.equal(job.lastErrorCode, "ATTACHMENT_NOT_CLEAN");
    const message = await messageOf(sent.messageId);
    assert.equal(message.status, "FAILED", "no longer QUEUED forever");
    assert.equal(message.recipients[0].status, "FAILED");
    assert.equal(await client.notification.count({ where: { adminUserId: ids.dave, title: "Email could not be sent" } }), 1);
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_SEND_FAILED", targetId: sent.messageId } });
    assert.equal(audit.metadata.jobId, sent.jobId);
    assert.equal(audit.metadata.reason, "ATTACHMENT_NOT_CLEAN");
    assert.equal(audit.metadata.jobStatus, "FAILED");
    assert.equal(audit.requestId, "req-send-1");
  });

  await t.test("non-retryable failure after an ambiguous attempt becomes OUTCOME_UNKNOWN, never FAILED", async () => {
    const draft = await compose.createDraft(dave, mailbox.id, { to: ["maybe@partner.example"], subject: "Maybe", text: "x", senderAddressId: address.id });
    await compose.addAttachment(dave, draft.id, { buffer: Buffer.from("maybe"), originalname: "m.txt", mimetype: "text/plain" });
    const current = await compose.getDraft(dave, draft.id);
    const sent = await compose.sendDraft(dave, draft.id, { revision: current.revision });
    harness.adapter.failNext("sendMessage", "AMBIGUOUS", "PROVIDER_TIMEOUT", { acceptBeforeFailing: true });
    await worker.drain({ maxTicks: 1 });
    assert.equal((await jobOf(sent.jobId)).status, "RECONCILING");
    await client.mailAttachment.updateMany({ where: { messageId: sent.messageId }, data: { scanStatus: "INFECTED", quarantined: true } });
    harness.advance(hour);
    await worker.drain({ maxTicks: 1 });
    assert.equal((await jobOf(sent.jobId)).status, "FAILED");
    const message = await messageOf(sent.messageId);
    assert.equal(message.recipients[0].status, "OUTCOME_UNKNOWN");
    assert.equal(message.status, "OUTCOME_UNKNOWN");
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_SEND_OUTCOME_UNKNOWN", targetId: sent.messageId } });
    assert.equal(audit.metadata.jobId, sent.jobId);
  });

  await t.test("post-accept DB failure: the retry reuses the idempotency key, the provider replays the id, no duplicate", async () => {
    const sent = await send({ to: ["postaccept@partner.example"] });
    let armed = false;
    const flaky = new Proxy(client, {
      get(target, property) {
        if (property === "$transaction") {
          return async (...args) => {
            if (armed) {
              armed = false;
              throw Object.assign(new Error("server closed the connection unexpectedly"), { code: "P1017" });
            }
            return target.$transaction(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const adapter = { ...harness.adapter, sendMessage: async (request) => { const result = await harness.adapter.sendMessage(request); armed = true; return result; } };
    const failing = createMailApplication({ client: flaky, env: harness.environment, config: loadMailConfig(harness.environment), adapter, marketingAdapter: harness.marketingAdapter, storageBackend: harness.backend, logger: { info() {}, warn() {}, error() {} }, clock: harness.clock });
    await failing.createWorker({ queues: ["OUTBOUND"] }).drain({ maxTicks: 1 });
    let job = await jobOf(sent.jobId);
    assert.equal(job.status, "RETRY_SCHEDULED", "acceptance not recorded: retried, not succeeded");
    assert.equal(job.payload.plan[0].inFlight, true, "the plan still shows the batch in flight");
    assert.equal(sentTo("postaccept@partner.example").length, 1, "provider accepted once");
    const firstId = harness.adapter.state.byIdempotency.get(`${job.idempotencyKey}:b0`);
    assert.equal((await messageOf(sent.messageId)).recipients[0].status, "PENDING");
    harness.advance(hour);
    await worker.drain();
    job = await jobOf(sent.jobId);
    assert.equal(job.status, "SUCCEEDED");
    assert.equal(sentTo("postaccept@partner.example").length, 1, "no duplicate send");
    const message = await messageOf(sent.messageId);
    assert.equal(message.recipients[0].status, "PROVIDER_ACCEPTED");
    assert.equal(message.recipients[0].providerMessageId, firstId, "same provider id as the first acceptance");
    assert.equal(job.payload.plan[0].ambiguous, true, "the replay was treated as possibly-accepted");
    assert.equal(await client.mailAuditEvent.count({ where: { action: "MAIL_PROVIDER_ACCEPTED", targetId: sent.messageId } }), 1);
  });

  await t.test("two runs of one OUTBOUND job after lease expiry: one provider email, the stale run is fenced", async () => {
    const sent = await send({ to: ["race@partner.example"] });
    const outbound = mail.processors.outbound;
    const [jobA] = (await mail.jobs.claim({ queues: ["OUTBOUND"], leaseOwner: "worker-a", leaseSeconds: 60 })).filter((job) => job.id === sent.jobId);
    assert.ok(jobA);
    const original = harness.adapter.sendMessage;
    let reached;
    const atProvider = new Promise((resolve) => { reached = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let gated = false;
    harness.adapter.sendMessage = async (request) => {
      if (!gated) {
        gated = true;
        reached();
        await gate;
      }
      return original(request);
    };
    try {
      const runA = outbound.process(jobA).then(() => null, (error) => error);
      await atProvider; // run A is inside its provider call
      harness.advance(61 * 1000);
      const recovered = await mail.jobs.recoverExpiredLeases();
      assert.ok(recovered.some((entry) => entry.job.id === sent.jobId && entry.status === "RECONCILING"));
      const [jobB] = (await mail.jobs.claim({ queues: ["OUTBOUND"], leaseOwner: "worker-b", leaseSeconds: 60 })).filter((job) => job.id === sent.jobId);
      assert.ok(jobB, "the newer lease");
      const resultB = await outbound.process(jobB);
      assert.equal(await mail.jobs.complete(jobB, { providerRequestId: resultB.providerMessageId }), true);
      release();
      const errorA = await runA;
      assert.equal(errorA?.code, "MAIL_JOB_LEASE_LOST", "the stale run's acceptance write is fenced");
      assert.equal(await mail.jobs.complete(jobA), false, "the stale run cannot complete");
      assert.equal(sentTo("race@partner.example").length, 1, "exactly one provider email");
      const job = await jobOf(sent.jobId);
      assert.equal(job.status, "SUCCEEDED");
      assert.equal(job.payload.plan[0].providerMessageId, resultB.providerMessageId);
      // A stale run can never overwrite the plan either.
      await assert.rejects(() => writeJobPayload(client, jobA, { plan: [] }), (error) => error.code === "MAIL_JOB_LEASE_LOST");
      assert.equal((await jobOf(sent.jobId)).payload.plan.length, 1);
      assert.equal(await client.mailAuditEvent.count({ where: { action: "MAIL_PROVIDER_ACCEPTED", targetId: sent.messageId } }), 1);
    } finally {
      harness.adapter.sendMessage = original;
    }
  });

  await t.test("a stop raised during a multi-batch send defers the remaining batches; accepted ones stay accepted", async () => {
    const sent = await send({ bcc: ["batch-0@partner.example", "batch-1@partner.example"] });
    let stopNow = false;
    mail.runtime.use(async () => (stopNow ? "MAIL_EMERGENCY_STOP" : null));
    const original = harness.adapter.sendMessage;
    harness.adapter.sendMessage = async (request) => {
      const result = await original(request);
      stopNow = true;
      return result;
    };
    try {
      await worker.drain({ maxTicks: 1 });
    } finally {
      harness.adapter.sendMessage = original;
    }
    let job = await jobOf(sent.jobId);
    assert.equal(job.status, "RETRY_SCHEDULED");
    assert.equal(job.lastErrorCode, "MAIL_EMERGENCY_STOP");
    assert.equal(job.attemptCount, 0);
    assert.equal(sentTo("batch-0@partner.example").length + sentTo("batch-1@partner.example").length, 1, "only the first batch was sent");
    let message = await messageOf(sent.messageId);
    assert.deepEqual(message.recipients.map((recipient) => recipient.status).sort(), ["PENDING", "PROVIDER_ACCEPTED"]);
    stopNow = false;
    harness.advance(301 * 1000);
    await worker.drain();
    job = await jobOf(sent.jobId);
    assert.equal(job.status, "SUCCEEDED");
    message = await messageOf(sent.messageId);
    assert.deepEqual(message.recipients.map((recipient) => recipient.status), ["PROVIDER_ACCEPTED", "PROVIDER_ACCEPTED"]);
    assert.equal(sentTo("batch-0@partner.example").length + sentTo("batch-1@partner.example").length, 2);
  });

  await t.test("compose: a send transaction that fails leaves no orphaned body object", async () => {
    await client.mailMailbox.update({ where: { id: mailbox.id }, data: { dailySendQuota: 0 } });
    try {
      const before = harness.backend.objects.size;
      await assert.rejects(() => send({ to: ["quota@partner.example"] }), (error) => error.code === "MAIL_QUOTA_EXCEEDED");
      assert.equal(harness.backend.objects.size, before, "the body written before the transaction was removed");
    } finally {
      await client.mailMailbox.update({ where: { id: mailbox.id }, data: { dailySendQuota: 500 } });
    }
  });

  await t.test("compose: attachment uploads respect the limit under concurrency and clean up on failure", async () => {
    const draft = await compose.createDraft(dave, mailbox.id, { to: ["files@partner.example"], subject: "Files", text: "x", senderAddressId: address.id });
    const before = harness.backend.objects.size;
    const uploads = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => compose.addAttachment(dave, draft.id, { buffer: Buffer.from(`file ${index} ${crypto.randomUUID()}`), originalname: `f${index}.txt`, mimetype: "text/plain" })));
    assert.equal(uploads.filter((entry) => entry.status === "fulfilled").length, 2, "MAIL_MAX_ATTACHMENTS=2 holds under concurrency");
    assert.ok(uploads.filter((entry) => entry.status === "rejected").every((entry) => entry.reason?.errors?.[0]?.reason === "TOO_MANY_ATTACHMENTS" || entry.reason?.code === "MAIL_VALIDATION_FAILED"));
    assert.equal(await client.mailAttachment.count({ where: { draftId: draft.id } }), 2);
    assert.equal(harness.backend.objects.size, before + 2, "refused uploads left no objects");
    // A draft claimed by a send refuses new files; the stored object is removed.
    const other = await compose.createDraft(dave, mailbox.id, { to: ["files@partner.example"], subject: "Sending", text: "x", senderAddressId: address.id });
    await client.mailDraft.update({ where: { id: other.id }, data: { status: "SENDING" } });
    const size = harness.backend.objects.size;
    await assert.rejects(() => compose.addAttachment(dave, other.id, { buffer: Buffer.from("late"), originalname: "late.txt", mimetype: "text/plain" }), (error) => error.code === "MAIL_DRAFT_REVISION_CONFLICT");
    assert.equal(harness.backend.objects.size, size);
  });

  await t.test("compose: draft recipient lists are capped at the send limit", async () => {
    const many = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix}${index}@partner.example`);
    await assert.rejects(() => compose.createDraft(dave, mailbox.id, { to: many(51, "to"), senderAddressId: address.id }), (error) => error.code === "MAIL_VALIDATION_FAILED" && error.errors?.[0]?.reason === "TOO_MANY_RECIPIENTS");
    const draft = await compose.createDraft(dave, mailbox.id, { to: many(30, "to"), senderAddressId: address.id });
    await assert.rejects(() => compose.updateDraft(dave, draft.id, { revision: draft.revision, bcc: many(30, "bcc") }), (error) => error.errors?.[0]?.reason === "TOO_MANY_RECIPIENTS");
    const ok = await compose.updateDraft(dave, draft.id, { revision: draft.revision, bcc: many(20, "bcc") });
    assert.equal(ok.bcc.length, 20);
  });
});
