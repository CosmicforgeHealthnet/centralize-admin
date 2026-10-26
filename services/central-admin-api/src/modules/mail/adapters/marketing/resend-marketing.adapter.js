"use strict";

// Resend implementation of the marketing contract. Endpoints and semantics
// were checked against Resend's published API reference (2026-10-25):
// - POST /contacts, GET|PATCH /contacts/{id|email}; contacts and their
//   `unsubscribed` flag are global to the Resend account (team);
// - POST /segments, GET /segments, DELETE /segments/{id};
//   POST|DELETE /contacts/{id}/segments/{segment_id};
// - POST /broadcasts (segment_id, from, subject, reply_to, html, text, name,
//   send=false creates a draft), POST /broadcasts/{id}/send (scheduled_at),
//   GET /broadcasts/{id} (status draft|scheduled|queued|sent|canceled),
//   POST /broadcasts/{id}/cancel (queued -> canceled, scheduled -> draft),
//   DELETE /broadcasts/{id} (draft/scheduled only);
// - Idempotency-Key is supported only on POST /emails and /emails/batch
//   (24 h retention). Broadcast calls are not idempotent, so the dispatcher
//   reconciles ambiguous outcomes by name/status instead of re-posting;
// - default rate limit 10 requests/s per team; 429 carries retry-after.
// Because contacts are account-global, each brand should use its own Resend
// account/key (see adapters/marketing/index.js).
// GAP 2: re-subscription. Resend documents PATCH /contacts/{id} with
// `unsubscribed: true` only; sending `false` is NOT documented. It is sent
// only when MAIL_MARKETING_PROVIDER_RESUBSCRIBE_ENABLED=true (confirmed with
// Resend support); otherwise resubscribeContact refuses without a call.
// GAP 3: quota headers / quota 429s are reported to a non-blocking observer.
// Preflight: getDomainByName (GET /domains, GET /domains/{id}) verifies the
// sending domain in the brand's own account (optional contract method).

const { MailProviderError } = require("../mail-provider.contract");
const { createResendAdapter, classifyStatus } = require("../resend.adapter");
const { normalizeBroadcastStatus } = require("./marketing-provider.contract");
const { formatParty } = require("../../security/address.util");
const { quotaErrorKind, quotaExhaustedError } = require("../../ops/provider-quota.service");

function createRateLimiter(requestsPerSecond, { now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const interval = Math.ceil(1000 / Math.max(1, requestsPerSecond));
  let next = 0;
  return async function acquire() {
    const at = now();
    const wait = Math.max(0, next - at);
    next = Math.max(at, next) + interval;
    if (wait) await sleep(wait);
  };
}

function createResendMarketingAdapter({ apiKey, config, fetchImpl = globalThis.fetch, clock = () => Date.now(), sleep, quotaObserver = null, quotaScope = null }) {
  const { baseUrl, timeoutMs } = config.resend;
  const acquire = createRateLimiter(config.broadcast.providerRequestsPerSecond, { sleep });
  // Single marketing emails reuse the hardened transport implementation
  // (Idempotency-Key, 409 classification, timeouts) with the brand key.
  const transport = createResendAdapter({ config: { ...config, resend: { ...config.resend, apiKey } }, fetchImpl, clock, quotaObserver });
  let observeQuota = quotaObserver;
  function observe(response, errorName) {
    if (!observeQuota) return;
    try {
      observeQuota({ headers: response.headers, status: response.status, errorName });
    } catch {
      // best effort
    }
  }

  async function call(method, path, { body, phase = "read", notFoundAsNull = false } = {}) {
    if (!apiKey) throw new MailProviderError("NOT_CONFIGURED", "RESEND_NOT_CONFIGURED", "Resend marketing API key is not configured");
    await acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "cosmicforge-mail-marketing/1" },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      throw new MailProviderError(phase === "write" ? "AMBIGUOUS" : "RETRYABLE", error?.name === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR", "Resend request did not complete");
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text().catch(() => "");
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    observe(response, payload?.name || null);
    if (response.status === 404 && notFoundAsNull) return null;
    if (!response.ok) {
      const quotaKind = quotaErrorKind(response.status, String(payload?.name || ""));
      if (quotaKind) throw quotaExhaustedError(quotaKind, { now: new Date(clock()), message: String(payload?.message || payload?.name).slice(0, 300) });
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      const kind = classifyStatus(response.status, String(payload?.name || ""));
      throw new MailProviderError(kind, `RESEND_HTTP_${response.status}`, String(payload?.message || payload?.name || `Resend returned ${response.status}`).slice(0, 300), { status: response.status, retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null });
    }
    return payload;
  }

  const enc = encodeURIComponent;

  async function findByName(path, name) {
    let after = null;
    for (let page = 0; page < 20; page += 1) {
      const payload = await call("GET", `${path}?limit=100${after ? `&after=${enc(after)}` : ""}`);
      const items = Array.isArray(payload?.data) ? payload.data : [];
      const match = items.find((item) => item?.name === name);
      if (match) return match;
      if (!payload?.has_more || !items.length) return null;
      after = items[items.length - 1].id;
    }
    return null;
  }

  return {
    name: "resend",
    configured: true,
    quotaScope,
    resubscribeSupported: Boolean(config.providerResubscribeEnabled),
    setQuotaObserver(fn) {
      observeQuota = typeof fn === "function" ? fn : null;
      transport.setQuotaObserver(observeQuota);
    },
    async getContact(email) {
      const payload = await call("GET", `/contacts/${enc(email)}`, { notFoundAsNull: true });
      if (!payload?.id) return null;
      return { id: String(payload.id), email: String(payload.email || email).toLowerCase(), unsubscribed: payload.unsubscribed === true };
    },
    async createContact({ email, firstName, lastName, segmentIds = [] }) {
      // `unsubscribed` is deliberately omitted: a provider unsubscribe is only
      // ever lifted by an approved re-subscription (resubscribeContact).
      const payload = await call("POST", "/contacts", {
        phase: "write",
        body: { email, ...(firstName ? { first_name: firstName } : {}), ...(lastName ? { last_name: lastName } : {}), ...(segmentIds.length ? { segments: segmentIds.map((id) => ({ id })) } : {}) },
      });
      if (!payload?.id) throw new MailProviderError("AMBIGUOUS", "RESEND_NO_ID", "Contact accepted without an id");
      return { id: String(payload.id) };
    },
    // GAP 2: undocumented provider behaviour, flag-gated (see header).
    async resubscribeContact(contactId) {
      if (!config.providerResubscribeEnabled) throw new MailProviderError("PERMANENT", "PROVIDER_RESUBSCRIBE_NOT_ENABLED", "Provider re-subscription is not enabled (MAIL_MARKETING_PROVIDER_RESUBSCRIBE_ENABLED)");
      await call("PATCH", `/contacts/${enc(contactId)}`, { phase: "write", body: { unsubscribed: false } });
      return { id: String(contactId) };
    },
    async addContactToSegment(contactId, segmentId) {
      await call("POST", `/contacts/${enc(contactId)}/segments/${enc(segmentId)}`, { phase: "write" });
    },
    async removeContactFromSegment(contactId, segmentId) {
      await call("DELETE", `/contacts/${enc(contactId)}/segments/${enc(segmentId)}`, { phase: "write", notFoundAsNull: true });
    },
    async createSegment(name) {
      const payload = await call("POST", "/segments", { phase: "write", body: { name } });
      if (!payload?.id) throw new MailProviderError("AMBIGUOUS", "RESEND_NO_ID", "Segment accepted without an id");
      return { id: String(payload.id) };
    },
    async findSegmentByName(name) {
      const match = await findByName("/segments", name);
      return match ? { id: String(match.id) } : null;
    },
    async deleteSegment(segmentId) {
      await call("DELETE", `/segments/${enc(segmentId)}`, { phase: "write", notFoundAsNull: true });
    },
    async createBroadcast({ name, segmentId, from, replyTo, subject, html, text }) {
      const payload = await call("POST", "/broadcasts", {
        phase: "write",
        body: { name, segment_id: segmentId, from: formatParty(from), subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}), send: false },
      });
      if (!payload?.id) throw new MailProviderError("AMBIGUOUS", "RESEND_NO_ID", "Broadcast accepted without an id");
      return { id: String(payload.id) };
    },
    async findBroadcastByName(name) {
      const match = await findByName("/broadcasts", name);
      return match ? { id: String(match.id), status: normalizeBroadcastStatus(match.status) } : null;
    },
    async sendBroadcast(broadcastId, { scheduledAt = null } = {}) {
      const payload = await call("POST", `/broadcasts/${enc(broadcastId)}/send`, { phase: "write", body: scheduledAt ? { scheduled_at: new Date(scheduledAt).toISOString() } : {} });
      return { id: String(payload?.id || broadcastId) };
    },
    async getBroadcast(broadcastId) {
      const payload = await call("GET", `/broadcasts/${enc(broadcastId)}`, { notFoundAsNull: true });
      if (!payload) return null;
      return { id: String(payload.id || broadcastId), status: normalizeBroadcastStatus(payload.status), sentAt: payload.sent_at ? new Date(payload.sent_at) : null, scheduledAt: payload.scheduled_at ? new Date(payload.scheduled_at) : null };
    },
    async cancelBroadcast(broadcastId) {
      await call("POST", `/broadcasts/${enc(broadcastId)}/cancel`, { phase: "write" });
    },
    async deleteBroadcast(broadcastId) {
      await call("DELETE", `/broadcasts/${enc(broadcastId)}`, { phase: "write", notFoundAsNull: true });
    },
    async sendEmail(request) {
      await acquire();
      return transport.sendMessage(request);
    },
    // Re-audit (preflight): the sending domain as seen by THIS (brand)
    // account. Documented read-only endpoints: GET /domains (list; name per
    // item) and GET /domains/{id} (status + records, mapped like the
    // transactional validateDomain). null when the account has no such domain.
    async getDomainByName(domainName) {
      const match = await findByName("/domains", String(domainName || "").toLowerCase());
      if (!match?.id) return null;
      await acquire();
      return transport.validateDomain(String(match.id));
    },
    async healthProbe() {
      const started = clock();
      try {
        await call("GET", "/segments?limit=1");
        return { ok: true, latencyMs: clock() - started, detail: "reachable" };
      } catch (error) {
        return { ok: false, latencyMs: clock() - started, detail: error.code || "unreachable" };
      }
    },
  };
}

module.exports = { createResendMarketingAdapter, createRateLimiter };
