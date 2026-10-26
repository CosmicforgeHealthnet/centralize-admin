"use strict";

// Offline, deterministic marketing provider for tests and local development.
// Models Resend's documented behaviour: account-global contacts with a global
// unsubscribed flag, segments, non-idempotent broadcasts with the
// draft -> queued -> sent / canceled lifecycle, and Idempotency-Key semantics
// for single emails. Never performs network I/O.

const crypto = require("crypto");
const { MailProviderError } = require("../mail-provider.contract");

function createFakeMarketingAdapter({ name = "fake", resubscribeSupported = true } = {}) {
  const state = {
    contacts: new Map(), // email -> { id, email, firstName, lastName, unsubscribed, segments:Set }
    segments: new Map(), // id -> { id, name, deleted }
    broadcasts: new Map(), // id -> { id, name, segmentId, from, subject, html, text, status, sendCalls }
    emails: [],
    byIdempotency: new Map(),
    failures: [],
    calls: [],
    // GAP 2 test knob: the provider accepts the PATCH but the contact stays
    // unsubscribed (verification mismatch).
    ignoreResubscribe: false,
  };

  function record(operation, detail) {
    state.calls.push({ operation, ...detail });
  }

  function nextFailure(operation) {
    const index = state.failures.findIndex((entry) => entry.operation === operation);
    if (index === -1) return null;
    const [failure] = state.failures.splice(index, 1);
    return failure;
  }

  // acceptBeforeFailing: the provider performs the write, then the response is lost (ambiguous).
  async function guarded(operation, perform) {
    const failure = nextFailure(operation);
    // GAP 3: failNext(op, "QUOTA_EXHAUSTED", "DAILY"|"MONTHLY", { now }) models
    // Resend's 429 daily_quota_exceeded / monthly_quota_exceeded.
    if (failure?.kind === "QUOTA_EXHAUSTED") {
      const { quotaExhaustedError } = require("../../ops/provider-quota.service");
      throw quotaExhaustedError(failure.code === "MONTHLY" ? "MONTHLY" : "DAILY", { now: failure.now || new Date() });
    }
    if (failure && !failure.acceptBeforeFailing) throw new MailProviderError(failure.kind, failure.code, `fake ${operation} failure`, { retryAfterSeconds: failure.retryAfterSeconds ?? null });
    const result = await perform();
    if (failure) throw new MailProviderError(failure.kind, failure.code, `fake ${operation} lost response`);
    return result;
  }

  const findContactById = (id) => [...state.contacts.values()].find((contact) => contact.id === id);

  const adapter = {
    name,
    configured: true,
    quotaScope: null,
    resubscribeSupported,
    state,
    setQuotaObserver() {},
    failNext(operation, kind, code = "FAKE_FAILURE", options = {}) {
      state.failures.push({ operation, kind, code, ...options });
    },
    // Test helpers ------------------------------------------------------
    providerUnsubscribe(email) {
      const contact = state.contacts.get(String(email).toLowerCase());
      if (contact) contact.unsubscribed = true;
      return contact || null;
    },
    segmentMembers(segmentId) {
      return [...state.contacts.values()].filter((contact) => contact.segments.has(segmentId));
    },
    // Simulates the provider finishing a queued broadcast. Returns the emails
    // the provider would have produced (unsubscribed contacts are skipped).
    completeBroadcast(broadcastId) {
      const broadcast = state.broadcasts.get(broadcastId);
      if (!broadcast || broadcast.status !== "QUEUED") return [];
      broadcast.status = "SENT";
      broadcast.sentAt = new Date();
      return adapter.segmentMembers(broadcast.segmentId).filter((contact) => !contact.unsubscribed).map((contact) => ({ email: contact.email, emailId: `fake_bc_${crypto.randomUUID()}`, contactId: contact.id }));
    },
    // Contract ----------------------------------------------------------
    async getContact(email) {
      return guarded("getContact", async () => {
        record("getContact", { email });
        const contact = state.contacts.get(String(email).toLowerCase());
        return contact ? { id: contact.id, email: contact.email, unsubscribed: contact.unsubscribed } : null;
      });
    },
    async createContact({ email, firstName, lastName, segmentIds = [] }) {
      return guarded("createContact", async () => {
        record("createContact", { email });
        const key = String(email).toLowerCase();
        if (state.contacts.has(key)) throw new MailProviderError("PERMANENT", "RESEND_HTTP_409", "contact already exists", { status: 409 });
        const contact = { id: `fake_contact_${crypto.randomUUID()}`, email: key, firstName: firstName || null, lastName: lastName || null, unsubscribed: false, segments: new Set(segmentIds) };
        state.contacts.set(key, contact);
        return { id: contact.id };
      });
    },
    // GAP 2: models PATCH /contacts/{id} {unsubscribed:false}.
    async resubscribeContact(contactId) {
      return guarded("resubscribeContact", async () => {
        record("resubscribeContact", { contactId });
        if (!resubscribeSupported) throw new MailProviderError("PERMANENT", "PROVIDER_RESUBSCRIBE_NOT_ENABLED", "fake provider without re-subscription");
        const contact = findContactById(contactId);
        if (!contact) throw new MailProviderError("PERMANENT", "RESEND_HTTP_404", "unknown contact", { status: 404 });
        if (!state.ignoreResubscribe) contact.unsubscribed = false;
        return { id: contact.id };
      });
    },
    async addContactToSegment(contactId, segmentId) {
      return guarded("addContactToSegment", async () => {
        record("addContactToSegment", { contactId, segmentId });
        const contact = findContactById(contactId);
        if (!contact) throw new MailProviderError("PERMANENT", "RESEND_HTTP_404", "unknown contact", { status: 404 });
        contact.segments.add(segmentId);
      });
    },
    async removeContactFromSegment(contactId, segmentId) {
      return guarded("removeContactFromSegment", async () => {
        record("removeContactFromSegment", { contactId, segmentId });
        findContactById(contactId)?.segments.delete(segmentId);
      });
    },
    async createSegment(segmentName) {
      return guarded("createSegment", async () => {
        record("createSegment", { name: segmentName });
        const segment = { id: `fake_segment_${crypto.randomUUID()}`, name: segmentName, deleted: false };
        state.segments.set(segment.id, segment);
        return { id: segment.id };
      });
    },
    async findSegmentByName(segmentName) {
      return guarded("findSegmentByName", async () => {
        const segment = [...state.segments.values()].find((entry) => entry.name === segmentName && !entry.deleted);
        return segment ? { id: segment.id } : null;
      });
    },
    async deleteSegment(segmentId) {
      return guarded("deleteSegment", async () => {
        record("deleteSegment", { segmentId });
        const segment = state.segments.get(segmentId);
        if (segment) segment.deleted = true;
      });
    },
    async createBroadcast(input) {
      return guarded("createBroadcast", async () => {
        record("createBroadcast", { name: input.name });
        if (!state.segments.get(input.segmentId)) throw new MailProviderError("PERMANENT", "RESEND_HTTP_422", "segment not found", { status: 422 });
        const broadcast = { id: `fake_broadcast_${crypto.randomUUID()}`, ...input, status: "DRAFT", sendCalls: 0 };
        state.broadcasts.set(broadcast.id, broadcast);
        return { id: broadcast.id };
      });
    },
    async findBroadcastByName(broadcastName) {
      return guarded("findBroadcastByName", async () => {
        const broadcast = [...state.broadcasts.values()].find((entry) => entry.name === broadcastName && entry.status !== "DELETED");
        return broadcast ? { id: broadcast.id, status: broadcast.status } : null;
      });
    },
    async sendBroadcast(broadcastId, { scheduledAt = null } = {}) {
      return guarded("sendBroadcast", async () => {
        record("sendBroadcast", { broadcastId });
        const broadcast = state.broadcasts.get(broadcastId);
        if (!broadcast) throw new MailProviderError("PERMANENT", "RESEND_HTTP_404", "unknown broadcast", { status: 404 });
        if (broadcast.status !== "DRAFT") throw new MailProviderError("PERMANENT", "RESEND_HTTP_422", `broadcast is ${broadcast.status}`, { status: 422 });
        broadcast.sendCalls += 1;
        broadcast.status = scheduledAt ? "SCHEDULED" : "QUEUED";
        return { id: broadcast.id };
      });
    },
    async getBroadcast(broadcastId) {
      return guarded("getBroadcast", async () => {
        const broadcast = state.broadcasts.get(broadcastId);
        return broadcast && broadcast.status !== "DELETED" ? { id: broadcast.id, status: broadcast.status, sentAt: broadcast.sentAt || null } : null;
      });
    },
    async cancelBroadcast(broadcastId) {
      return guarded("cancelBroadcast", async () => {
        record("cancelBroadcast", { broadcastId });
        const broadcast = state.broadcasts.get(broadcastId);
        if (!broadcast || !["QUEUED", "SCHEDULED"].includes(broadcast.status)) throw new MailProviderError("PERMANENT", "RESEND_HTTP_422", "not cancelable", { status: 422 });
        broadcast.status = broadcast.status === "SCHEDULED" ? "DRAFT" : "CANCELED";
      });
    },
    async deleteBroadcast(broadcastId) {
      return guarded("deleteBroadcast", async () => {
        record("deleteBroadcast", { broadcastId });
        const broadcast = state.broadcasts.get(broadcastId);
        if (broadcast && ["DRAFT", "SCHEDULED"].includes(broadcast.status)) broadcast.status = "DELETED";
      });
    },
    async sendEmail(request) {
      const failure = nextFailure("sendEmail");
      if (failure?.kind === "QUOTA_EXHAUSTED") {
        const { quotaExhaustedError } = require("../../ops/provider-quota.service");
        throw quotaExhaustedError(failure.code === "MONTHLY" ? "MONTHLY" : "DAILY", { now: failure.now || new Date() });
      }
      if (failure && !failure.acceptBeforeFailing) throw new MailProviderError(failure.kind, failure.code, "fake sendEmail failure");
      if (state.byIdempotency.has(request.idempotencyKey)) return { providerMessageId: state.byIdempotency.get(request.idempotencyKey) };
      const providerMessageId = `fake_mkt_${crypto.randomUUID()}`;
      state.byIdempotency.set(request.idempotencyKey, providerMessageId);
      state.emails.push({ ...request, providerMessageId });
      if (failure) throw new MailProviderError(failure.kind, failure.code, "fake sendEmail lost response");
      return { providerMessageId };
    },
    async healthProbe() {
      return { ok: true, latencyMs: 0, detail: "fake" };
    },
  };
  return adapter;
}

module.exports = { createFakeMarketingAdapter };
