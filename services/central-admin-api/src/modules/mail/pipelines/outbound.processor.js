"use strict";

// Outbound dispatch (job kind SEND_MESSAGE).
// - Uses the job's stable idempotency key as the provider Idempotency-Key, so
//   retries and post-crash reconciliation can never create a second email.
// - Provider acceptance is recorded as PROVIDER_ACCEPTED, never DELIVERED;
//   delivery is only learned from provider delivery events.
// - Internal recipients were delivered locally at queue time and BCC'd
//   internal recipients are never sent through the provider.

const { MailProviderError } = require("../adapters/mail-provider.contract");
const { PipelineError } = require("./inbound.processor");

function createOutboundProcessor({ client, config, adapter, store, audit, notifications }) {
  async function process(job) {
    if (!config.sendingEnabled) throw new PipelineError("MAIL_SENDING_DISABLED", "sending disabled", { retryable: true });
    const message = await client.mailMessage.findUnique({
      where: { id: job.messageId },
      include: { recipients: true, attachments: true, mailbox: true },
    });
    if (!message) throw new PipelineError("MESSAGE_MISSING", "message not found", { retryable: false });
    if (message.status !== "QUEUED") return { skipped: true, status: message.status };

    const external = message.recipients.filter((recipient) => recipient.status === "PENDING");
    if (!external.length) {
      await client.mailMessage.update({ where: { id: message.id }, data: { status: "DELIVERED", lastStatusAt: new Date() } });
      return { skipped: true, reason: "NO_EXTERNAL_RECIPIENTS" };
    }
    const visible = message.recipients.filter((recipient) => recipient.type !== "BCC");
    const body = await store.readBody(message);
    const attachments = [];
    for (const attachment of message.attachments) {
      if (attachment.quarantined || attachment.scanStatus !== "CLEAN") throw new PipelineError("ATTACHMENT_NOT_CLEAN", "attachment not clean", { retryable: false });
      attachments.push({ filename: attachment.filename, contentType: attachment.contentType, content: await store.readAttachmentContent(attachment), contentId: attachment.contentId, inline: attachment.isInline });
    }
    const request = {
      idempotencyKey: job.idempotencyKey,
      from: { address: message.fromAddress, name: message.fromName },
      replyTo: message.replyTo,
      to: visible.filter((recipient) => recipient.type === "TO").map((recipient) => ({ address: recipient.address, name: recipient.name })),
      cc: visible.filter((recipient) => recipient.type === "CC").map((recipient) => ({ address: recipient.address, name: recipient.name })),
      bcc: external.filter((recipient) => recipient.type === "BCC").map((recipient) => ({ address: recipient.address, name: recipient.name })),
      subject: message.subject,
      html: body.html,
      text: body.text,
      headers: {
        "Message-ID": message.rfcMessageId,
        ...(message.inReplyTo ? { "In-Reply-To": message.inReplyTo } : {}),
        ...(message.references?.length ? { References: message.references.join(" ") } : {}),
      },
      attachments,
    };
    if (!request.to.length && !request.cc.length && !request.bcc.length) throw new PipelineError("NO_RECIPIENTS", "no recipients", { retryable: false });

    let result;
    try {
      result = await adapter.sendMessage(request);
    } catch (error) {
      if (!(error instanceof MailProviderError)) throw error;
      if (error.kind === "PERMANENT") {
        await markFailed(message, error.code);
        throw new PipelineError(error.code, error.message, { retryable: false });
      }
      const pipelineError = new PipelineError(error.code, error.message, { retryable: true });
      pipelineError.reconcile = error.kind === "AMBIGUOUS";
      pipelineError.retryAfterSeconds = error.retryAfterSeconds;
      throw pipelineError;
    }
    await client.$transaction(async (tx) => {
      await tx.mailMessage.update({ where: { id: message.id }, data: { status: "PROVIDER_ACCEPTED", providerMessageId: result.providerMessageId, sentAt: new Date(), lastStatusAt: new Date() } });
      await tx.mailMessageRecipient.updateMany({ where: { messageId: message.id, status: "PENDING" }, data: { status: "PROVIDER_ACCEPTED", lastEventAt: new Date() } });
      await audit.record({ actorAdminUserId: message.sentByAdminUserId, action: "MAIL_PROVIDER_ACCEPTED", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, metadata: { recipients: external.length } }, {}, tx);
    });
    return { providerMessageId: result.providerMessageId };
  }

  async function markFailed(message, reason) {
    await client.$transaction(async (tx) => {
      await tx.mailMessage.update({ where: { id: message.id }, data: { status: "FAILED", lastStatusAt: new Date(), quarantineReason: null } });
      await tx.mailMessageRecipient.updateMany({ where: { messageId: message.id, status: "PENDING" }, data: { status: "FAILED", lastEventDetail: String(reason).slice(0, 500), lastEventAt: new Date() } });
      await audit.record({ actorAdminUserId: message.sentByAdminUserId, action: "MAIL_SEND_FAILED", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, outcome: "FAILURE", metadata: { reason } }, {}, tx);
    });
    if (message.sentByAdminUserId) {
      await notifications.notifyUsers([message.sentByAdminUserId], { icon: "xcircle", title: "Email could not be sent", subtitle: `From ${message.mailbox?.name || "your mailbox"}` });
    }
  }

  // Called when a job exhausts its attempts.
  async function onDeadLetter(job, error) {
    if (!job.messageId) return;
    const message = await client.mailMessage.findUnique({ where: { id: job.messageId }, include: { mailbox: true } });
    if (!message || message.status !== "QUEUED") return;
    if (error?.reconcile) {
      // Provider outcome unknown: do not claim failure or success.
      await audit.record({ action: "MAIL_SEND_OUTCOME_UNKNOWN", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, outcome: "UNKNOWN", metadata: { code: error.code } });
      if (message.sentByAdminUserId) await notifications.notifyUsers([message.sentByAdminUserId], { icon: "alert", title: "Email delivery status unknown", subtitle: "An administrator is reviewing this send." });
      return;
    }
    await markFailed(message, error?.code || "DEAD_LETTER");
  }

  return { process, onDeadLetter };
}

module.exports = { createOutboundProcessor };
