"use strict";

// Backend-managed inbound Mail on real PostgreSQL (incident repair):
//   email.received webhook -> durable event + job -> a RUNNING worker (no
//   rollout rule, cohort or frontend action, rollout enforced as in
//   production) -> encrypted message stored in the owner's mailbox ->
//   authorized inbox / thread APIs return it; others cannot.
// Plus: idempotent enqueue, durable heartbeat, worker restart with expired
// lease recovery, transient provider failure, missed-webhook reconciliation
// without duplicates (and never for another product's mail), wrong-environment
// ownership, disabled backend configuration and the deploy self-test.
// Providers are the offline fakes; nothing leaves 127.0.0.1.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, postWebhook } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");
const { verifyWorker } = require("../src/modules/mail/ops/worker-verification");
const { listWorkerHeartbeats } = require("../src/modules/mail/jobs/worker-heartbeat");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

test("backend-managed inbound Mail end to end on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  // Production defaults that caused the incident: rollout enforced and no
  // rollout rules at all. Fast polling for the test.
  const harness = createHarness(client, { env: { MAIL_ROLLOUT_ENFORCED: "true", MAIL_RECONCILIATION_ENABLED: "true", MAIL_WORKER_POLL_INTERVAL_MS: "200", MAIL_WORKER_HEARTBEAT_SECONDS: "5" } });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const servers = [];
  const serve = async (application) => {
    const { server, base } = await listen(harness.mountApp(application));
    servers.push(server);
    return { call: caller(base, ids), base };
  };
  const { call, base } = await serve(harness.mail);
  let worker = null;
  t.after(async () => {
    if (worker) await worker.stop({ timeoutMs: 5000 }).catch(() => {});
    for (const server of servers) await closeServer(server);
    await db.close();
  });

  const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids.dave, address: { domainId: cf.domain.id, localPart: "dave" } });
  assert.equal(box.status, 201, box.text);
  const daveBox = box.body.data.id;
  const daveAddress = "dave@cosmicforge.example";
  const addInbound = (id, to, extra = {}) => harness.adapter.addInbound(id, { from: { address: "partner@gmail.example", name: "Partner" }, to: to.map((address) => ({ address, name: null })), cc: [], envelopeRecipients: [], subject: `Reply ${id}`, html: null, text: `hello ${id}`, rfcMessageId: `<${id}@gmail.example>`, inReplyTo: null, references: [], receivedAt: harness.clock(), ...extra });
  const received = (id, to = [daveAddress], options = {}) => postWebhook(base, harness.clock, "email.received", { email_id: id, to, from: "Partner <partner@gmail.example>", created_at: harness.clock().toISOString() }, options);
  const jobFor = (id) => client.mailOutboxJob.findFirst({ where: { kind: "PROCESS_INBOUND", payload: { path: ["providerEmailId"], equals: id } }, orderBy: { createdAt: "asc" } });
  const copies = (id) => client.mailMessage.count({ where: { providerMessageId: id, direction: "INBOUND" } });
  const startWorker = () => {
    worker = harness.mail.createWorker({ queues: ["OUTBOUND", "INBOUND", "EVENTS"] });
    worker.start();
    return worker;
  };

  await t.test("no rollout rule exists: production-like enforcement with zero ALLOW rules", async () => {
    assert.equal(harness.mail.config.rollout.enforced, true);
    assert.equal(await client.mailRolloutRule.count(), 0);
    const decisions = await harness.mail.services.rollout.workerQueueDecisions(["OUTBOUND", "INBOUND", "EVENTS", "MARKETING"]);
    assert.deepEqual(decisions.filter((entry) => entry.allowed).map((entry) => entry.queue), ["OUTBOUND", "INBOUND", "EVENTS"], "core queues need no ALLOW rule");
    assert.equal(decisions.find((entry) => entry.queue === "MARKETING").allowed, false, "optional marketing processing stays rollout-gated");
  });

  await t.test("email.received is accepted durably and enqueued once (idempotent per provider event)", async () => {
    addInbound("rcv_1", [daveAddress]);
    const first = await received("rcv_1", [daveAddress, "someone@other.example"], { id: "msg_rcv_1" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.duplicate, false);
    const again = await received("rcv_1", [daveAddress], { id: "msg_rcv_1" });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true, "a provider retry of the same event is not enqueued twice");
    assert.equal(await client.mailOutboxJob.count({ where: { kind: "PROCESS_INBOUND" } }), 1);
    const job = await jobFor("rcv_1");
    assert.equal(job.status, "PENDING");
    assert.deepEqual(job.payload.to, [daveAddress], "only our own recipients are stored for routing");
    const event = await client.mailWebhookEvent.findUnique({ where: { id: job.webhookEventId } });
    assert.equal(event.status, "RECEIVED");
    assert.equal(await copies("rcv_1"), 0, "acknowledging the webhook is not delivery");
  });

  await t.test("an active worker processes it into the owner's inbox; the authorized inbox API returns it", async () => {
    startWorker();
    await until("rcv_1 job SUCCEEDED", async () => (await jobFor("rcv_1"))?.status === "SUCCEEDED");
    const job = await jobFor("rcv_1");
    assert.equal((await client.mailWebhookEvent.findUnique({ where: { id: job.webhookEventId } })).status, "PROCESSED");
    const message = await client.mailMessage.findFirst({ where: { providerMessageId: "rcv_1", direction: "INBOUND" }, include: { thread: true } });
    assert.ok(message, "the inbound message exists in the database");
    assert.equal(message.mailboxId, daveBox);
    assert.equal(message.thread.folder, "INBOX");
    assert.notEqual(message.contentObjectKey, null, "the body is stored (encrypted) in private storage");

    const threads = await call("dave", "GET", `/mailboxes/${daveBox}/threads?view=inbox`);
    assert.equal(threads.status, 200, threads.text);
    const thread = threads.body.data.find((entry) => entry.id === message.threadId);
    assert.ok(thread, "the thread is listed in the owner's inbox");
    const messages = await call("dave", "GET", `/threads/${message.threadId}/messages`);
    assert.equal(messages.status, 200, messages.text);
    assert.ok(messages.body.data.some((entry) => entry.id === message.id), "the message is readable by the owner");
    const mine = await call("dave", "GET", "/me/mailboxes");
    assert.ok(JSON.stringify(mine.body).includes(daveBox), "the mailbox is listed for its owner");

    const foreign = await call("erin", "GET", `/mailboxes/${daveBox}/threads?view=inbox`);
    assert.ok([403, 404].includes(foreign.status), `another staff member cannot list the mailbox (${foreign.status})`);
    const foreignThread = await call("erin", "GET", `/threads/${message.threadId}/messages`);
    assert.ok([403, 404].includes(foreignThread.status), "nor read the thread");
  });

  await t.test("the worker records a durable heartbeat serving every core queue", async () => {
    const workers = await listWorkerHeartbeats(client, { clock: harness.clock, staleAfterSeconds: 180 });
    const running = workers.find((entry) => entry.state === "RUNNING");
    assert.ok(running, "a RUNNING heartbeat exists");
    assert.deepEqual([...running.activeQueues].sort(), ["EVENTS", "INBOUND", "OUTBOUND"]);
    assert.equal(running.database, (await client.$queryRawUnsafe("SELECT current_database() AS name"))[0].name);
    const status = await harness.mail.workerStatus();
    assert.equal(status.state, "RUNNING");
    assert.deepEqual(status.unservedCoreQueues, []);
    assert.ok((await client.mailOutboxJob.count({ where: { kind: "WORKER_HEARTBEAT", status: "SUCCEEDED" } })) >= 1, "the heartbeat row is durable and never claimable");
  });

  await t.test("deploy self-test: an isolated job is claimed and completed by the running worker", async () => {
    const start = Date.now();
    const realClock = () => new Date(harness.clock().getTime() + (Date.now() - start));
    const result = await verifyWorker({ client, config: harness.mail.config, jobs: harness.mail.jobs, waitSeconds: 30, clock: realClock, pollMs: 100 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.checks.selfTest, true);
    assert.equal(result.selfTest.status, "SUCCEEDED");
    assert.equal(await copies("rcv_1"), 1, "the self-test touched no mail");
  });

  await t.test("transient provider failure is retried with backoff, never lost", async () => {
    addInbound("rcv_transient", [daveAddress]);
    harness.adapter.failNext("fetchInboundMessage", "RETRYABLE", "PROVIDER_TIMEOUT");
    assert.equal((await received("rcv_transient")).status, 200);
    await until("rcv_transient RETRY_SCHEDULED", async () => (await jobFor("rcv_transient"))?.status === "RETRY_SCHEDULED");
    assert.equal(await copies("rcv_transient"), 0);
    harness.advance(3600 * 1000); // past the backoff; nothing is in flight
    await until("rcv_transient SUCCEEDED", async () => (await jobFor("rcv_transient"))?.status === "SUCCEEDED");
    assert.equal(await copies("rcv_transient"), 1);
  });

  await t.test("worker restart: a job leased by a crashed worker is recovered and delivered by the new worker", async () => {
    await worker.stop({ timeoutMs: 5000 });
    const stopped = (await listWorkerHeartbeats(client, { clock: harness.clock })).find((entry) => entry.instance.endsWith("events+inbound+outbound"));
    assert.equal(stopped.state, "STOPPED", "a clean stop is recorded");
    addInbound("rcv_crash", [daveAddress]);
    assert.equal((await received("rcv_crash")).status, 200);
    const job = await jobFor("rcv_crash");
    // The crashed worker had claimed it: LEASED with an expired lease.
    await client.mailOutboxJob.update({ where: { id: job.id }, data: { status: "LEASED", leaseOwner: "mail-worker:dead:00000000:lease", leaseExpiresAt: new Date(harness.clock().getTime() - 1000), attemptCount: 1 } });
    startWorker();
    await until("rcv_crash SUCCEEDED", async () => (await jobFor("rcv_crash"))?.status === "SUCCEEDED");
    assert.equal(await copies("rcv_crash"), 1);
    assert.ok(worker.metrics.recovered >= 1, "the expired lease was recovered");
  });

  await t.test("reconciliation recovers an omitted webhook exactly once; another product's mail is never touched", async () => {
    const old = new Date(harness.clock().getTime() - 30 * 60000);
    addInbound("rcv_missed", [daveAddress], { receivedAt: old });
    addInbound("rcv_foreign", ["someone@other-product.example"], { receivedAt: old });
    const run = await harness.mail.processors.inboundReconciler.process();
    assert.equal(run.recovered, 1, JSON.stringify(run));
    assert.ok(run.foreign >= 1, "the foreign email is counted, not processed");
    assert.equal(await client.mailOutboxJob.count({ where: { idempotencyKey: "inbound:reconcile:rcv_foreign" } }), 0);
    const reconcileJob = await client.mailOutboxJob.findUnique({ where: { idempotencyKey: "inbound:reconcile:rcv_missed" } });
    assert.deepEqual(reconcileJob.payload.to, [daveAddress]);
    await until("rcv_missed delivered", async () => (await copies("rcv_missed")) === 1);
    // Next run: already delivered, nothing new.
    const again = await harness.mail.processors.inboundReconciler.process();
    assert.equal(again.recovered, 0);
    // The webhook finally arrives late: processed as a duplicate, no second copy.
    assert.equal((await received("rcv_missed", [daveAddress], { id: "msg_rcv_missed_late" })).status, 200);
    await until("late webhook job settled", async () => (await client.mailOutboxJob.count({ where: { kind: "PROCESS_INBOUND", payload: { path: ["providerEmailId"], equals: "rcv_missed" }, status: "SUCCEEDED" } })) === 2);
    assert.equal(await copies("rcv_missed"), 1, "no duplicate mailbox message");
    assert.equal(await copies("rcv_foreign"), 0);
  });

  await t.test("wrong-environment ownership: a deployment that does not own inbound refuses and never processes it", async () => {
    const other = harness.build({ MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production" });
    const { base: otherBase } = await serve(other);
    addInbound("rcv_other_env", [daveAddress]);
    const refused = await postWebhook(otherBase, harness.clock, "email.received", { email_id: "rcv_other_env", to: [daveAddress], from: "partner@gmail.example" });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, "MAIL_INBOUND_NOT_ACTIVE_HERE");
    const decisions = await other.services.rollout.workerQueueDecisions(["INBOUND"]);
    assert.deepEqual(decisions, [{ queue: "INBOUND", allowed: false, reason: "INBOUND_NOT_OWNED_HERE" }]);
    assert.deepEqual(await other.processors.inboundReconciler.process(), { skipped: "INBOUND_NOT_ACTIVE_HERE" }, "only the inbound owner reconciles");
  });

  await t.test("disabled backend configuration pauses the queue without losing mail; explicit DENY is an emergency pause", async () => {
    const off = harness.build({ MAIL_RECEIVING_ENABLED: "false" });
    assert.deepEqual(await off.services.rollout.workerQueueDecisions(["INBOUND"]), [{ queue: "INBOUND", allowed: false, reason: "RECEIVING_DISABLED" }]);
    const deny = await client.mailRolloutRule.create({ data: { environment: harness.mail.config.deploymentEnvironment, capability: "WORKER_INBOUND", scopeType: "ENVIRONMENT", effect: "DENY", reason: "Emergency pause (test)", createdBy: ids.ops, createdAt: harness.clock() } });
    harness.mail.services.rollout.invalidate();
    harness.advance(6000);
    await until("INBOUND paused in the worker", async () => worker.metrics.pausedQueues.some((entry) => entry.queue === "INBOUND" && entry.reason === "EMERGENCY_DENY_RULE"));
    addInbound("rcv_paused", [daveAddress]);
    assert.equal((await received("rcv_paused")).status, 200, "the API keeps accepting durable work while paused");
    await sleep(1000);
    assert.equal((await jobFor("rcv_paused")).status, "PENDING", "paused, not dead-lettered");
    const readiness = await harness.mail.readiness();
    assert.ok(readiness.operational, "operational health is reported");
    await client.mailRolloutRule.update({ where: { id: deny.id }, data: { revokedAt: harness.clock(), revokedBy: ids.ops } });
    harness.mail.services.rollout.invalidate();
    harness.advance(6000);
    await until("rcv_paused delivered after the pause is lifted", async () => (await copies("rcv_paused")) === 1);
  });

  await t.test("core worker ALLOW rules are retired; DENY rules remain available", async () => {
    const stepUp = await call("ops", "POST", "/admin/rollout/rules", { capability: "WORKER_INBOUND", scopeType: "ENVIRONMENT", effect: "ALLOW", reason: "Legacy worker allow (test)" });
    assert.equal(stepUp.status, 400, stepUp.text);
    assert.match(stepUp.text, /CORE_WORKER_BACKEND_MANAGED/);
  });

  await t.test("ops alerts: a stopped worker raises MAIL_WORKER_NOT_RUNNING from the API-side evaluation", async () => {
    await worker.stop({ timeoutMs: 5000 });
    worker = null;
    harness.advance(10 * 60000); // past the stale threshold
    const result = await harness.mail.services.ops.processEvaluate();
    assert.ok(result.evaluated >= 1, JSON.stringify(result));
    const open = await client.mailOpsAlert.findMany({ where: { resolvedAt: null } });
    assert.ok(open.some((alert) => alert.code === "MAIL_WORKER_NOT_RUNNING" && alert.severity === "critical"), JSON.stringify(open.map((alert) => alert.code)));
    const readiness = await harness.mail.readiness();
    assert.equal(readiness.operational.state, "DEGRADED");
    assert.ok(readiness.operational.reasons.includes("WORKER_NOT_RUNNING"));
  });
});
