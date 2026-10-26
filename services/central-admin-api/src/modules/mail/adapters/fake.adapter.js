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
    failNext(operation, kind, code = "FAKE_FAILURE", { acceptBeforeFailing = false, now = null, category = null } = {}) {
      state.failures.push({ operation, kind, code, acceptBeforeFailing, now, category });
    },
    addInbound(providerEmailId, message, attachments = []) {
      state.inbound.set(providerEmailId, message);
      state.attachments.set(providerEmailId, attachments);
    },
    async sendMessage(request) {
      const failure = nextFailure("sendMessage");
      // failNext("sendMessage", "QUOTA_EXHAUSTED", "DAILY"|"MONTHLY", { now })
      // models Resend's 429 daily_quota_exceeded / monthly_quota_exceeded.
      if (failure?.kind === "QUOTA_EXHAUSTED") {
        const { quotaExhaustedError } = require("../ops/provider-quota.service");
        throw quotaExhaustedError(failure.code === "MONTHLY" ? "MONTHLY" : "DAILY", { now: failure.now || new Date() });
      }
      if (failure && !failure.acceptBeforeFailing) throw new MailProviderError(failure.kind, failure.code, "fake failure", failure.category ? { category: failure.category } : {});
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
      const failure = nextFailure("validateDomain");
      if (failure) throw new MailProviderError(failure.kind, failure.code, "fake failure", failure.category ? { category: failure.category } : {});
      return state.domains.get(providerDomainId) || { status: "PENDING", sendingStatus: "PENDING", receivingStatus: "PENDING", records: [] };
    },
    // §18 domain lifecycle (offline): registration is NOT idempotent, like
    // Resend's POST /domains; a second create of the same name is refused.
    async createDomain({ name, receiving = false } = {}) {
      const failure = nextFailure("createDomain");
      if (failure) throw new MailProviderError(failure.kind, failure.code, "fake failure", failure.category ? { category: failure.category } : {});
      const domain = String(name || "").toLowerCase();
      if ([...state.domains.values()].some((entry) => entry.name === domain)) throw new MailProviderError("PERMANENT", "RESEND_HTTP_403", "domain already registered", { status: 403, category: "PERMISSION_DENIED" });
      const providerDomainId = `fake_dom_${crypto.randomUUID()}`;
      const entry = { providerDomainId, name: domain, status: "NOT_STARTED", sendingStatus: "PENDING", receivingStatus: receiving ? "PENDING" : "DISABLED", spfStatus: "PENDING", dkimStatus: "PENDING", dmarcStatus: "NOT_REPORTED", records: [] };
      state.domains.set(providerDomainId, entry);
      return entry;
    },
    async verifyDomain(providerDomainId) {
      const failure = nextFailure("verifyDomain");
      if (failure) throw new MailProviderError(failure.kind, failure.code, "fake failure", failure.category ? { category: failure.category } : {});
      const entry = state.domains.get(providerDomainId);
      if (!entry) throw new MailProviderError("PERMANENT", "RESEND_HTTP_404", "unknown domain", { status: 404, category: "NOT_FOUND" });
      return { providerDomainId, status: "PENDING" };
    },
    async findDomainByName(name) {
      const domain = String(name || "").toLowerCase();
      return [...state.domains.entries()].map(([providerDomainId, entry]) => ({ providerDomainId, ...entry })).find((entry) => entry.name === domain) || null;
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
