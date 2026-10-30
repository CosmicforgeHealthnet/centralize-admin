"use strict";

// Structured JSON logging with redaction. Request bodies, headers, tokens,
// keys and signatures are never logged; long strings are truncated.

const SENSITIVE = /(token|secret|password|passphrase|authorization|cookie|signature|private|credential|body|headers?|delegation|assertion|key_b64url|^key$)/i;

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 200 ? value.slice(0, 200) + "…" : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 3) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = SENSITIVE.test(key) ? "[redacted]" : redact(item, depth + 1);
    return out;
  }
  return "[unsupported]";
}

function createLogger({ write = (line) => process.stdout.write(line + "\n"), service = "karryam-admin" } = {}) {
  return function log(entry) {
    try {
      write(JSON.stringify({ ts: new Date().toISOString(), service, ...redact(entry) }));
    } catch {
      // Logging must never break request handling.
    }
  };
}

module.exports = { createLogger, redact };
