"use strict";

// Durable Mail job queue (mail_outbox_jobs) with lease-based claiming.
// - enqueue is idempotent by idempotencyKey
// - claim uses FOR UPDATE SKIP LOCKED so several worker processes never take
//   the same job
// - expired leases are recovered (crash recovery) and retried with backoff
// - exhausted jobs move to DEAD_LETTER for manual review
// - every claim gets its own lease token (worker id + random suffix in
//   lease_owner), so a stale run of an earlier lease can never complete,
//   fail, defer or extend a newer lease of the same job - even in the same
//   worker process

const crypto = require("crypto");
const { Prisma } = require("../../../generated/admin-client");

function backoffSeconds(attempt, { base = 15, cap = 3600, random = Math.random } = {}) {
  const exponential = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

function createMailJobRepository({ client, clock = () => new Date(), random = Math.random }) {
  async function enqueue(tx, { queue, kind, idempotencyKey, messageId = null, webhookEventId = null, payload = null, maxAttempts = 6, nextAttemptAt = null }) {
    const db = tx || client;
    const existing = await db.mailOutboxJob.findUnique({ where: { idempotencyKey } });
    if (existing) return { job: existing, created: false };
    const job = await db.mailOutboxJob.create({
      data: { queue, kind, idempotencyKey, messageId, webhookEventId, payload, maxAttempts, nextAttemptAt: nextAttemptAt || clock() },
    });
    return { job, created: true };
  }

  async function claim({ queues, leaseOwner, leaseSeconds = 120, limit = 1 }) {
    const now = clock();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    const take = Math.min(Math.max(Number(limit) || 1, 1), 50);
    const rows = await client.$queryRaw(Prisma.sql`
      UPDATE "mail_outbox_jobs" AS job
      SET "status" = 'LEASED', "lease_owner" = ${String(leaseOwner).slice(0, 100)}::text || ':' || substr(md5(random()::text || job."id"::text), 1, 16), "lease_expires_at" = ${leaseExpiresAt},
          "attempt_count" = job."attempt_count" + 1, "updated_at" = ${now}
      WHERE job."id" IN (
        SELECT candidate."id" FROM "mail_outbox_jobs" candidate
        WHERE candidate."status" IN ('PENDING', 'RETRY_SCHEDULED', 'RECONCILING')
          AND candidate."queue"::text IN (${Prisma.join(queues)})
          AND candidate."next_attempt_at" <= ${now}
        ORDER BY candidate."next_attempt_at" ASC, candidate."created_at" ASC
        LIMIT ${take}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING job."id"
    `);
    if (!rows.length) return [];
    return client.mailOutboxJob.findMany({ where: { id: { in: rows.map((row) => row.id) } } });
  }

  // Extends a lease this run still holds (long MARKETING jobs). Returns
  // false when the lease was lost (expired and recovered / reclaimed).
  async function heartbeat(job, { leaseSeconds = 120 } = {}) {
    const result = await client.mailOutboxJob.updateMany({
      where: { id: job.id, leaseOwner: job.leaseOwner, status: "LEASED" },
      data: { leaseExpiresAt: new Date(clock().getTime() + Math.min(Math.max(Number(leaseSeconds) || 120, 15), 3600) * 1000) },
    });
    return result.count === 1;
  }

  // The provider event behind a job is marked once its job settles, so the
  // webhook backlog, processing lag and webhook retention reflect reality.
  async function settleWebhookEvent(job, status, code = null) {
    if (!job.webhookEventId) return;
    await client.mailWebhookEvent.updateMany({
      where: { id: job.webhookEventId, status: "RECEIVED" },
      data: { status, processedAt: clock(), ...(code ? { lastError: String(code).slice(0, 500) } : {}) },
    });
  }

  async function complete(job, { providerRequestId = null } = {}) {
    const result = await client.mailOutboxJob.updateMany({
      where: { id: job.id, leaseOwner: job.leaseOwner, status: "LEASED" },
      data: { status: "SUCCEEDED", completedAt: clock(), leaseOwner: null, leaseExpiresAt: null, providerRequestId, lastErrorCode: null, lastErrorMessage: null },
    });
    if (result.count === 1) await settleWebhookEvent(job, "PROCESSED");
    return result.count === 1;
  }

  async function fail(job, { code, message, retryable, reconcile = false, retryAfterSeconds = null }) {
    const exhausted = job.attemptCount >= job.maxAttempts;
    const status = !retryable ? "FAILED" : exhausted ? "DEAD_LETTER" : reconcile ? "RECONCILING" : "RETRY_SCHEDULED";
    const delay = retryAfterSeconds != null ? Math.min(Math.max(retryAfterSeconds, 1), 3600) : backoffSeconds(job.attemptCount, { random });
    const result = await client.mailOutboxJob.updateMany({
      where: { id: job.id, leaseOwner: job.leaseOwner, status: "LEASED" },
      data: {
        status,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: String(code || "UNKNOWN").slice(0, 64),
        lastErrorMessage: String(message || "").slice(0, 500),
        nextAttemptAt: new Date(clock().getTime() + delay * 1000),
        completedAt: status === "FAILED" || status === "DEAD_LETTER" ? clock() : null,
      },
    });
    if (result.count === 1 && (status === "FAILED" || status === "DEAD_LETTER")) await settleWebhookEvent(job, "FAILED", code || "UNKNOWN");
    return { updated: result.count === 1, status };
  }

  // Re-schedule a claimed job without consuming an attempt (operational pause,
  // disabled flag, multi-step progress). Never marks success or failure.
  async function defer(job, { seconds = 60, code = "DEFERRED", message = "" } = {}) {
    const delay = Math.min(Math.max(Number(seconds) || 1, 1), 86400);
    const result = await client.mailOutboxJob.updateMany({
      where: { id: job.id, leaseOwner: job.leaseOwner, status: "LEASED" },
      data: {
        status: "RETRY_SCHEDULED",
        leaseOwner: null,
        leaseExpiresAt: null,
        attemptCount: Math.max(0, job.attemptCount - 1),
        lastErrorCode: String(code).slice(0, 64),
        lastErrorMessage: String(message || "").slice(0, 500),
        nextAttemptAt: new Date(clock().getTime() + delay * 1000),
      },
    });
    return { updated: result.count === 1, status: "RETRY_SCHEDULED" };
  }

  // Pull a pending job forward (e.g. cancellation should act promptly).
  async function expedite(idempotencyKey) {
    const result = await client.mailOutboxJob.updateMany({
      where: { idempotencyKey, status: { in: ["PENDING", "RETRY_SCHEDULED", "RECONCILING"] } },
      data: { nextAttemptAt: clock() },
    });
    return result.count;
  }

  async function cancelPending(idempotencyKey, reason = "CANCELLED") {
    const result = await client.mailOutboxJob.updateMany({
      where: { idempotencyKey, status: { in: ["PENDING", "RETRY_SCHEDULED", "RECONCILING"] } },
      data: { status: "CANCELLED", completedAt: clock(), lastErrorCode: String(reason).slice(0, 64) },
    });
    return result.count;
  }

  // Crash recovery: jobs whose worker died mid-lease become eligible again.
  async function recoverExpiredLeases() {
    const now = clock();
    const expired = await client.mailOutboxJob.findMany({ where: { status: "LEASED", leaseExpiresAt: { lt: now } }, take: 200 });
    const recovered = [];
    for (const job of expired) {
      const exhausted = job.attemptCount >= job.maxAttempts;
      // Outbound sends interrupted mid-flight are reconciled (provider-side
      // idempotency key makes the retry safe), never blindly resent with a new key.
      const status = exhausted ? "DEAD_LETTER" : job.queue === "OUTBOUND" ? "RECONCILING" : "RETRY_SCHEDULED";
      const result = await client.mailOutboxJob.updateMany({
        where: { id: job.id, status: "LEASED", leaseOwner: job.leaseOwner, leaseExpiresAt: { lt: now } },
        data: { status, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now, lastErrorCode: "LEASE_EXPIRED", completedAt: exhausted ? now : null },
      });
      if (result.count === 1 && exhausted) await settleWebhookEvent(job, "FAILED", "LEASE_EXPIRED");
      if (result.count === 1) recovered.push({ job: { ...job, status }, status });
    }
    return recovered;
  }

  // Operator recovery of a dead-lettered (or permanently failed) job: it goes
  // back to PENDING with a fresh attempt budget, and its provider webhook event
  // is reopened so lag/backlog reflect it again. Callers decide which kinds may
  // be replayed (never outbound sends: their outcome may be unknown).
  async function requeue(jobId) {
    const now = clock();
    const job = await client.mailOutboxJob.findUnique({ where: { id: jobId } });
    if (!job) return null;
    const result = await client.mailOutboxJob.updateMany({
      where: { id: jobId, status: { in: ["DEAD_LETTER", "FAILED"] } },
      data: { status: "PENDING", attemptCount: 0, nextAttemptAt: now, completedAt: null, leaseOwner: null, leaseExpiresAt: null, lastErrorCode: "REQUEUED", lastErrorMessage: `requeued after ${job.status}` },
    });
    if (result.count !== 1) return { job, requeued: false };
    if (job.webhookEventId) await client.mailWebhookEvent.updateMany({ where: { id: job.webhookEventId, status: "FAILED" }, data: { status: "RECEIVED", processedAt: null } });
    return { job: { ...job, status: "PENDING" }, requeued: true };
  }

  async function stats() {
    const rows = await client.mailOutboxJob.groupBy({ by: ["queue", "status"], _count: { _all: true } });
    return rows.map((row) => ({ queue: row.queue, status: row.status, count: row._count._all }));
  }

  return { enqueue, claim, heartbeat, complete, fail, defer, expedite, cancelPending, recoverExpiredLeases, requeue, stats };
}

function leaseOwnerId(prefix = "mail-worker") {
  return `${prefix}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;
}

module.exports = { createMailJobRepository, backoffSeconds, leaseOwnerId };
