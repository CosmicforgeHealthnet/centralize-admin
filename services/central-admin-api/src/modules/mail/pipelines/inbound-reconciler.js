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

  async function isKnown(providerEmailId) {
    const [message, event, job] = await Promise.all([
      client.mailMessage.findFirst({ where: { providerMessageId: providerEmailId, direction: "INBOUND" }, select: { id: true } }),
      client.mailWebhookEvent.findFirst({ where: { eventType: "email.received", payload: { path: ["data", "email_id"], equals: providerEmailId } }, select: { id: true } }),
      client.mailOutboxJob.findFirst({ where: { idempotencyKey: `inbound:reconcile:${providerEmailId}` }, select: { id: true } }),
    ]);
    return Boolean(message || event || job);
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
        if (await isKnown(item.providerEmailId)) continue;
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
        if (job) recovered += 1;
      }
      if (complete || !page.hasMore || !page.items.length) {
        complete = true;
        break;
      }
      after = page.items[page.items.length - 1].providerEmailId;
    }
    await audit.record({ action: "MAIL_INBOUND_RECONCILED", targetType: "reconciliation", outcome: recovered ? "PARTIAL" : "SUCCESS", metadata: { scanned, recovered, pages, complete } });
    return { scanned, recovered, pages, complete };
  }

  return { process };
}

module.exports = { createInboundReconciler };
