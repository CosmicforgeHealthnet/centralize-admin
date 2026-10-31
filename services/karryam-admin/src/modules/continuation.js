"use strict";

// Opaque continuation tokens for bounded list reads. The token is sealed
// with AES-256-GCM under a key derived from the operator-provided cursor key
// (its own trust boundary), so the Bridge cursor is never exposed, and it is
// bound to the staff member, capability, collection, exact scope, filters
// and the first page's source observation. Any mismatch, tamper or expiry
// is rejected; tokens never widen scope.

const { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } = require("node:crypto");

const VERSION = 1;
const TTL_MS = 15 * 60 * 1000;
const AAD = Buffer.from("karryam-admin.continuation.v1");
const TOKEN = /^[A-Za-z0-9_-]{16,2048}$/;
const MAX_BRIDGE_CURSOR = 1024;

class ContinuationError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "ContinuationError";
    this.reason = reason;
  }
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 32);
}

function createContinuation(cursorKey, { now = Date.now } = {}) {
  if (!Buffer.isBuffer(cursorKey) || cursorKey.length < 32) throw new Error("cursor_key_required");
  const key = Buffer.from(hkdfSync("sha256", cursorKey, Buffer.alloc(0), Buffer.from("karryam-admin continuation tokens"), 32));

  // binding: { staff, capability, collection, scope, filters }
  // window: the first page's exact time window, carried sealed so later
  // pages read the same window even when the caller relied on defaults.
  function seal(binding, bridgeCursor, snapshotAsOf, window = null) {
    if (typeof bridgeCursor !== "string" || bridgeCursor.length === 0 || bridgeCursor.length > MAX_BRIDGE_CURSOR) throw new ContinuationError("SOURCE_CURSOR_UNSUPPORTED");
    const plain = Buffer.from(JSON.stringify({ v: VERSION, b: digest(binding), c: bridgeCursor, s: snapshotAsOf || null, w: window, e: now() + TTL_MS }));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
  }

  function open(token, binding) {
    if (typeof token !== "string" || !TOKEN.test(token)) throw new ContinuationError("CONTINUATION_INVALID");
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 12 + 16 + 2) throw new ContinuationError("CONTINUATION_INVALID");
    let parsed;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAAD(AAD);
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      parsed = JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8"));
    } catch {
      throw new ContinuationError("CONTINUATION_INVALID");
    }
    if (!parsed || parsed.v !== VERSION || typeof parsed.c !== "string") throw new ContinuationError("CONTINUATION_INVALID");
    if (!Number.isFinite(parsed.e) || parsed.e <= now()) throw new ContinuationError("CONTINUATION_EXPIRED");
    if (parsed.b !== digest(binding)) throw new ContinuationError("CONTINUATION_BINDING_MISMATCH");
    return { bridgeCursor: parsed.c, snapshotAsOf: parsed.s, window: parsed.w || null };
  }

  return Object.freeze({ seal, open });
}

module.exports = { createContinuation, ContinuationError, TTL_MS };
