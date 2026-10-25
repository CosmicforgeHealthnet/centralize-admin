"use strict";

// Private storage for mail bodies, attachments and (optionally) raw MIME.
// Content is AES-256-GCM encrypted before it reaches the backend and the
// SHA-256 of the plaintext is verified on every read. There is no public URL:
// downloads are streamed through authorized API endpoints only. When storage
// or the keyring is not configured every operation fails closed.

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { sha256Hex } = require("../security/mail-encryption.service");

const SAFE_KEY = /^[a-z0-9][a-z0-9/_-]{8,500}$/;

class MailStorageUnavailableError extends Error {
  constructor(message = "Private mail storage is unavailable") {
    super(message);
    this.code = "MAIL_STORAGE_UNAVAILABLE";
  }
}

class MailStorageIntegrityError extends Error {
  constructor() {
    super("Stored mail content failed integrity verification");
    this.code = "MAIL_STORAGE_INTEGRITY";
  }
}

function newObjectKey(kind) {
  const id = crypto.randomUUID().replace(/-/g, "");
  return `${kind}/${id.slice(0, 2)}/${id}`;
}

function assertKey(key) {
  if (!SAFE_KEY.test(String(key)) || String(key).includes("..")) throw new Error("Unsafe mail storage key");
  return String(key);
}

function createEncryptedStore({ encryption, backend }) {
  if (!encryption || !backend) return createUnavailableStorage("Mail encryption keyring or storage backend not configured");
  // The keyring may become available later (KMS unwrap at startup) or never;
  // every operation re-checks it and fails closed meanwhile.
  const requireKeyring = () => {
    if (!encryption.available) throw new MailStorageUnavailableError("Mail encryption keyring is not available");
  };
  return {
    get available() {
      return Boolean(encryption.available);
    },
    name: backend.name,
    backend,
    async put(kind, plaintext, { purpose }) {
      requireKeyring();
      const buffer = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext ?? ""), "utf8");
      const key = newObjectKey(kind);
      const sha256 = sha256Hex(buffer);
      await backend.write(assertKey(key), encryption.encrypt(buffer, `${purpose}:${key}`));
      return { key, sha256, sizeBytes: buffer.length };
    },
    async get(key, { purpose, sha256 } = {}) {
      requireKeyring();
      const envelope = await backend.read(assertKey(key));
      let plaintext;
      try {
        plaintext = encryption.decrypt(envelope, `${purpose}:${key}`);
      } catch {
        throw new MailStorageIntegrityError();
      }
      if (sha256 && sha256Hex(plaintext) !== sha256) throw new MailStorageIntegrityError();
      return plaintext;
    },
    async remove(key) {
      await backend.remove(assertKey(key));
    },
    async health() {
      if (!encryption.available) return { ok: false, detail: encryption.loadError ? `keyring-${encryption.loadError.toLowerCase()}` : "keyring-unavailable" };
      return backend.health();
    },
    // Re-encrypts one stored object under the active key (rotation). The
    // object key is part of the AAD, so a rewrapped copy is written in place
    // through the backend's explicit replace() (normal writes never overwrite).
    async reencrypt(key, { purpose }) {
      requireKeyring();
      const envelope = await backend.read(assertKey(key));
      const version = encryption.envelopeKeyVersion(envelope);
      if (version === encryption.activeVersion) return { key, changed: false, from: version };
      let plaintext;
      try {
        plaintext = encryption.decrypt(envelope, `${purpose}:${key}`);
      } catch {
        throw new MailStorageIntegrityError();
      }
      await backend.replace(assertKey(key), encryption.encrypt(plaintext, `${purpose}:${key}`));
      return { key, changed: true, from: version, to: encryption.activeVersion };
    },
    async keyVersionOf(key) {
      return encryption.envelopeKeyVersion(await backend.read(assertKey(key)));
    },
  };
}

function filesystemBackend(directory) {
  const root = path.resolve(directory);
  const resolve = (key) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(`${root}${path.sep}`)) throw new Error("Unsafe mail storage path");
    return full;
  };
  return {
    name: "encrypted-filesystem",
    async write(key, data) {
      const full = resolve(key);
      await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      await fs.writeFile(full, data, { mode: 0o600, flag: "wx" });
    },
    async replace(key, data) {
      const full = resolve(key);
      const temporary = `${full}.rotate-${crypto.randomUUID()}`;
      await fs.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, full);
    },
    async read(key) {
      try {
        return await fs.readFile(resolve(key));
      } catch (error) {
        if (error.code === "ENOENT") throw new MailStorageIntegrityError();
        throw new MailStorageUnavailableError();
      }
    },
    async remove(key) {
      await fs.rm(resolve(key), { force: true });
    },
    async health() {
      try {
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        await fs.access(root, fs.constants?.W_OK);
        return { ok: true, detail: "writable" };
      } catch {
        return { ok: false, detail: "not-writable" };
      }
    },
  };
}

function memoryBackend() {
  const objects = new Map();
  return {
    name: "memory",
    objects,
    async write(key, data) {
      if (objects.has(key)) throw new Error("exists");
      objects.set(key, Buffer.from(data));
    },
    async replace(key, data) {
      if (!objects.has(key)) throw new MailStorageIntegrityError();
      objects.set(key, Buffer.from(data));
    },
    async read(key) {
      if (!objects.has(key)) throw new MailStorageIntegrityError();
      return Buffer.from(objects.get(key));
    },
    async remove(key) {
      objects.delete(key);
    },
    async health() {
      return { ok: true, detail: "memory" };
    },
  };
}

function createUnavailableStorage(reason) {
  const fail = async () => {
    throw new MailStorageUnavailableError(reason);
  };
  return { available: false, name: "unavailable", put: fail, get: fail, remove: fail, health: async () => ({ ok: false, detail: reason }) };
}

function createMailStorage({ config, encryption, backend, logger } = {}) {
  if (backend) return createEncryptedStore({ encryption, backend });
  const violations = require("../mail.config").infrastructureViolations(config);
  if (violations.length) {
    if (config.enabled) logger?.error?.(`[MailStorage] refusing storage configuration: ${violations.join("; ")}`);
    return createUnavailableStorage(`Mail infrastructure configuration refused: ${violations[0]}`);
  }
  if (config.storage.provider === "s3") {
    const { s3Backend, s3Configured } = require("./s3-backend");
    if (!s3Configured(config.storage.s3)) return createUnavailableStorage("MAIL_S3_* is not fully configured");
    return createEncryptedStore({ encryption, backend: s3Backend(config.storage.s3, { logger }) });
  }
  if (config.storage.provider === "filesystem" && config.storage.localDirectory) {
    return createEncryptedStore({ encryption, backend: filesystemBackend(config.storage.localDirectory) });
  }
  if (config.storage.provider === "memory" && process.env.NODE_ENV !== "production") {
    return createEncryptedStore({ encryption, backend: memoryBackend() });
  }
  return createUnavailableStorage("MAIL_STORAGE_PROVIDER is not configured");
}

module.exports = {
  createMailStorage,
  createEncryptedStore,
  filesystemBackend,
  memoryBackend,
  createUnavailableStorage,
  MailStorageUnavailableError,
  MailStorageIntegrityError,
};
