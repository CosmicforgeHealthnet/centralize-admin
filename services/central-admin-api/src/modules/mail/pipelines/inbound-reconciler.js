"use strict";

// Inbound reconciliation (spec §10.8, job kind RECONCILE_INBOUND).
// Webhooks can be lost (provider outage, our 503 while not ready, network).
// Periodically list recently received emails at the provider and enqueue
// normal inbound processing for any email we have no record of. Processing is
// idempotent per mailbox and RFC Message-ID, so a late webhook for the same
// email never creates a duplicate. Emails younger than the grace period are
// skipped so in-flight webhooks win. Only ids and recipients are read here.

function createInboundReconciler({ client, config, adapter, jobs, audit, clock = () => new Date() }) {
  const settings = config.reconciliation;

  const IN_FLIGHT = new Set(["PENDING", "LEASED", "RETRY_SCHEDULED", "RECONCILING"]);
  // FAILED is a permanent, deliberate decision (malformed sender, unknown
  // recipient held for review): handled. DEAD_LETTER/CANCELLED mean transient
  // failures ran out of attempts: not processed.
  const UNSUCCESSFUL = new Set(["DEAD_LETTER", "CANCELLED"]);

  // What do we already know about this provider email?
  //   DELIVERED   a local copy exists
  //   IN_FLIGHT   a processing job is pending/running
  //   PROCESSED   a job succeeded (e.g. every recipient was unknown/rejected)
  //               or failed permanently by design (operators requeue those)
  //   UNRECOVERED every job for it failed or dead-lettered and no copy exists:
  //               a received webhook is NOT proof of processing
  //   UNKNOWN     no record at all
  async function classify(providerEmailId) {
    const message = await client.mailMessage.findFirst({ where: { providerMessageId: providerEmailId, direction: "INBOUND" }, select: { id: true } });
    if (message) return "DELIVERED";
    const events = await client.mailWebhookEvent.findMany({ where: { eventType: "email.received", payload: { path: ["data", "email_id"], equals: providerEmailId } }, select: { id: true, status: true }, take: 10 });
    const jobs = await client.mailOutboxJob.findMany({
      where: { kind: "PROCESS_INBOUND", OR: [{ idempotencyKey: `inbound:reconcile:${providerEmailId}` }, ...(events.length ? [{ webhookEventId: { in: events.map((event) => event.id) } }] : [])] },
      select: { id: true, status: true, idempotencyKey: true },
    });
    if (jobs.some((job) => IN_FLIGHT.has(job.status))) return "IN_FLIGHT";
    if (jobs.some((job) => job.status === "SUCCEEDED" || job.status === "FAILED")) return "PROCESSED";
    if (jobs.length && jobs.every((job) => UNSUCCESSFUL.has(job.status))) {
      return { state: "UNRECOVERED", reconcileAttempted: jobs.some((job) => job.idempotencyKey === `inbound:reconcile:${providerEmailId}`) };
    }
    // An accepted event without a job (pre-queue records) is handled unless
    // it was itself marked failed.
    if (!jobs.length && events.some((event) => event.status !== "FAILED")) return "PROCESSED";
    return "UNKNOWN";
  }

  async function process() {
    if (!config.receivingEnabled || !settings.enabled) return { skipped: "RECONCILIATION_DISABLED" };
    if (typeof adapter.listReceivedEmails !== "function") return { skipped: "PROVIDER_LIST_UNSUPPORTED" };
    const now = clock().getTime();
    const lookback = now - settings.inboundLookbackHours * 3600 * 1000;
    const grace = now - settings.inboundGraceSeconds * 1000;
    let after = null;
    let pages = 0;
    let scanned = 0;
    let recovered = 0;
    let retried = 0;
    let unrecovered = 0;
    const unrecoveredIds = [];
    let complete = false;
    while (pages < settings.inboundMaxPages) {
      const page = await adapter.listReceivedEmails({ limit: 100, after });
      pages += 1;
      for (const item of page.items) {
        const created = item.createdAt ? item.createdAt.getTime() : null;
        if (created !== null && created < lookback) {
          complete = true;
          break;
        }
        scanned += 1;
        if (created === null || created > grace) continue;
        const known = await classify(item.providerEmailId);
        if (known === "DELIVERED" || known === "IN_FLIGHT" || known === "PROCESSED") continue;
        if (known?.state === "UNRECOVERED") {
          // The webhook's job failed. Retry once through reconciliation; if
          // that also failed, report it (operators requeue after fixing the
          // cause) instead of counting the email as processed.
          if (known.reconcileAttempted) {
            unrecovered += 1;
            if (unrecoveredIds.length < 20) unrecoveredIds.push(item.providerEmailId);
            continue;
          }
          retried += 1;
        }
        const job = await jobs.enqueue(null, {
          queue: "INBOUND",
          kind: "PROCESS_INBOUND",
          idempotencyKey: `inbound:reconcile:${item.providerEmailId}`,
          payload: { providerEmailId: item.providerEmailId, to: item.to.slice(0, 100), source: "reconciliation" },
          maxAttempts: config.worker.maxAttempts,
        }).catch((error) => {
          if (error?.code === "P2002") return null;
          throw error;
        });
        if (job?.created !== false && job) recovered += 1;
      }
      if (complete || !page.hasMore || !page.items.length) {
        complete = true;
        break;
      }
      after = page.items[page.items.length - 1].providerEmailId;
    }
    await audit.record({ action: "MAIL_INBOUND_RECONCILED", targetType: "reconciliation", outcome: recovered || unrecovered ? "PARTIAL" : "SUCCESS", metadata: { scanned, recovered, retried, unrecovered, pages, complete } });
    if (unrecovered) {
      await audit.record({ action: "MAIL_INBOUND_UNRECOVERED", targetType: "reconciliation", outcome: "FAILURE", metadata: { count: unrecovered, providerEmailIds: unrecoveredIds } });
    }
    return { scanned, recovered, retried, unrecovered, pages, complete };
  }

  return { process };
}

module.exports = { createInboundReconciler };
