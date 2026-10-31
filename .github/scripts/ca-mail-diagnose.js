"use strict";

// READ-ONLY CosmicForge Mail processing diagnostic. Piped into the running
// app (or Mail worker) container by ca-mail-staging-ops.sh --mail-diagnose:
//   docker exec -i -w /app <container> node - < ca-mail-diagnose.js
// Uses the container's own Prisma client and DATABASE_URL, so it reports the
// database that container really serves. Works on every image since the
// Mail M1-M10 schema (no new code needed in the image).
//
// Never prints message content, subjects, bodies, secrets, URLs or external
// parties' addresses: only counts, ages, ids, codes, statuses, sender
// DOMAINS, and recipient addresses on our own allowlisted domains (needed to
// verify mailbox routing). Never writes anything.
//
// Output: one line `CA_MAIL_DIAG <json>`.

const { prisma } = require("./src/shared/config/database");

const MODE = process.env.CA_DIAG_MODE || "full"; // full | identity
const now = Date.now();
const ageMinutes = (date) => (date ? Math.round((now - new Date(date).getTime()) / 60000) : null);
const iso = (date) => (date ? new Date(date).toISOString() : null);
const domainOf = (value) => {
  const match = /@([A-Za-z0-9.-]+)>?\s*$/.exec(String(value || ""));
  return match ? match[1].toLowerCase() : null;
};
const ownedDomains = new Set(String(process.env.MAIL_DOMAIN_ALLOWLIST || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean));
const ownAddress = (value) => {
  const address = String(value || "").trim().toLowerCase();
  return ownedDomains.has(address.split("@")[1]) ? address : null;
};

async function safe(label, fn) {
  try {
    return await fn();
  } catch (error) {
    return { error: String(error?.code || error?.name || "error"), label };
  }
}

async function addressResolution(address) {
  const row = await prisma.mailAddress.findUnique({ where: { address }, include: { mailbox: { select: { id: true, type: true, purpose: true, status: true, ownerAdminUserId: true, organizationId: true } }, domain: { select: { domain: true, status: true, receivingStatus: true } } } });
  if (!row) return { address, found: false };
  const mailbox = row.mailbox;
  const owner = mailbox?.ownerAdminUserId ? await prisma.adminUser.findUnique({ where: { id: mailbox.ownerAdminUserId }, select: { id: true, status: true, tier: true } }) : null;
  const memberships = mailbox ? await prisma.mailMembership.findMany({ where: { mailboxId: mailbox.id, revokedAt: null }, select: { adminUserId: true, role: true, expiresAt: true } }) : [];
  const inbound = mailbox ? await prisma.mailMessage.count({ where: { mailboxId: mailbox.id, direction: "INBOUND", deletedAt: null } }) : 0;
  const lastInbound = mailbox ? await prisma.mailMessage.findFirst({ where: { mailboxId: mailbox.id, direction: "INBOUND" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }) : null;
  return {
    address,
    found: true,
    status: row.status,
    kind: row.kind,
    domain: row.domain,
    mailbox: mailbox ? { id: mailbox.id, type: mailbox.type, purpose: mailbox.purpose, status: mailbox.status } : null,
    owner: owner ? { id: owner.id, status: owner.status, tier: owner.tier } : null,
    activeMemberships: memberships.length,
    ownerIsMember: Boolean(owner && memberships.some((member) => member.adminUserId === owner.id)),
    inboundMessages: inbound,
    lastInboundAt: iso(lastInbound?.createdAt),
    // What the inbound processor's recipient query requires.
    routable: row.status === "ACTIVE" && Boolean(row.mailboxId) && mailbox?.status === "ACTIVE" && row.domain?.status !== "SUSPENDED" && row.domain?.receivingStatus !== "DISABLED",
  };
}

async function main() {
  const out = { generatedAt: new Date(now).toISOString() };
  const db = await prisma.$queryRawUnsafe("SELECT current_database() AS name");
  out.database = db?.[0]?.name || null;
  out.env = {
    deployment: process.env.MAIL_DEPLOYMENT_ENV || null,
    flags: Object.fromEntries(Object.keys(process.env).filter((key) => /^MAIL_.*_ENABLED$/.test(key) || ["MAIL_WORKER_QUEUES", "MAIL_ROLLOUT_ENFORCED", "MAIL_INBOUND_ACTIVE_ENVIRONMENT", "MAIL_UNKNOWN_RECIPIENT_POLICY", "MAIL_RELEASE_IMAGE"].includes(key)).sort().map((key) => [key, String(process.env[key]).trim().slice(0, 120)])),
    allowlistedDomains: [...ownedDomains],
  };
  if (MODE === "identity") return out;

  out.jobs = await safe("jobs", async () => {
    const rows = await prisma.mailOutboxJob.groupBy({ by: ["queue", "kind", "status"], _count: { _all: true }, _min: { createdAt: true, nextAttemptAt: true }, _max: { updatedAt: true } });
    return rows.map((row) => ({ queue: row.queue, kind: row.kind, status: row.status, count: row._count._all, oldestCreatedAgeMin: ageMinutes(row._min.createdAt), earliestNextAttemptAgeMin: ageMinutes(row._min.nextAttemptAt), lastUpdatedAgeMin: ageMinutes(row._max.updatedAt) })).sort((a, b) => `${a.queue}${a.kind}${a.status}`.localeCompare(`${b.queue}${b.kind}${b.status}`));
  });

  out.events = await safe("events", async () => {
    const rows = await prisma.mailWebhookEvent.groupBy({ by: ["eventType", "status"], _count: { _all: true }, _min: { receivedAt: true }, _max: { receivedAt: true } });
    return rows.map((row) => ({ type: row.eventType, status: row.status, count: row._count._all, oldestAgeMin: ageMinutes(row._min.receivedAt), newestAgeMin: ageMinutes(row._max.receivedAt) }));
  });

  // Every inbound job, individually (the queue is small).
  out.inboundJobs = await safe("inboundJobs", async () => {
    const jobs = await prisma.mailOutboxJob.findMany({ where: { queue: "INBOUND", kind: { not: "WORKER_HEARTBEAT" } }, orderBy: { createdAt: "asc" }, take: 100, select: { id: true, kind: true, status: true, idempotencyKey: true, attemptCount: true, maxAttempts: true, createdAt: true, nextAttemptAt: true, completedAt: true, lastErrorCode: true, leaseOwner: true, leaseExpiresAt: true, webhookEventId: true, payload: true } });
    const result = [];
    for (const job of jobs) {
      const payload = job.payload && typeof job.payload === "object" ? job.payload : {};
      const providerEmailId = payload.providerEmailId ? String(payload.providerEmailId) : null;
      const event = job.webhookEventId ? await prisma.mailWebhookEvent.findUnique({ where: { id: job.webhookEventId }, select: { id: true, providerEventId: true, eventType: true, status: true, receivedAt: true, processedAt: true, lastError: true, payload: true } }) : null;
      const eventData = event?.payload?.data || {};
      const copies = providerEmailId ? await prisma.mailMessage.findMany({ where: { providerMessageId: providerEmailId, direction: "INBOUND" }, select: { id: true, mailboxId: true, threadId: true, status: true, createdAt: true, thread: { select: { folder: true } } } }) : [];
      const recipients = [...new Set((Array.isArray(payload.to) ? payload.to : []).map(ownAddress).filter(Boolean))];
      result.push({
        id: job.id,
        kind: job.kind,
        status: job.status,
        source: payload.source || (job.idempotencyKey.startsWith("inbound:resend:") ? "webhook" : job.idempotencyKey.split(":").slice(0, 2).join(":")),
        attempts: `${job.attemptCount}/${job.maxAttempts}`,
        createdAt: iso(job.createdAt),
        ageMin: ageMinutes(job.createdAt),
        nextAttemptAt: iso(job.nextAttemptAt),
        completedAt: iso(job.completedAt),
        lastErrorCode: job.lastErrorCode,
        leased: Boolean(job.leaseOwner),
        providerEmailId,
        recipients,
        event: event ? { id: event.id, providerEventId: event.providerEventId, type: event.eventType, status: event.status, receivedAt: iso(event.receivedAt), processedAt: iso(event.processedAt), lastError: event.lastError ? String(event.lastError).slice(0, 64) : null, providerCreatedAt: eventData.created_at || null, senderDomain: domainOf(eventData.from) } : null,
        storedCopies: copies.map((copy) => ({ messageId: copy.id, mailboxId: copy.mailboxId, threadId: copy.threadId, status: copy.status, folder: copy.thread?.folder || null, createdAt: iso(copy.createdAt) })),
      });
    }
    return result;
  });

  // Recipient routing for every own address seen in inbound jobs, plus the
  // personal mailbox named in the incident.
  out.recipientResolution = await safe("recipientResolution", async () => {
    const addresses = new Set(["favour@karryam.com"]);
    for (const job of Array.isArray(out.inboundJobs) ? out.inboundJobs : []) for (const address of job.recipients) addresses.add(address);
    const resolved = [];
    for (const address of addresses) resolved.push(await addressResolution(address));
    return resolved;
  });

  out.rollout = await safe("rollout", async () => {
    const environment = process.env.MAIL_DEPLOYMENT_ENV || "production";
    const rules = await prisma.mailRolloutRule.findMany({ where: { environment, revokedAt: null }, select: { capability: true, scopeType: true, effect: true, createdAt: true } });
    const stops = await prisma.mailEmergencyStop.findMany({ where: { environment, releasedAt: null }, select: { scope: true, activatedAt: true } });
    return { environment, activeRules: rules.map((rule) => ({ capability: rule.capability, scopeType: rule.scopeType, effect: rule.effect, createdAt: iso(rule.createdAt) })), activeEmergencyStops: stops.map((stop) => ({ scope: stop.scope, activatedAt: iso(stop.activatedAt) })) };
  });

  out.mailboxes = await safe("mailboxes", async () => {
    const rows = await prisma.mailMailbox.groupBy({ by: ["type", "status"], _count: { _all: true } });
    return rows.map((row) => ({ type: row.type, status: row.status, count: row._count._all }));
  });

  out.lastInbound = await safe("lastInbound", async () => {
    const row = await prisma.mailMessage.findFirst({ where: { direction: "INBOUND" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    return { lastDeliveredAt: iso(row?.createdAt), ageMin: ageMinutes(row?.createdAt), total: await prisma.mailMessage.count({ where: { direction: "INBOUND" } }) };
  });

  out.heartbeats = await safe("heartbeats", async () => {
    const rows = await prisma.mailOutboxJob.findMany({ where: { kind: "WORKER_HEARTBEAT" }, orderBy: { completedAt: "desc" }, take: 10, select: { idempotencyKey: true, completedAt: true, payload: true } });
    return rows.map((row) => ({ instance: row.idempotencyKey, ageSeconds: row.completedAt ? Math.round((now - row.completedAt.getTime()) / 1000) : null, state: row.payload?.state || null, activeQueues: row.payload?.activeQueues || [], pausedQueues: row.payload?.pausedQueues || [], release: row.payload?.release || null, database: row.payload?.database || null, counters: row.payload?.counters || {} }));
  });

  out.inboundAudit7d = await safe("inboundAudit7d", async () => {
    const rows = await prisma.mailAuditEvent.groupBy({ by: ["action"], where: { action: { startsWith: "MAIL_INBOUND_" }, createdAt: { gt: new Date(now - 7 * 86400000) } }, _count: { _all: true } });
    return Object.fromEntries(rows.map((row) => [row.action, row._count._all]));
  });

  out.openAlerts = await safe("openAlerts", async () => {
    const rows = await prisma.mailOpsAlert.findMany({ where: { resolvedAt: null }, select: { code: true, severity: true, occurrences: true, firstSeenAt: true } });
    return rows.map((row) => ({ code: row.code, severity: row.severity, occurrences: row.occurrences, firstSeenAt: iso(row.firstSeenAt) }));
  });
  return out;
}

main()
  .then((out) => process.stdout.write(`CA_MAIL_DIAG ${JSON.stringify(out)}\n`))
  .catch((error) => {
    process.stdout.write(`CA_MAIL_DIAG ${JSON.stringify({ error: String(error?.code || error?.name || "error") })}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
