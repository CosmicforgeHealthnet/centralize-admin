"use strict";

// Structured JSON logging with redaction (same rules as Karryam Admin):
// sensitive keys are replaced, and credentials embedded in strings
// (user:password@ in URIs, bearer/basic values, compact JWS/JWT, PEM) are
// scrubbed. Logging never throws into request handling.

const SENSITIVE = /(token|secret|password|passphrase|authorization|cookie|signature|private|credential|body|headers?|delegation|assertion|key_b64url|^key$)/i;
const URI_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const AUTH_VALUE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const COMPACT_JWS = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const PEM = /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g;

function scrub(text) {
  return text.replace(PEM, "[redacted-pem]").replace(URI_CREDENTIALS, "$1[redacted]@").replace(AUTH_VALUE, "$1 [redacted]").replace(COMPACT_JWS, "[redacted-token]");
}

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") { const clean = scrub(value); return clean.length > 200 ? clean.slice(0, 200) + "..." : clean; }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth > 3) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = SENSITIVE.test(key) ? "[redacted]" : redact(item, depth + 1);
    return out;
  }
  return "[unsupported]";
}

function createLogger({ write = (line) => process.stdout.write(line + "\n"), service = "product-integration-core" } = {}) {
  return function log(entry) {
    try {
      write(JSON.stringify({ service, at: new Date().toISOString(), ...redact(entry) }));
    } catch {
      // Logging must never break request handling.
    }
  };
}

module.exports = { createLogger, redact, scrub };
