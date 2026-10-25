"use strict";

// One implementation of "this person no longer wants marketing from this
// brand", used by the unsubscribe link, the preference page, provider
// unsubscribe events and complaints. Always brand-scoped. Effects (in one
// transaction):
// - consent(s) for the brand -> WITHDRAWN (one topic, or all topics);
// - all-topic withdrawals add an active brand suppression (UNSUBSCRIBED or
//   COMPLAINED) and set the contact status;
// - active automation enrollments for the contact exit (UNSUBSCRIBED);
// - broadcast recipients not yet handed to the provider become UNSUBSCRIBED.
// Mail already accepted by the provider cannot be recalled.

const NOT_YET_SENT = ["PENDING", "SYNCED"];

async function enforceWithdrawal(tx, { organizationId, contactId = null, email = null, topic = null, reason = "UNSUBSCRIBED", source, now = new Date() }) {
  const contact = contactId
    ? await tx.marketingContact.findUnique({ where: { id: contactId } })
    : email
      ? await tx.marketingContact.findUnique({ where: { organizationId_email: { organizationId, email: String(email).toLowerCase() } } })
      : null;
  if (contact && contact.organizationId !== organizationId) return { applied: false, reason: "CROSS_BRAND" };
  const address = contact?.email || (email ? String(email).toLowerCase() : null);
  if (!address) return { applied: false, reason: "UNKNOWN_CONTACT" };
  const allTopics = !topic || topic === "*";
  let withdrawn = 0;
  if (contact) {
    const result = await tx.marketingConsent.updateMany({
      where: { contactId: contact.id, organizationId, status: { not: "WITHDRAWN" }, ...(allTopics ? {} : { topic }) },
      data: { status: "WITHDRAWN", withdrawnAt: now, withdrawalSource: String(source).slice(0, 64), confirmationTokenHash: null },
    });
    withdrawn = result.count;
  }
  let suppressionCreated = false;
  if (allTopics || reason === "COMPLAINED") {
    const suppressionReason = reason === "COMPLAINED" ? "COMPLAINED" : reason === "BOUNCED" ? "BOUNCED" : "UNSUBSCRIBED";
    const active = await tx.marketingSuppression.findFirst({ where: { organizationId, email: address, liftedAt: null, reason: suppressionReason } });
    if (!active) {
      await tx.marketingSuppression.create({ data: { organizationId, email: address, reason: suppressionReason, source: String(source).slice(0, 64) } });
      suppressionCreated = true;
    }
    if (contact) {
      const status = suppressionReason === "COMPLAINED" ? "COMPLAINED" : suppressionReason === "BOUNCED" ? "BOUNCED" : "UNSUBSCRIBED";
      await tx.marketingContact.update({ where: { id: contact.id }, data: { status } });
    }
  }
  let enrollmentsExited = 0;
  let recipientsStopped = 0;
  // A single-topic withdrawal is enforced at each automation send step (topic
  // consent is re-checked there); all-topic withdrawals stop everything now.
  if (contact && (allTopics || reason === "COMPLAINED")) {
    const exited = await tx.marketingAutomationEnrollment.updateMany({
      where: { contactId: contact.id, organizationId, status: { in: ["ACTIVE", "WAITING"] } },
      data: { status: "EXITED", exitReason: reason === "COMPLAINED" ? "COMPLAINED" : "UNSUBSCRIBED", nextRunAt: null, completedAt: now },
    });
    enrollmentsExited = exited.count;
    {
      const stopped = await tx.marketingBroadcastRecipient.updateMany({
        where: { contactId: contact.id, organizationId, status: { in: NOT_YET_SENT }, dispatch: { is: { providerSendAttemptAt: null } } },
        data: { status: "UNSUBSCRIBED", exclusionReason: reason === "COMPLAINED" ? "COMPLAINED" : "UNSUBSCRIBED" },
      });
      recipientsStopped = stopped.count;
    }
  }
  return { applied: true, contactId: contact?.id || null, email: address, withdrawn, suppressionCreated, enrollmentsExited, recipientsStopped };
}

module.exports = { enforceWithdrawal };
