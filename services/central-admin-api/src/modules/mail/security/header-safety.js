"use strict";

// Header-injection defences for any value that can reach an RFC 5322 header.

const CRLF = /[\r\n\u0000]/;

function assertHeaderSafe(value, field = "header") {
  if (value == null) return value;
  const text = String(value);
  if (CRLF.test(text)) {
    const error = new Error(`Unsafe header value for ${field}`);
    error.code = "MAIL_HEADER_INJECTION";
    throw error;
  }
  return text;
}

function sanitizeSubject(value) {
  return String(value ?? "")
    .replace(/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 998);
}

function normalizeSubject(subject) {
  let value = sanitizeSubject(subject).toLowerCase();
  let previous;
  do {
    previous = value;
    value = value.replace(/^\s*(re|fw|fwd|aw|wg|sv|antw)\s*(\[\d+\])?\s*:\s*/i, "");
  } while (value !== previous);
  return value.replace(/\s+/g, " ").trim();
}

const MESSAGE_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;

function normalizeMessageId(value) {
  if (!value) return null;
  const text = String(value).trim();
  const candidate = text.startsWith("<") ? text : `<${text}>`;
  return MESSAGE_ID.test(candidate) && candidate.length <= 998 ? candidate : null;
}

function parseReferences(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(" ") : String(value);
  const ids = raw.match(/<[^<>\s]+>/g) || [];
  return [...new Set(ids.map(normalizeMessageId).filter(Boolean))].slice(-50);
}

module.exports = { assertHeaderSafe, sanitizeSubject, normalizeSubject, normalizeMessageId, parseReferences };
