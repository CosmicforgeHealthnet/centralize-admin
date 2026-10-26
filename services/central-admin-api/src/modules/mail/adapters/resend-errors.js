"use strict";

// Maps Resend HTTP responses to the provider-neutral error model (§18).
// Source: Resend API reference "Errors" (checked 2026-10-26). Resend returns
// { statusCode, name, message }; the same `name` can appear under several
// statuses (validation_error: 400/401/403), so status and name are read
// together and the message is used only to tell 403 validation_error cases
// apart (unverified domain vs testing mode). The raw provider message is never
// returned to API clients.
//
// kind     = retry semantics used by the workers (unchanged contract)
// category = normalized reason (PROVIDER_ERROR_CATEGORIES)

const { MailProviderError } = require("./mail-provider.contract");

function lower(value) {
  return String(value || "").trim().toLowerCase();
}

// Returns { kind, category }.
function classifyResendResponse(status, name = "", message = "") {
  const errorName = lower(name);
  const text = lower(message);
  const code = Number(status);
  if (code === 400) {
    if (errorName === "validation_error" && /api key/.test(text)) return { kind: "PERMANENT", category: "AUTHENTICATION_FAILED" };
    return { kind: "PERMANENT", category: "VALIDATION_FAILED" }; // incl. invalid_idempotency_key
  }
  if (code === 401) {
    if (errorName === "restricted_api_key") return { kind: "PERMANENT", category: "PERMISSION_DENIED" };
    return { kind: "PERMANENT", category: "AUTHENTICATION_FAILED" }; // missing_api_key, invalid key
  }
  if (code === 403) {
    if (errorName === "email_above_quota") return { kind: "PERMANENT", category: "QUOTA_EXCEEDED" };
    if (errorName === "suspended_api_key") return { kind: "PERMANENT", category: "AUTHENTICATION_FAILED" };
    if (errorName === "invalid_permission" || errorName === "restricted_api_key") return { kind: "PERMANENT", category: "PERMISSION_DENIED" };
    if (/domain/.test(text) && /not verified|verify/.test(text)) return { kind: "PERMANENT", category: "DOMAIN_NOT_VERIFIED" };
    if (/testing|own email|registered to another/.test(text)) return { kind: "PERMANENT", category: "PERMISSION_DENIED" };
    if (/inbox limit/.test(text)) return { kind: "PERMANENT", category: "QUOTA_EXCEEDED" };
    // A 403 without a name is usually the missing User-Agent / edge block.
    return { kind: "PERMANENT", category: "PERMISSION_DENIED" };
  }
  if (code === 404) return { kind: "PERMANENT", category: "NOT_FOUND" };
  if (code === 405) return { kind: "PERMANENT", category: "NOT_SUPPORTED" };
  if (code === 409) {
    // Same key + different body within 24 h: an earlier request may already
    // have been sent, so the outcome is unknown and must be reconciled.
    if (errorName === "invalid_idempotent_request") return { kind: "IDEMPOTENCY_CONFLICT", category: "OUTCOME_UNKNOWN" };
    // concurrent_idempotent_requests / resource_locked: retry later (the same
    // key returns the original result once the first request finishes).
    return { kind: "RETRYABLE", category: "CONFLICT" };
  }
  if (code === 422) {
    if (/recipient|\bto\b|email address|invalid.*email|`to`/.test(text)) return { kind: "PERMANENT", category: "INVALID_RECIPIENT" };
    return { kind: "PERMANENT", category: "VALIDATION_FAILED" };
  }
  if (code === 429) {
    if (errorName === "daily_quota_exceeded" || errorName === "monthly_quota_exceeded") return { kind: "RETRYABLE", category: "QUOTA_EXCEEDED" };
    return { kind: "RETRYABLE", category: "RATE_LIMITED" };
  }
  if (code >= 500) return { kind: "RETRYABLE", category: "PROVIDER_UNAVAILABLE" };
  return { kind: "PERMANENT", category: "VALIDATION_FAILED" };
}

// Backwards-compatible kind-only classifier (existing callers/tests).
function classifyStatus(status, name = "", message = "") {
  return classifyResendResponse(status, name, message).kind;
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : null;
}

function intOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

// Documented headers: ratelimit-limit, ratelimit-remaining, ratelimit-reset
// (seconds), retry-after (seconds). Missing values stay null (never invented).
function rateLimitFromHeaders(headers) {
  const info = {
    limit: intOrNull(readHeader(headers, "ratelimit-limit")),
    remaining: intOrNull(readHeader(headers, "ratelimit-remaining")),
    resetSeconds: intOrNull(readHeader(headers, "ratelimit-reset")),
    retryAfterSeconds: intOrNull(readHeader(headers, "retry-after")),
  };
  return Object.values(info).some((value) => value != null) ? info : null;
}

function resendHttpError(response, payload, { operation = null } = {}) {
  const name = String(payload?.name || "");
  const message = String(payload?.message || name || `Resend returned ${response.status}`).slice(0, 300);
  const { kind, category } = classifyResendResponse(response.status, name, message);
  const rateLimit = rateLimitFromHeaders(response.headers);
  return new MailProviderError(kind, kind === "IDEMPOTENCY_CONFLICT" ? "RESEND_IDEMPOTENCY_CONFLICT" : `RESEND_HTTP_${response.status}`, message, {
    status: response.status,
    retryAfterSeconds: rateLimit?.retryAfterSeconds ?? null,
    category,
    providerErrorName: name || null,
    rateLimit,
    operation,
    provider: "resend",
  });
}

// Transport failure (no HTTP response). A write that did not complete may
// still have been accepted, so it is OUTCOME_UNKNOWN; a read is retryable.
function resendTransportError(error, { phase = "read", operation = null } = {}) {
  const timeout = error?.name === "AbortError" || error?.name === "TimeoutError";
  const write = phase === "write";
  return new MailProviderError(write ? "AMBIGUOUS" : "RETRYABLE", timeout ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR", "Resend request did not complete", {
    category: write ? "OUTCOME_UNKNOWN" : timeout ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
    operation,
    provider: "resend",
  });
}

module.exports = { classifyResendResponse, classifyStatus, rateLimitFromHeaders, resendHttpError, resendTransportError };
