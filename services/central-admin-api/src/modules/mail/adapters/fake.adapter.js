"use strict";

// Offline, deterministic provider used by automated tests and local
// development (MAIL_PROVIDER=fake). It never performs network I/O.

const crypto = require("crypto");
const { MailProviderError, broadcastDisabled } = require("./mail-provider.contract");

function createFakeAdapter() {
  const state = { sent: [], byIdempotency: new Map(), inbound: new Map(), attachments: new Map(), failures: [], domains: new Map() };

  function nextFailure(operation) {
    const index = state.failures.findIndex((entry) => entry.operation === operation);
    if (index === -1) return null;
    const [failure] = state.failures.splice(index, 1);
    return failure;
  }

  return {
    name: "fake",
    state,
    failNext(operation, kind, code = "FAKE_FAILURE", { acceptBeforeFailing = false } = {}) {
      state.failures.push({ operation, kind, code, acceptBeforeFailing });
    },
    addInbound(providerEmailId, message, attachments = []) {
      state.inbound.set(providerEmailId, message);
      state.attachments.set(providerEmailId, attachments);
    },
    async sendMessage(request) {
      const failure = nextFailure("sendMessage");
      if (failure && !failure.acceptBeforeFailing) throw new MailProviderError(failure.kind, failure.code, "fake failure");
      // Provider-side idempotency mirrors Resend's Idempotency-Key semantics.
      if (state.byIdempotency.has(request.idempotencyKey)) return { providerMessageId: state.byIdempotency.get(request.idempotencyKey) };
      const providerMessageId = `fake_${crypto.randomUUID()}`;
      state.byIdempotency.set(request.idempotencyKey, providerMessageId);
      state.sent.push({ ...request, providerMessageId });
      if (failure && failure.acceptBeforeFailing) throw new MailProviderError(failure.kind, failure.code, "fake ambiguous failure");
      return { providerMessageId };
    },
    async listReceivedEmails({ limit = 100, after = null } = {}) {
      const failure = nextFailure("listReceivedEmails");
      if (failure) throw new MailProviderError(failure.kind, failure.code, "fake failure");
      const all = [...state.inbound.entries()]
        .map(([providerEmailId, message]) => ({ providerEmailId, to: (message.to || []).map((party) => party.address), createdAt: message.receivedAt ? new Date(message.receivedAt) : null }))
        .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
      const start = after ? all.findIndex((item) => item.providerEmailId === after) + 1 : 0;
      const items = all.slice(start, start + limit);
      return { items, hasMore: start + limit < all.length };
    },
    async fetchInboundMessage(providerEmailId) {
      const failure = nextFailure("fetchInboundMessage");
      if (failure) throw new MailProviderError(failure.kind, failure.code, "fake failure");
      const message = state.inbound.get(providerEmailId);
      if (!message) throw new MailProviderError("PERMANENT", "NOT_FOUND", "unknown inbound email");
      const { rawMime, ...rest } = message;
      return {
        providerEmailId,
        attachmentCount: (state.attachments.get(providerEmailId) || []).length,
        ...rest,
        rawMime: rawMime == null ? null : {
          expiresAt: null,
          download: async (maxBytes) => {
            const buffer = Buffer.from(rawMime);
            if (maxBytes && buffer.length > maxBytes) throw new MailProviderError("PERMANENT", "ATTACHMENT_TOO_LARGE", "raw too large");
            return buffer;
          },
        },
      };
    },
    async fetchInboundAttachments(providerEmailId) {
      const failure = nextFailure("fetchInboundAttachments");
      if (failure) throw new MailProviderError(failure.kind, failure.code, "fake failure");
      return (state.attachments.get(providerEmailId) || []).map((attachment, index) => ({
        providerAttachmentId: `att_${index}`,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.content.length,
        contentId: attachment.contentId || null,
        inline: Boolean(attachment.inline),
        download: async () => {
          if (attachment.failDownload) throw new MailProviderError("PERMANENT", "ATTACHMENT_URL_EXPIRED", "fake expired attachment link");
          return Buffer.from(attachment.content);
        },
      }));
    },
    async validateDomain(providerDomainId) {
      return state.domains.get(providerDomainId) || { status: "PENDING", sendingStatus: "PENDING", receivingStatus: "PENDING", records: [] };
    },
    async retrieveDeliveryEvents() {
      return [];
    },
    async healthProbe() {
      return { ok: true, latencyMs: 0, detail: "fake" };
    },
    createBroadcast: broadcastDisabled,
    sendBroadcast: broadcastDisabled,
  };
}

module.exports = { createFakeAdapter };
