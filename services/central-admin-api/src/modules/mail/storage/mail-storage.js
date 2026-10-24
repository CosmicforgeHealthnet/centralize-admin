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
  if (!encryption?.available || !backend) return createUnavailableStorage("Mail encryption keyring or storage backend not configured");
  return {
    available: true,
    name: backend.name,
    async put(kind, plaintext, { purpose }) {
      const buffer = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext ?? ""), "utf8");
      const key = newObjectKey(kind);
      const sha256 = sha256Hex(buffer);
      await backend.write(assertKey(key), encryption.encrypt(buffer, `${purpose}:${key}`));
      return { key, sha256, sizeBytes: buffer.length };
    },
    async get(key, { purpose, sha256 } = {}) {
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
      return backend.health();
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

function createMailStorage({ config, encryption, backend } = {}) {
  if (backend) return createEncryptedStore({ encryption, backend });
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
