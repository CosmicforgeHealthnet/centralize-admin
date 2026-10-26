"use strict";

// Evidence-based "replied" metric for marketing campaigns (spec 13.3).
//
// A reply is attributed to a campaign only when ALL of these hold:
//   1. it arrived in a mailbox that owns the campaign's Reply-To address
//      (or its From address when no Reply-To was set) - i.e. the approved
//      shared reply mailbox of the same brand/organization;
//   2. its sender is a recipient the provider accepted for that dispatch;
//   3. it is a reply (In-Reply-To present, or a "Re:" subject);
//   4. it arrived after the provider accepted the mail for that recipient
//      (recipient acceptedAt, i.e. the send handoff - not the later
//      reconcile time) and inside the reply window.
// When several campaigns qualify, the most recently sent one wins. Opens and
// clicks are never used. One row per recipient (deduplicated); the row holds
// ids only, so reports never expose the reply's content.

const METHOD = "RECIPIENT_REPLY_ADDRESS_MATCH";

function createCampaignReplies({ client, config, features, audit = null, clock = () => new Date() }) {
  async function attributeInbound({ mailbox, message }) {
    if (!(await features.isReady())) return null;
    if (!message || message.direction !== "INBOUND" || message.status === "QUARANTINED") return null;
    const isReply = Boolean(message.inReplyTo) || /^\s*re\s*:/i.test(message.subject || "");
    if (!isReply || !message.fromAddress) return null;
    const receivedAt = message.receivedAt || message.createdAt || clock();
    const since = new Date(receivedAt.getTime() - config.marketingReplies.windowDays * 86400000);
    const addresses = (await client.mailAddress.findMany({ where: { mailboxId: mailbox.id }, select: { address: true } })).map((row) => row.address);
    if (!addresses.length) return null;
    const candidates = await client.marketingBroadcastRecipient.findMany({
      where: {
        organizationId: mailbox.organizationId,
        email: message.fromAddress.toLowerCase(),
        acceptedAt: { gte: since, lte: receivedAt },
      },
      include: { dispatch: { select: { id: true, campaignId: true, approvalSnapshotId: true, providerSentAt: true } } },
      orderBy: { acceptedAt: "desc" },
      take: 20,
    });
    for (const candidate of candidates) {
      const snapshot = await client.marketingCampaignSnapshot.findUnique({ where: { id: candidate.dispatch.approvalSnapshotId }, select: { replyTo: true, senderAddress: true } });
      const replyAddress = String(snapshot?.replyTo || snapshot?.senderAddress || "").toLowerCase();
      if (!replyAddress || !addresses.includes(replyAddress)) continue;
      try {
        const row = await client.marketingCampaignReply.create({
          data: { organizationId: mailbox.organizationId, campaignId: candidate.dispatch.campaignId, dispatchId: candidate.dispatch.id, recipientId: candidate.id, mailMessageId: message.id, method: METHOD, receivedAt },
        });
        if (audit) await audit.record({ action: "MARKETING_REPLY_ATTRIBUTED", targetType: "marketing_campaign", targetId: candidate.dispatch.campaignId, organizationId: mailbox.organizationId, metadata: { dispatchId: candidate.dispatch.id } });
        return row;
      } catch (error) {
        // Already counted for this recipient (deduplicated) or this message.
        if (error?.code === "P2002") return null;
        throw error;
      }
    }
    return null;
  }

  // Report block for one dispatch. `null` while migration 35 is missing.
  async function summary(dispatch) {
    if (!(await features.isReady())) return null;
    const [replied, first] = await Promise.all([
      client.marketingCampaignReply.count({ where: { dispatchId: dispatch.id } }),
      client.marketingCampaignReply.findFirst({ where: { dispatchId: dispatch.id }, orderBy: { receivedAt: "asc" }, select: { receivedAt: true } }),
    ]);
    // The window opens at the provider handoff (send attempt), falling back
    // to the reconcile-time providerSentAt for older dispatches.
    const windowStart = dispatch.providerSendAttemptAt || dispatch.providerSentAt || null;
    const windowEnd = windowStart ? new Date(windowStart.getTime() + config.marketingReplies.windowDays * 86400000) : null;
    return {
      replied,
      method: METHOD,
      denominator: "recipients accepted by the provider",
      window: { from: windowStart ? windowStart.toISOString() : null, to: windowEnd ? windowEnd.toISOString() : null, days: config.marketingReplies.windowDays },
      firstReplyAt: first?.receivedAt ? first.receivedAt.toISOString() : null,
      note: "Counts distinct recipients whose reply reached the campaign's reply mailbox; content is never included.",
    };
  }

  return { attributeInbound, summary, METHOD };
}

module.exports = { createCampaignReplies, METHOD };
