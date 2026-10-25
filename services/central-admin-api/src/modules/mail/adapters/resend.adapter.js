"use strict";

// Resend implementation of the Mail provider contract. Credentials are
// backend-only. All network calls go through an injectable fetch with a hard
// timeout so tests run offline and outages surface as typed errors.

const { MailProviderError, broadcastDisabled } = require("./mail-provider.contract");
const { formatParty, parseParty, parsePartyList } = require("../security/address.util");
const { normalizeMessageId, parseReferences } = require("../security/header-safety");

const MAX_ATTACHMENT_DOWNLOAD_BYTES = 40 * 1024 * 1024;

// Resend idempotency (documented): keys are kept for 24 hours; the same key +
// same payload returns the original response without re-sending; the same key
// + different payload fails with 409 invalid_idempotent_request; a request
// still in flight with the same key fails with 409 concurrent_idempotent_requests.
function classifyStatus(status, name = "") {
  if (status === 429 || status >= 500) return "RETRYABLE";
  if (status === 409) return name === "invalid_idempotent_request" ? "IDEMPOTENCY_CONFLICT" : "RETRYABLE";
  return "PERMANENT";
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

function createResendAdapter({ config, fetchImpl = globalThis.fetch, clock = () => Date.now() }) {
  const { apiKey, baseUrl, timeoutMs, attachmentHostAllowlist } = config.resend;

  function requireConfigured() {
    if (!apiKey) throw new MailProviderError("NOT_CONFIGURED", "RESEND_NOT_CONFIGURED", "Resend API key is not configured");
  }

  async function call(method, path, { body, idempotencyKey, phase = "read" } = {}) {
    requireConfigured();
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
      const kind = phase === "write" ? "AMBIGUOUS" : "RETRYABLE";
      throw new MailProviderError(kind, error?.name === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR", "Resend request did not complete");
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
    if (!response.ok) {
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      const errorName = String(payload?.name || "");
      const kind = classifyStatus(response.status, errorName);
      throw new MailProviderError(kind, kind === "IDEMPOTENCY_CONFLICT" ? "RESEND_IDEMPOTENCY_CONFLICT" : `RESEND_HTTP_${response.status}`, String(payload?.message || payload?.name || `Resend returned ${response.status}`).slice(0, 300), {
        status: response.status,
        retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
      });
    }
    return payload;
  }

  async function sendMessage(request) {
    requireConfigured();
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
    const payload = await call("POST", "/emails", { body, idempotencyKey: request.idempotencyKey, phase: "write" });
    if (!payload?.id) throw new MailProviderError("AMBIGUOUS", "RESEND_NO_ID", "Resend accepted the request without an id");
    return { providerMessageId: String(payload.id) };
  }

  async function fetchInboundMessage(providerEmailId) {
    const payload = await call("GET", `/emails/receiving/${encodeURIComponent(providerEmailId)}`);
    const headers = payload?.headers || {};
    const from = parseParty(payload?.from) || parseParty(headerValue(headers, "from"));
    return {
      providerEmailId: String(payload?.id || providerEmailId),
      from,
      replyTo: parseParty(headerValue(headers, "reply-to") || payload?.reply_to)?.address || null,
      to: parsePartyList(payload?.to || []).parties,
      cc: parsePartyList(payload?.cc || []).parties,
      envelopeRecipients: parsePartyList(payload?.envelope_to || payload?.to || []).parties.map((party) => party.address),
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
      spamVerdict: headerValue(headers, "x-spam-flag") ? String(headerValue(headers, "x-spam-flag")).toLowerCase() : null,
      attachmentCount: Array.isArray(payload?.attachments) ? payload.attachments.length : 0,
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

  async function download(urlValue) {
    const url = assertSafeDownloadUrl(urlValue);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), { method: "GET", signal: controller.signal, redirect: "error" });
      if (!response.ok) throw new MailProviderError(classifyStatus(response.status), `ATTACHMENT_HTTP_${response.status}`, "Attachment download failed", { status: response.status });
      const declared = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_DOWNLOAD_BYTES) throw new MailProviderError("PERMANENT", "ATTACHMENT_TOO_LARGE", "Attachment exceeds limit");
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_ATTACHMENT_DOWNLOAD_BYTES) throw new MailProviderError("PERMANENT", "ATTACHMENT_TOO_LARGE", "Attachment exceeds limit");
      return buffer;
    } catch (error) {
      if (error instanceof MailProviderError) throw error;
      throw new MailProviderError("RETRYABLE", "ATTACHMENT_DOWNLOAD_FAILED", "Attachment download did not complete");
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchInboundAttachments(providerEmailId) {
    const payload = await call("GET", `/emails/receiving/${encodeURIComponent(providerEmailId)}/attachments`);
    const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    return items.map((item) => ({
      providerAttachmentId: String(item.id || ""),
      filename: String(item.filename || "attachment").slice(0, 255),
      contentType: String(item.content_type || "application/octet-stream").slice(0, 255),
      sizeBytes: Number(item.size || 0),
      contentId: item.content_id ? String(item.content_id).replace(/[<>]/g, "").slice(0, 255) : null,
      inline: item.content_disposition === "inline",
      download: () => download(item.download_url),
    }));
  }

  async function validateDomain(providerDomainId) {
    const payload = await call("GET", `/domains/${encodeURIComponent(providerDomainId)}`);
    const records = Array.isArray(payload?.records) ? payload.records : [];
    const mapStatus = (value) => (value === "verified" ? "VERIFIED" : value === "failed" ? "FAILED" : value ? "PENDING" : "NOT_CONFIGURED");
    const sendingRecords = records.filter((record) => ["SPF", "DKIM"].includes(String(record.record).toUpperCase()));
    const receivingRecords = records.filter((record) => String(record.record).toUpperCase() === "RECEIVING_MX" || (String(record.type).toUpperCase() === "MX" && /inbound|receiv/i.test(String(record.value || ""))));
    const aggregate = (list) => (!list.length ? "NOT_CONFIGURED" : list.every((record) => record.status === "verified") ? "VERIFIED" : list.some((record) => record.status === "failed") ? "FAILED" : "PENDING");
    return {
      status: mapStatus(payload?.status),
      sendingStatus: aggregate(sendingRecords),
      receivingStatus: aggregate(receivingRecords),
      records: records.map((record) => ({ record: record.record, type: record.type, name: record.name, value: record.value, status: record.status, priority: record.priority ?? null })),
    };
  }

  async function retrieveDeliveryEvents(providerMessageId) {
    const payload = await call("GET", `/emails/${encodeURIComponent(providerMessageId)}`);
    const event = String(payload?.last_event || "").toLowerCase();
    const map = { sent: "SENT", delivered: "DELIVERED", delivery_delayed: "DELIVERY_DELAYED", bounced: "BOUNCED", complained: "COMPLAINED", failed: "FAILED", opened: "OPENED", clicked: "CLICKED" };
    return map[event] ? [{ type: map[event], occurredAt: payload?.created_at ? new Date(payload.created_at) : new Date(clock()), recipient: null }] : [];
  }

  async function healthProbe() {
    const started = clock();
    try {
      await call("GET", "/domains");
      return { ok: true, latencyMs: clock() - started, detail: "reachable" };
    } catch (error) {
      return { ok: false, latencyMs: clock() - started, detail: error.code || "unreachable" };
    }
  }

  return {
    name: "resend",
    sendMessage,
    fetchInboundMessage,
    fetchInboundAttachments,
    validateDomain,
    retrieveDeliveryEvents,
    healthProbe,
    createBroadcast: broadcastDisabled,
    sendBroadcast: broadcastDisabled,
  };
}

module.exports = { createResendAdapter, classifyStatus };
