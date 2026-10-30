"use strict";

// Resend implementation of the Mail provider contract. Credentials are
// backend-only. All network calls go through an injectable fetch with a hard
// timeout so tests run offline and outages surface as typed errors.

const { MailProviderError, broadcastDisabled } = require("./mail-provider.contract");
const { formatParty, parseParty, parsePartyList } = require("../security/address.util");
const { normalizeMessageId, parseReferences } = require("../security/header-safety");
const { quotaErrorKind, quotaExhaustedError } = require("../ops/provider-quota.service");
const { classifyStatus, resendHttpError, resendTransportError, rateLimitFromHeaders } = require("./resend-errors");

const MAX_ATTACHMENT_DOWNLOAD_BYTES = 40 * 1024 * 1024;
// Documented POST /emails limits: at most 50 addresses in `to`; attachments at
// most 40 MB per email measured after Base64 encoding; Idempotency-Key 1-256
// characters, kept 24 hours.
const MAX_TO_RECIPIENTS = 50;
const MAX_ENCODED_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

function base64Length(bytes) {
  return Math.ceil(bytes / 3) * 4;
}

// Resend idempotency (documented): keys are kept for 24 hours; the same key +
// same payload returns the original response without re-sending; the same key
// + different payload fails with 409 invalid_idempotent_request; a request
// still in flight with the same key fails with 409 concurrent_idempotent_requests.
// Classification lives in resend-errors.js (status + error name -> kind/category).

// Client-side pacing below the documented default (10 requests/s per team).
// Per process only: a 429 from the provider still defers the job durably.
function createRequestPacer(requestsPerSecond, { now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!requestsPerSecond) return async () => {};
  const interval = Math.ceil(1000 / Math.max(1, requestsPerSecond));
  let next = 0;
  return async function acquire() {
    const at = now();
    const wait = Math.max(0, next - at);
    next = Math.max(at, next) + interval;
    if (wait) await sleep(wait);
  };
}

function validationError(code, message) {
  return new MailProviderError("PERMANENT", code, message, { category: "VALIDATION_FAILED", operation: "sendMessage", provider: "resend" });
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (Array.isArray(headers)) {
    const entry = headers.find((item) => String(item?.name || item?.key || "").toLowerCase() === name.toLowerCase());
    return entry ? entry.value : null;
  }
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

const AUTH_VALUES = new Set(["pass", "fail", "gray", "processing_failed", "unknown", "none", "neutral", "softfail", "temperror", "permerror"]);

// Resend's `authentication` object is computed by the provider's receiving
// MTA and returned over the authenticated API: it is provider-verified, unlike
// Authentication-Results headers inside the message, which a sender can forge.
function providerAuthentication(value) {
  if (!value || typeof value !== "object") return null;
  const pick = (entry) => {
    const raw = typeof entry === "object" && entry ? entry.result || entry.status : entry;
    const normalized = String(raw || "").trim().toLowerCase();
    return AUTH_VALUES.has(normalized) ? normalized : normalized ? "unknown" : null;
  };
  const result = { spf: pick(value.spf), dkim: pick(value.dkim), dmarc: pick(value.dmarc) };
  return result.spf || result.dkim || result.dmarc ? result : null;
}

// Bounded copy of the original header map for the encrypted archive.
function originalHeaderList(headers) {
  const list = Array.isArray(headers)
    ? headers.map((item) => [String(item?.name || item?.key || ""), item?.value])
    : Object.entries(headers || {});
  return list
    .filter(([name]) => name && name.length <= 128)
    .slice(0, 300)
    .flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((entry) => ({ name, value: String(entry ?? "").slice(0, 8192) })));
}

function createResendAdapter({ config, fetchImpl = globalThis.fetch, clock = () => Date.now(), quotaObserver = null, sleep }) {
  const { apiKey, baseUrl, timeoutMs, attachmentHostAllowlist } = config.resend;
  const pace = createRequestPacer(config.resend.requestsPerSecond ?? 0, { sleep });
  // Last rate-limit headers seen (non-secret; exposed through healthProbe).
  let lastRateLimit = null;
  // GAP 3: non-blocking quota hook (provider-quota.service observer). It is
  // called after every API response; it must never delay or fail a call.
  let observeQuota = quotaObserver;
  function observe(response, errorName) {
    if (!observeQuota) return;
    try {
      observeQuota({ headers: response.headers, status: response.status, errorName });
    } catch {
      // recording quota is best effort
    }
  }

  function requireConfigured() {
    if (!apiKey) throw new MailProviderError("NOT_CONFIGURED", "RESEND_NOT_CONFIGURED", "Resend API key is not configured", { provider: "resend" });
  }

  async function call(method, path, { body, idempotencyKey, phase = "read", operation = null } = {}) {
    requireConfigured();
    await pace();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "cosmicforge-mail/1",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      // A send that failed in transit may still have been accepted.
      throw resendTransportError(error, { phase, operation });
    } finally {
      clearTimeout(timer);
    }
    let payload = null;
    const text = await response.text().catch(() => "");
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    observe(response, payload?.name || null);
    lastRateLimit = rateLimitFromHeaders(response.headers) || lastRateLimit;
    if (!response.ok) {
      const errorName = String(payload?.name || "");
      // 429 daily/monthly_quota_exceeded: a definitive refusal that lasts until
      // the documented reset, not a short rate-limit retry.
      const quotaKind = quotaErrorKind(response.status, errorName);
      if (quotaKind) throw quotaExhaustedError(quotaKind, { now: new Date(clock()), message: String(payload?.message || errorName).slice(0, 300) });
      throw resendHttpError(response, payload, { operation });
    }
    return payload;
  }

  // Rejected before any network call (nothing was submitted, so PERMANENT
  // is exact). Business rules already enforce these; this is the last guard
  // against a request the provider would refuse or truncate.
  function assertSendable(request) {
    if (!request || typeof request !== "object") throw validationError("SEND_REQUEST_INVALID", "Send request is missing");
    const key = String(request.idempotencyKey || "");
    if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) throw validationError("IDEMPOTENCY_KEY_INVALID", "Idempotency key must be 1-256 characters");
    if (!request.from?.address) throw validationError("FROM_REQUIRED", "From address is required");
    if (!Array.isArray(request.to) || request.to.length === 0) throw validationError("TO_REQUIRED", "At least one To recipient is required");
    if (request.to.length > MAX_TO_RECIPIENTS) throw validationError("TOO_MANY_RECIPIENTS", `At most ${MAX_TO_RECIPIENTS} To recipients per request`);
    if (typeof request.subject !== "string") throw validationError("SUBJECT_REQUIRED", "Subject is required");
    for (const [name, value] of Object.entries(request.headers || {})) {
      if (/[\r\n]/.test(String(name)) || /[\r\n]/.test(String(value))) throw validationError("HEADER_INVALID", "Header contains a line break");
    }
    const encoded = (request.attachments || []).reduce((sum, attachment) => sum + base64Length(Buffer.byteLength(attachment.content || "")), 0);
    if (encoded > MAX_ENCODED_ATTACHMENT_BYTES) throw validationError("ATTACHMENTS_TOO_LARGE", "Attachments exceed 40 MB after encoding");
  }

  async function sendMessage(request) {
    requireConfigured();
    assertSendable(request);
    const body = {
      from: formatParty(request.from),
      to: request.to.map(formatParty),
      ...(request.cc?.length ? { cc: request.cc.map(formatParty) } : {}),
      ...(request.bcc?.length ? { bcc: request.bcc.map(formatParty) } : {}),
      ...(request.replyTo ? { reply_to: request.replyTo } : {}),
      subject: request.subject,
      html: request.html || undefined,
      text: request.text || undefined,
      headers: request.headers || {},
      ...(Array.isArray(request.tags) && request.tags.length ? { tags: request.tags.map((tag) => ({ name: String(tag.name), value: String(tag.value) })) } : {}),
      ...(request.attachments?.length
        ? {
            attachments: request.attachments.map((attachment) => ({
              filename: attachment.filename,
              content: Buffer.from(attachment.content).toString("base64"),
              content_type: attachment.contentType,
              ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
            })),
          }
        : {}),
    };
    const payload = await call("POST", "/emails", { body, idempotencyKey: request.idempotencyKey, phase: "write", operation: "sendMessage" });
    if (!payload?.id) throw new MailProviderError("AMBIGUOUS", "RESEND_NO_ID", "Resend accepted the request without an id", { operation: "sendMessage", provider: "resend" });
    return { providerMessageId: String(payload.id) };
  }

  async function fetchInboundMessage(providerEmailId) {
    const payload = await call("GET", `/emails/receiving/${encodeURIComponent(providerEmailId)}`, { operation: "fetchInboundMessage" });
    const headers = payload?.headers || {};
    const from = parseParty(payload?.from) || parseParty(headerValue(headers, "from"));
    return {
      providerEmailId: String(payload?.id || providerEmailId),
      from,
      replyTo: parseParty(headerValue(headers, "reply-to") || payload?.reply_to)?.address || null,
      to: parsePartyList(payload?.to || []).parties,
      cc: parsePartyList(payload?.cc || []).parties,
      // Routing candidates only (never displayed): every address the message
      // was delivered for, including CC, BCC and the Received "for" clause.
      envelopeRecipients: [...new Set(["envelope_to", "to", "cc", "bcc", "received_for"].flatMap((field) => parsePartyList(payload?.[field] || []).parties.map((party) => party.address)))],
      subject: String(payload?.subject || ""),
      html: payload?.html || null,
      text: payload?.text || null,
      rfcMessageId: normalizeMessageId(payload?.message_id || headerValue(headers, "message-id")),
      inReplyTo: normalizeMessageId(headerValue(headers, "in-reply-to")),
      references: parseReferences(headerValue(headers, "references")),
      receivedAt: payload?.created_at ? new Date(payload.created_at) : new Date(clock()),
      authResults: {
        spf: headerValue(headers, "received-spf") ? String(headerValue(headers, "received-spf")).slice(0, 200) : null,
        authenticationResults: headerValue(headers, "authentication-results") ? String(headerValue(headers, "authentication-results")).slice(0, 500) : null,
      },
      providerAuthentication: providerAuthentication(payload?.authentication),
      spamVerdict: headerValue(headers, "x-spam-flag") ? String(headerValue(headers, "x-spam-flag")).toLowerCase() : null,
      attachmentCount: Array.isArray(payload?.attachments) ? payload.attachments.length : 0,
      originalHeaders: originalHeaderList(headers),
      // Signed, expiring link to the original .eml (spec 10.6); fetched only
      // when the raw-MIME archive policy is on.
      rawMime: payload?.raw?.download_url ? { expiresAt: payload.raw.expires_at ? new Date(payload.raw.expires_at) : null, download: (maxBytes) => download(payload.raw.download_url, maxBytes) } : null,
    };
  }

  function assertSafeDownloadUrl(value) {
    let url;
    try {
      url = new URL(String(value));
    } catch {
      throw new MailProviderError("PERMANENT", "ATTACHMENT_URL_INVALID", "Attachment URL is invalid");
    }
    const host = url.hostname.toLowerCase();
    const allowed = attachmentHostAllowlist.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    if (url.protocol !== "https:" || !allowed || url.username || url.password) {
      throw new MailProviderError("PERMANENT", "ATTACHMENT_URL_NOT_ALLOWED", "Attachment URL host is not allowlisted");
    }
    return url;
  }

  const tooLarge = () => new MailProviderError("PERMANENT", "ATTACHMENT_TOO_LARGE", "Attachment exceeds limit");

  // Reads the body chunk by chunk and aborts as soon as the cap is passed, so
  // a response without (or with a lying) Content-Length is never buffered whole.
  async function readCapped(response, limit, controller) {
    const body = response.body;
    if (!body) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > limit) throw tooLarge();
      return buffer;
    }
    const chunks = [];
    let total = 0;
    const take = (chunk) => {
      total += chunk.byteLength;
      if (total > limit) return false;
      chunks.push(Buffer.from(chunk));
      return true;
    };
    if (typeof body.getReader === "function") {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!take(value)) {
          controller.abort();
          await reader.cancel().catch(() => {});
          throw tooLarge();
        }
      }
    } else {
      for await (const chunk of body) {
        if (!take(chunk)) {
          controller.abort();
          body.destroy?.();
          throw tooLarge();
        }
      }
    }
    return Buffer.concat(chunks, total);
  }

  async function download(urlValue, maxBytes = MAX_ATTACHMENT_DOWNLOAD_BYTES) {
    const limit = Math.min(Number(maxBytes) || MAX_ATTACHMENT_DOWNLOAD_BYTES, MAX_ATTACHMENT_DOWNLOAD_BYTES);
    const url = assertSafeDownloadUrl(urlValue);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), { method: "GET", signal: controller.signal, redirect: "error" });
      // Redirects are never followed (the target host would bypass the allowlist).
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        controller.abort();
        throw new MailProviderError("PERMANENT", "ATTACHMENT_REDIRECT_REFUSED", "Attachment download redirected");
      }
      if (!response.ok) {
        // Signed download links expire: the CDN answers 403 for an expired
        // signature, and a retry re-lists the attachments (fresh links).
        // 404/410 stay PERMANENT (the object is gone).
        if (response.status === 403) throw new MailProviderError("RETRYABLE", "ATTACHMENT_URL_EXPIRED", "Attachment download link expired", { status: response.status, category: "PROVIDER_UNAVAILABLE", operation: "downloadAttachment", provider: "resend" });
        throw new MailProviderError(classifyStatus(response.status), `ATTACHMENT_HTTP_${response.status}`, "Attachment download failed", { status: response.status, operation: "downloadAttachment", provider: "resend" });
      }
      const declared = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(declared) && declared > limit) {
        controller.abort();
        throw tooLarge();
      }
      return await readCapped(response, limit, controller);
    } catch (error) {
      if (error instanceof MailProviderError) throw error;
      throw new MailProviderError("RETRYABLE", "ATTACHMENT_DOWNLOAD_FAILED", "Attachment download did not complete", { category: error?.name === "AbortError" ? "TIMEOUT" : "PROVIDER_UNAVAILABLE", operation: "downloadAttachment", provider: "resend" });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchInboundAttachments(providerEmailId) {
    // Documented: GET /emails/receiving/{email_id}/attachments; without
    // `limit` every attachment is returned; with it, pages use `after`.
    const items = [];
    let after = null;
    for (let page = 0; page < 10; page += 1) {
      const query = after ? `?limit=100&after=${encodeURIComponent(after)}` : page === 0 ? "" : null;
      if (query === null) break;
      const payload = await call("GET", `/emails/receiving/${encodeURIComponent(providerEmailId)}/attachments${query}`, { operation: "fetchInboundAttachments" });
      const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
      items.push(...rows);
      if (!payload?.has_more || !rows.length) break;
      after = rows[rows.length - 1]?.id || null;
      if (!after) break;
    }
    return items.map((item) => ({
      providerAttachmentId: String(item.id || ""),
      filename: String(item.filename || "attachment").slice(0, 255),
      contentType: String(item.content_type || "application/octet-stream").slice(0, 255),
      sizeBytes: Number(item.size || 0),
      contentId: item.content_id ? String(item.content_id).replace(/[<>]/g, "").slice(0, 255) : null,
      inline: item.content_disposition === "inline",
      expiresAt: item.expires_at ? new Date(item.expires_at) : null,
      download: (maxBytes) => download(item.download_url, maxBytes),
    }));
  }

  // Domain status values seen in the API: not_started, pending, verified,
  // failed, temporary_failure, partially_verified (unknown values -> PENDING).
  const DOMAIN_STATUS = { verified: "VERIFIED", failed: "FAILED", temporary_failure: "PENDING", pending: "PENDING", not_started: "NOT_STARTED", partially_verified: "PARTIAL", partially_failed: "PARTIAL" };
  function mapDomain(payload) {
    const records = Array.isArray(payload?.records) ? payload.records : [];
    const kind = (record) => String(record.record || "").toUpperCase();
    const sendingRecords = records.filter((record) => ["SPF", "DKIM"].includes(kind(record)));
    const receivingRecords = records.filter((record) => ["RECEIVING", "RECEIVING_MX", "INBOUND"].includes(kind(record)) || (String(record.type).toUpperCase() === "MX" && /inbound|receiv/i.test(String(record.value || ""))));
    const aggregate = (list) => (!list.length ? "NOT_CONFIGURED" : list.every((record) => record.status === "verified") ? "VERIFIED" : list.some((record) => record.status === "failed") ? "FAILED" : "PENDING");
    const recordStatus = (name) => {
      const list = records.filter((record) => kind(record) === name);
      return list.length ? aggregate(list) : "NOT_CONFIGURED";
    };
    const capabilities = payload?.capabilities && typeof payload.capabilities === "object" ? payload.capabilities : null;
    return {
      providerDomainId: payload?.id ? String(payload.id) : null,
      name: payload?.name ? String(payload.name).toLowerCase() : null,
      status: DOMAIN_STATUS[String(payload?.status || "").toLowerCase()] || (payload?.status ? "PENDING" : "NOT_CONFIGURED"),
      sendingStatus: aggregate(sendingRecords),
      receivingStatus: capabilities && capabilities.receiving === "disabled" ? "DISABLED" : aggregate(receivingRecords),
      spfStatus: recordStatus("SPF"),
      dkimStatus: recordStatus("DKIM"),
      // Resend publishes no DMARC record or DMARC check for a domain; DMARC
      // alignment is verified from DNS by the domain owner (never assumed).
      dmarcStatus: "NOT_REPORTED",
      region: payload?.region ? String(payload.region) : null,
      capabilities: capabilities ? { sending: capabilities.sending || null, receiving: capabilities.receiving || null } : null,
      records: records.map((record) => ({ record: record.record, type: record.type, name: record.name, value: record.value, status: record.status, ttl: record.ttl ?? null, priority: record.priority ?? null })),
    };
  }

  async function validateDomain(providerDomainId) {
    const payload = await call("GET", `/domains/${encodeURIComponent(providerDomainId)}`, { operation: "validateDomain" });
    return mapDomain(payload);
  }

  // POST /domains (documented). Not idempotent at the provider: callers look
  // the domain up by name first (findDomainByName) and never blindly retry.
  async function createDomain({ name, region = null, receiving = false } = {}) {
    const domain = String(name || "").trim().toLowerCase();
    if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
      throw new MailProviderError("PERMANENT", "DOMAIN_NAME_INVALID", "Domain name is invalid", { category: "VALIDATION_FAILED", operation: "createDomain", provider: "resend" });
    }
    const body = { name: domain, ...(region ? { region: String(region) } : {}), capabilities: { sending: "enabled", receiving: receiving ? "enabled" : "disabled" } };
    const payload = await call("POST", "/domains", { body, phase: "write", operation: "createDomain" });
    if (!payload?.id) throw new MailProviderError("AMBIGUOUS", "RESEND_NO_ID", "Domain accepted without an id", { operation: "createDomain", provider: "resend" });
    return mapDomain(payload);
  }

  // POST /domains/{id}/verify starts an asynchronous check (status becomes
  // pending; domain.updated webhooks follow). Safe to repeat.
  async function verifyDomain(providerDomainId) {
    await call("POST", `/domains/${encodeURIComponent(providerDomainId)}/verify`, { phase: "write", operation: "verifyDomain" });
    return { providerDomainId: String(providerDomainId), status: "PENDING" };
  }

  async function findDomainByName(name) {
    const wanted = String(name || "").trim().toLowerCase();
    let after = null;
    for (let page = 0; page < 20; page += 1) {
      const payload = await call("GET", `/domains?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`, { operation: "findDomainByName" });
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const match = rows.find((row) => String(row?.name || "").toLowerCase() === wanted);
      if (match?.id) return validateDomain(String(match.id));
      if (!payload?.has_more || !rows.length) return null;
      after = rows[rows.length - 1].id;
    }
    return null;
  }

  async function retrieveDeliveryEvents(providerMessageId) {
    const payload = await call("GET", `/emails/${encodeURIComponent(providerMessageId)}`, { operation: "retrieveDeliveryEvents" });
    const event = String(payload?.last_event || "").toLowerCase();
    const map = { sent: "SENT", delivered: "DELIVERED", delivery_delayed: "DELIVERY_DELAYED", bounced: "BOUNCED", complained: "COMPLAINED", failed: "FAILED", opened: "OPENED", clicked: "CLICKED" };
    return map[event] ? [{ type: map[event], occurredAt: payload?.created_at ? new Date(payload.created_at) : new Date(clock()), recipient: null }] : [];
  }

  // Inbound reconciliation (spec §10.8): GET /emails/receiving lists received
  // emails newest first; `after` is the id of the last item of the previous
  // page. Only routing metadata is used; content is fetched per email later.
  async function listReceivedEmails({ limit = 100, after = null } = {}) {
    const query = new URLSearchParams({ limit: String(Math.min(Math.max(Number(limit) || 100, 1), 100)) });
    if (after) query.set("after", String(after));
    const payload = await call("GET", `/emails/receiving?${query.toString()}`, { operation: "listReceivedEmails" });
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    return {
      items: rows.filter((row) => row?.id).map((row) => ({ providerEmailId: String(row.id), to: parsePartyList(row.to || []).parties.map((party) => party.address), createdAt: row.created_at ? new Date(row.created_at) : null })),
      hasMore: Boolean(payload?.has_more),
    };
  }

  // GET /domains?limit=1 (read-only). `status` distinguishes an unhealthy
  // provider (UNAVAILABLE / DEGRADED) from a credential or scope problem.
  async function healthProbe() {
    const started = clock();
    try {
      await call("GET", "/domains?limit=1", { operation: "healthProbe" });
      return { ok: true, status: "OK", latencyMs: clock() - started, detail: "reachable", rateLimit: lastRateLimit };
    } catch (error) {
      const status = error?.kind === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : ["AUTHENTICATION_FAILED", "PERMISSION_DENIED"].includes(error?.category) ? "MISCONFIGURED" : error?.category === "RATE_LIMITED" ? "DEGRADED" : "UNAVAILABLE";
      return { ok: false, status, category: error?.category || null, latencyMs: clock() - started, detail: error.code || "unreachable", rateLimit: lastRateLimit };
    }
  }

  return {
    name: "resend",
    quotaScope: "account",
    setQuotaObserver(fn) {
      observeQuota = typeof fn === "function" ? fn : null;
    },
    sendMessage,
    fetchInboundMessage,
    fetchInboundAttachments,
    validateDomain,
    createDomain,
    verifyDomain,
    findDomainByName,
    retrieveDeliveryEvents,
    healthProbe,
    listReceivedEmails,
    rateLimitState: () => lastRateLimit,
    createBroadcast: broadcastDisabled,
    sendBroadcast: broadcastDisabled,
  };
}

module.exports = { createResendAdapter, classifyStatus, createRequestPacer, MAX_TO_RECIPIENTS, MAX_ENCODED_ATTACHMENT_BYTES };
