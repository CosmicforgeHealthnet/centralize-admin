"use strict";

// AES-256-GCM envelope encryption for private mail content (bodies, drafts,
// attachments). Uses a Mail-specific keyring (MAIL_ENCRYPTION_KEYS) so Mail
// keys rotate independently of Social Operations credentials.

const crypto = require("crypto");

const WIRE_PREFIX = Buffer.from("cfmail1:");
const ALGORITHM = "aes-256-gcm";

function parseKeyring(keysValue, activeVersion) {
  const keys = new Map();
  for (const entry of String(keysValue || "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator <= 0) continue;
    const version = entry.slice(0, separator).trim();
    const key = Buffer.from(entry.slice(separator + 1).trim(), "base64");
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(version) || key.length !== 32) continue;
    keys.set(version, key);
  }
  const active = activeVersion && keys.has(activeVersion) ? activeVersion : [...keys.keys()].pop();
  return { keys, active: active || null };
}

// `keyring` may be passed pre-resolved ({ keys: Map, active }) - e.g. data
// keys unwrapped by KMS. `deferred: true` starts unavailable until load() is
// called with a resolved keyring (fail closed while KMS is being contacted).
function createMailEncryption({ keys, activeKey, keyring: resolvedKeyring, deferred = false } = {}) {
  let keyring = resolvedKeyring || (deferred ? { keys: new Map(), active: null } : parseKeyring(keys, activeKey));
  let loadError = null;

  function aad(purpose, version) {
    return Buffer.from(JSON.stringify({ v: 1, purpose: String(purpose), key: version }));
  }

  function requireAvailable() {
    if (!keyring.active) {
      const error = new Error("Mail encryption keyring is not configured");
      error.code = "MAIL_STORAGE_UNAVAILABLE";
      throw error;
    }
  }

  function encrypt(plaintext, purpose) {
    requireAvailable();
    const version = keyring.active;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, keyring.keys.get(version), iv);
    cipher.setAAD(aad(purpose, version));
    const body = Buffer.concat([cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext ?? ""), "utf8")), cipher.final()]);
    const header = Buffer.from(JSON.stringify({ k: version }));
    const headerLength = Buffer.alloc(2);
    headerLength.writeUInt16BE(header.length);
    return Buffer.concat([WIRE_PREFIX, headerLength, header, iv, cipher.getAuthTag(), body]);
  }

  function decrypt(envelope, purpose) {
    requireAvailable();
    const buffer = Buffer.from(envelope);
    if (!buffer.subarray(0, WIRE_PREFIX.length).equals(WIRE_PREFIX)) throw new Error("Unsupported mail envelope");
    let offset = WIRE_PREFIX.length;
    const headerLength = buffer.readUInt16BE(offset);
    offset += 2;
    const header = JSON.parse(buffer.subarray(offset, offset + headerLength).toString("utf8"));
    offset += headerLength;
    const key = keyring.keys.get(header.k);
    if (!key) throw new Error("Mail envelope key version unavailable");
    const iv = buffer.subarray(offset, offset + 12);
    const tag = buffer.subarray(offset + 12, offset + 28);
    const body = buffer.subarray(offset + 28);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(aad(purpose, header.k));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }

  return {
    get available() {
      return Boolean(keyring.active);
    },
    get activeVersion() {
      return keyring.active;
    },
    get versions() {
      return [...keyring.keys.keys()];
    },
    get loadError() {
      return loadError;
    },
    load(next) {
      keyring = { keys: new Map(next.keys), active: next.active };
      loadError = null;
    },
    fail(error) {
      loadError = error ? String(error.code || "MAIL_KMS_ERROR") : null;
    },
    envelopeKeyVersion(envelope) {
      const buffer = Buffer.from(envelope);
      if (!buffer.subarray(0, WIRE_PREFIX.length).equals(WIRE_PREFIX)) return null;
      const headerLength = buffer.readUInt16BE(WIRE_PREFIX.length);
      try {
        return JSON.parse(buffer.subarray(WIRE_PREFIX.length + 2, WIRE_PREFIX.length + 2 + headerLength).toString("utf8")).k || null;
      } catch {
        return null;
      }
    },
    encrypt,
    decrypt,
    encryptJson: (value, purpose) => encrypt(Buffer.from(JSON.stringify(value ?? null)), purpose),
    decryptJson: (value, purpose) => JSON.parse(decrypt(value, purpose).toString("utf8")),
  };
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

module.exports = { createMailEncryption, parseKeyring, sha256Hex };
