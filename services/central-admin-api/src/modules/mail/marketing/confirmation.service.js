"use strict";

// Double opt-in confirmation emails (job kind MARKETING_CONFIRMATION_EMAIL).
// The confirmation token is a secret that belongs to the contact: it is kept
// in the job payload only as AES-256-GCM ciphertext (purpose
// marketing-doi-token) and is never logged or returned to admins in
// production. The email links to a GET landing page whose button POSTs the
// confirmation, so link scanners cannot confirm on the contact's behalf.

const crypto = require("crypto");
const { externalSendBlockReason } = require("../authz/sending-gate");
const { classifySendError } = require("./marketing-sender");

const PURPOSE = "marketing-doi-token";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function createConfirmationService({ client, config, audit, jobs, encryption, marketingProviders, clock = () => new Date() }) {
  // Hook used by the marketing service inside the consent transaction.
  async function onConfirmationRequired(tx, { organizationId, contact, consent, token }) {
    if (!config.confirmationEmailsEnabled) return { queued: false, reason: "CONFIRMATION_EMAILS_DISABLED" };
    if (!encryption.available) return { queued: false, reason: "ENCRYPTION_UNAVAILABLE" };
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    await jobs.enqueue(tx, {
      queue: "MARKETING",
      kind: "MARKETING_CONFIRMATION_EMAIL",
      idempotencyKey: `doi:${consent.id}:${tokenHash.slice(0, 24)}`,
      payload: { organizationId, consentId: consent.id, contactId: contact.id, sealedToken: encryption.encrypt(token, PURPOSE).toString("base64") },
      maxAttempts: 8,
    });
    return { queued: true };
  }

  async function process(job) {
    const { organizationId, consentId, contactId, sealedToken } = job.payload || {};
    const consent = await client.marketingConsent.findUnique({ where: { id: consentId } });
    if (!consent || consent.status !== "PENDING_CONFIRMATION" || consent.contactId !== contactId) return { skipped: "CONSENT_NOT_PENDING" };
    const token = encryption.decrypt(Buffer.from(String(sealedToken), "base64"), PURPOSE).toString("utf8");
    if (crypto.createHash("sha256").update(token).digest("hex") !== consent.confirmationTokenHash) return { skipped: "TOKEN_SUPERSEDED" };
    if (!config.confirmationEmailsEnabled || config.emergencyStop.marketing) return { defer: { seconds: 900, code: "CONFIRMATION_EMAILS_HALTED" } };
    const [organization, contact, settings] = await Promise.all([
      client.mailOrganization.findUnique({ where: { id: organizationId } }),
      client.marketingContact.findUnique({ where: { id: contactId } }),
      client.marketingBrandSettings.findUnique({ where: { organizationId } }),
    ]);
    if (!contact || contact.organizationId !== organizationId) return { skipped: "CONTACT_UNAVAILABLE" };
    const suppressed = await client.marketingSuppression.findFirst({ where: { email: contact.email, liftedAt: null, OR: [{ organizationId }, { organizationId: null }] } });
    if (suppressed) return { skipped: "SUPPRESSED" };
    if (!settings?.confirmationSenderId || !config.publicApiUrl) return { defer: { seconds: 3600, code: "CONFIRMATION_SENDER_NOT_CONFIGURED" } };
    const sender = await client.mailAddress.findUnique({ where: { id: settings.confirmationSenderId }, include: { domain: { include: { organization: { select: { id: true, slug: true } } } } } });
    const provider = marketingProviders(organization);
    const blocked = !sender || sender.organizationId !== organizationId || sender.status !== "ACTIVE" ? "SENDER_NOT_AUTHORIZED" : externalSendBlockReason({ config, providerReady: () => provider.configured !== false && provider.name !== "unconfigured", domain: sender.domain });
    if (blocked) return { defer: { seconds: 3600, code: blocked } };
    const link = `${config.publicApiUrl}/api/mail/v1/public/consent/confirm/${encodeURIComponent(token)}`;
    const name = escapeHtml(organization.name);
    try {
      const result = await provider.sendEmail({
        idempotencyKey: job.idempotencyKey,
        from: { address: sender.address, name: sender.displayName || organization.name },
        replyTo: null,
        to: [{ address: contact.email, name: null }],
        cc: [], bcc: [],
        subject: `Confirm your subscription to ${organization.name}`,
        html: `<!DOCTYPE html><html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#1F2937;"><p>Please confirm that you want to receive ${name} emails about <strong>${escapeHtml(consent.topic)}</strong>.</p><p><a href="${escapeHtml(link)}">Confirm subscription</a></p><p style="font-size:12px;color:#6B7280;">If you did not ask for this, ignore this email and you will not be subscribed.${settings.postalAddress ? `<br>${escapeHtml(settings.postalAddress)}` : ""}</p></body></html>`,
        text: `Please confirm that you want to receive ${organization.name} emails about ${consent.topic}.\n\nConfirm: ${link}\n\nIf you did not ask for this, ignore this email.${settings.postalAddress ? `\n${settings.postalAddress}` : ""}`,
        headers: {},
        attachments: [],
      });
      await audit.record({ action: "MARKETING_CONFIRMATION_EMAIL_HANDED_TO_PROVIDER", targetType: "marketing_contact", targetId: contact.id, organizationId, metadata: { topic: consent.topic } });
      return { providerMessageId: result.providerMessageId };
    } catch (error) {
      const verdict = classifySendError(error, { firstAttemptAt: job.createdAt, now: clock(), windowHours: config.reconciliation.idempotencyWindowHours });
      if (verdict.outcome === "RETRY") throw Object.assign(new Error(error.message), { code: verdict.code, retryable: true, retryAfterSeconds: verdict.retryAfterSeconds ?? null });
      if (verdict.outcome === "DEFER") return { defer: { seconds: 3600, code: verdict.code } };
      await audit.record({ action: "MARKETING_CONFIRMATION_EMAIL_FAILED", targetType: "marketing_contact", targetId: contact.id, organizationId, outcome: verdict.outcome === "UNKNOWN" ? "UNKNOWN" : "FAILURE", metadata: { reason: verdict.code } });
      throw Object.assign(new Error(verdict.code), { code: verdict.code, retryable: false });
    }
  }

  return { onConfirmationRequired, process };
}

module.exports = { createConfirmationService };
