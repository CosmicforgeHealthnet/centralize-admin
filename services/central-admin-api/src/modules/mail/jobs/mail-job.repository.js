"use strict";

// Durable Mail job queue (mail_outbox_jobs) with lease-based claiming.
// - enqueue is idempotent by idempotencyKey
// - claim uses FOR UPDATE SKIP LOCKED so several worker processes never take
//   the same job
// - expired leases are recovered (crash recovery) and retried with backoff
// - exhausted jobs move to DEAD_LETTER for manual review

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
      SET "status" = 'LEASED', "lease_owner" = ${leaseOwner}, "lease_expires_at" = ${leaseExpiresAt},
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

  async function complete(job, { providerRequestId = null } = {}) {
    const result = await client.mailOutboxJob.updateMany({
      where: { id: job.id, leaseOwner: job.leaseOwner, status: "LEASED" },
      data: { status: "SUCCEEDED", completedAt: clock(), leaseOwner: null, leaseExpiresAt: null, providerRequestId, lastErrorCode: null, lastErrorMessage: null },
    });
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
    return { updated: result.count === 1, status };
  }

  // Crash recovery: jobs whose worker died mid-lease become eligible again.
  async function recoverExpiredLeases() {
    const now = clock();
    const expired = await client.mailOutboxJob.findMany({ where: { status: "LEASED", leaseExpiresAt: { lt: now } }, take: 200 });
    let recovered = 0;
    for (const job of expired) {
      const exhausted = job.attemptCount >= job.maxAttempts;
      // Outbound sends interrupted mid-flight are reconciled (provider-side
      // idempotency key makes the retry safe), never blindly resent with a new key.
      const status = exhausted ? "DEAD_LETTER" : job.queue === "OUTBOUND" ? "RECONCILING" : "RETRY_SCHEDULED";
      const result = await client.mailOutboxJob.updateMany({
        where: { id: job.id, status: "LEASED", leaseOwner: job.leaseOwner, leaseExpiresAt: { lt: now } },
        data: { status, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now, lastErrorCode: "LEASE_EXPIRED", completedAt: exhausted ? now : null },
      });
      recovered += result.count;
    }
    return recovered;
  }

  async function stats() {
    const rows = await client.mailOutboxJob.groupBy({ by: ["queue", "status"], _count: { _all: true } });
    return rows.map((row) => ({ queue: row.queue, status: row.status, count: row._count._all }));
  }

  return { enqueue, claim, complete, fail, recoverExpiredLeases, stats };
}

function leaseOwnerId(prefix = "mail-worker") {
  return `${prefix}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;
}

module.exports = { createMailJobRepository, backoffSeconds, leaseOwnerId };
