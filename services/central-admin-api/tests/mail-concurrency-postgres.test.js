"use strict";

// Concurrency and small-scale load checks on real PostgreSQL (spec 20, 22.1).
// These are not staging-sized load tests; they prove the invariants that load
// would stress: no job is claimed twice by competing workers, duplicate
// inbound deliveries create one message, the shared rate limit never admits
// more than its budget across "replicas", concurrent inbox reads stay
// consistent, and the quarantine unknown-recipient policy holds the job.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller } = require("./helpers/mail-test-harness");
const { createSharedRateLimiter } = require("../src/modules/mail/ops/shared-rate-limit");
const { closeServer } = require("./helpers/server-close");

test("CosmicForge Mail concurrency on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client, { env: { MAIL_UNKNOWN_RECIPIENT_POLICY: "quarantine" } });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const mail = harness.mail;
  const { server, base } = await listen(harness.mountApp(mail));
  const call = caller(base, ids);
  t.after(async () => {
    await closeServer(server);
    await db.close();
  });

  const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids.dave, address: { domainId: cf.domain.id, localPart: "dave" } });
  assert.equal(box.status, 201, box.text);
  const mailboxId = box.body.data.id;

  const inbound = (id, to = "dave@cosmicforge.example", subject = "Load") => {
    harness.adapter.addInbound(id, { from: { address: "partner@partner.example", name: null }, to: [{ address: to, name: null }], cc: [], envelopeRecipients: [], subject, html: null, text: "load test", rfcMessageId: `<${id}@partner.example>`, inReplyTo: null, references: [], receivedAt: harness.clock() });
    return { id: crypto.randomUUID(), payload: { providerEmailId: id, to: [to] }, webhookEventId: null };
  };

  await t.test("8 competing workers claim 200 jobs: every job exactly once", async () => {
    const total = 200;
    for (let i = 0; i < total; i += 1) await mail.jobs.enqueue(null, { queue: "EVENTS", kind: "LOAD_PROBE", idempotencyKey: `load:${i}` });
    const seen = new Map();
    const worker = async (name) => {
      for (;;) {
        const claimed = await mail.jobs.claim({ queues: ["EVENTS"], leaseOwner: name, limit: 7 });
        if (!claimed.length) return;
        for (const job of claimed) {
          if (job.kind !== "LOAD_PROBE") continue;
          seen.set(job.id, (seen.get(job.id) || 0) + 1);
          await mail.jobs.complete(job);
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, (_, i) => worker(`w${i}`)));
    assert.equal(seen.size, total, "every job was claimed");
    assert.ok([...seen.values()].every((count) => count === 1), "no job was claimed twice");
    const left = await client.mailOutboxJob.count({ where: { kind: "LOAD_PROBE", status: { not: "SUCCEEDED" } } });
    assert.equal(left, 0);
  });

  await t.test("the same inbound email processed 10 times concurrently creates one message", async () => {
    const job = inbound("dup_concurrent_1");
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => mail.processors.inbound.process({ ...job, id: crypto.randomUUID() })));
    const unexpected = results.filter((r) => r.status === "rejected" && !r.reason?.retryable);
    assert.equal(unexpected.length, 0, `non-retryable failures: ${unexpected.map((r) => r.reason?.message).join("; ")}`);
    const copies = await client.mailMessage.count({ where: { mailboxId, providerMessageId: "dup_concurrent_1" } });
    assert.equal(copies, 1, "exactly one stored copy");
  });

  await t.test("100 distinct inbound emails in parallel batches; inbox reads stay consistent under concurrent load", async () => {
    const jobs = Array.from({ length: 100 }, (_, i) => inbound(`bulk_${i}`, "dave@cosmicforge.example", `Bulk ${i}`));
    for (let i = 0; i < jobs.length; i += 20) await Promise.all(jobs.slice(i, i + 20).map((job) => mail.processors.inbound.process(job)));
    const stored = await client.mailMessage.count({ where: { mailboxId, providerMessageId: { startsWith: "bulk_" } } });
    assert.equal(stored, 100);
    const reads = await Promise.all(Array.from({ length: 25 }, () => call("dave", "GET", `/mailboxes/${mailboxId}/threads?folder=INBOX&limit=50`)));
    for (const read of reads) assert.equal(read.status, 200, read.text);
    const firstIds = JSON.stringify(reads[0].body.data.map((thread) => thread.id));
    assert.ok(reads.every((read) => JSON.stringify(read.body.data.map((thread) => thread.id)) === firstIds), "every concurrent read returns the same page");
    const other = await call("erin", "GET", `/mailboxes/${mailboxId}/threads?folder=INBOX`);
    assert.equal(other.status, 404, "privacy holds under load");
  });

  await t.test("shared rate limit: 4 replicas x 50 concurrent requests admit exactly the budget", async () => {
    const replicas = Array.from({ length: 4 }, () => createSharedRateLimiter({ client, features: mail.features }));
    const outcomes = await Promise.all(Array.from({ length: 200 }, (_, i) => replicas[i % 4].consume("load:shared", { max: 37, windowMs: 3600000 })));
    assert.ok(outcomes.every((o) => o.shared), "all requests used the shared counter");
    assert.equal(outcomes.filter((o) => o.allowed).length, 37);
  });

  await t.test("shared rate limit: database failure falls back to a bounded local window, or refuses when failClosed", async () => {
    const broken = { $queryRaw: async () => { throw Object.assign(new Error("down"), { code: "P1001" }); }, $executeRaw: async () => 0 };
    const limiter = createSharedRateLimiter({ client: broken, features: { isReady: async () => true } });
    const open = await Promise.all(Array.from({ length: 10 }, () => limiter.consume("load:fallback", { max: 3 })));
    assert.equal(open.filter((o) => o.allowed).length, 3, "fallback keeps the same limit");
    const closed = await limiter.consume("load:sensitive", { max: 3, failClosed: true });
    assert.equal(closed.allowed, false);
    assert.equal(closed.unavailable, true);
  });

  await t.test("quarantine policy: unknown local recipient ends the job non-retryable and stores nothing", async () => {
    const job = inbound("unknown_q_1", "nobody@cosmicforge.example");
    await assert.rejects(() => mail.processors.inbound.process(job), (error) => error.code === "INBOUND_UNKNOWN_RECIPIENT_QUARANTINED" && error.retryable === false);
    assert.equal(await client.mailMessage.count({ where: { providerMessageId: "unknown_q_1" } }), 0);
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_INBOUND_UNKNOWN_RECIPIENT_QUARANTINED" } });
    assert.ok(audit, "quarantine is audited");
  });
});
