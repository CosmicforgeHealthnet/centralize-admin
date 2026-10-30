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

// Encrypted filesystem backend (self-hosted production default on Contabo).
// Objects are AES-256-GCM envelopes (never plaintext), written once ("wx"),
// fsynced together with their directory so an acknowledged write survives a
// crash or power loss, and replaced only atomically by key rotation.
//
// Options (staging/production set them from config):
//   environment   - binds the store to one deployment through a marker file
//                   (.cosmicforge-mail-store.json); a store created for another
//                   environment is refused (fail closed).
//   requireMount  - the directory must be its own mounted volume (not the
//                   container's writable layer), so recreating the container
//                   or deploying a new image can never lose mail.
//   minFreeBytes  - writes are refused and health fails below this free space.
const STORE_MARKER = ".cosmicforge-mail-store.json";
const STORE_FORMAT = "cosmicforge-mail-store/1";

async function syncPath(target) {
  let handle;
  try {
    handle = await fs.open(target, "r");
    await handle.sync();
  } catch {
    // Some filesystems refuse fsync on directories; the file itself was synced.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeSynced(full, data) {
  const handle = await fs.open(full, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function filesystemBackend(directory, { environment = null, requireMount = false, minFreeBytes = 0, fsImpl = fs } = {}) {
  const root = path.resolve(directory);
  const resolve = (key) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(`${root}${path.sep}`)) throw new Error("Unsafe mail storage path");
    return full;
  };
  let verified = null; // cached result of the environment/mount checks

  async function freeBytes() {
    if (typeof fsImpl.statfs !== "function") return null;
    const stats = await fsImpl.statfs(root);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  // Environment binding and volume checks; cached once they pass.
  async function verify() {
    if (verified?.ok) return verified;
    try {
      await fsImpl.mkdir(root, { recursive: true, mode: 0o700 });
      if (requireMount) {
        const [own, parent] = await Promise.all([fsImpl.stat(root), fsImpl.stat(path.dirname(root))]);
        if (own.dev === parent.dev) return (verified = { ok: false, detail: "not-a-mounted-volume" });
      }
      if (environment) {
        const markerPath = path.join(root, STORE_MARKER);
        let marker = null;
        try {
          marker = JSON.parse(await fsImpl.readFile(markerPath, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") return (verified = { ok: false, detail: "store-marker-unreadable" });
        }
        if (marker && (marker.format !== STORE_FORMAT || marker.environment !== environment)) return (verified = { ok: false, detail: "store-belongs-to-another-environment" });
        if (!marker) {
          const temporary = `${markerPath}.${crypto.randomUUID()}`;
          await writeSynced(temporary, JSON.stringify({ format: STORE_FORMAT, environment, createdAt: new Date().toISOString() }));
          // link() fails if another process created the marker first; then re-read it.
          try {
            await fsImpl.link(temporary, markerPath);
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          } finally {
            await fsImpl.rm(temporary, { force: true });
          }
          await syncPath(root);
          verified = null;
          return verify();
        }
      }
      return (verified = { ok: true });
    } catch {
      return (verified = { ok: false, detail: "not-writable" });
    }
  }

  async function guardWrite() {
    const check = await verify();
    if (!check.ok) throw new MailStorageUnavailableError(`Private mail storage refused: ${check.detail}`);
    if (minFreeBytes > 0) {
      const free = await freeBytes().catch(() => null);
      if (free !== null && free < minFreeBytes) throw new MailStorageUnavailableError("Private mail storage is low on space");
    }
  }

  return {
    name: "encrypted-filesystem",
    async write(key, data) {
      await guardWrite();
      const full = resolve(key);
      await fsImpl.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      await writeSynced(full, data);
      await syncPath(path.dirname(full));
    },
    async replace(key, data) {
      await guardWrite();
      const full = resolve(key);
      const temporary = `${full}.rotate-${crypto.randomUUID()}`;
      await writeSynced(temporary, data);
      await fsImpl.rename(temporary, full);
      await syncPath(path.dirname(full));
    },
    async read(key) {
      const check = await verify();
      if (!check.ok) throw new MailStorageUnavailableError(`Private mail storage refused: ${check.detail}`);
      try {
        return await fsImpl.readFile(resolve(key));
      } catch (error) {
        if (error.code === "ENOENT") throw new MailStorageIntegrityError();
        throw new MailStorageUnavailableError();
      }
    },
    async remove(key) {
      const check = await verify();
      if (!check.ok) throw new MailStorageUnavailableError(`Private mail storage refused: ${check.detail}`);
      await fsImpl.rm(resolve(key), { force: true });
    },
    async health() {
      const check = await verify();
      if (!check.ok) return { ok: false, detail: check.detail };
      try {
        await fsImpl.access(root, fs.constants?.W_OK);
      } catch {
        return { ok: false, detail: "not-writable" };
      }
      const free = await freeBytes().catch(() => null);
      if (minFreeBytes > 0 && free !== null && free < minFreeBytes) return { ok: false, detail: "low-space", freeBytes: free };
      return { ok: true, detail: "writable", ...(free !== null ? { freeBytes: free } : {}) };
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
    const strict = ["staging", "production"].includes(config.deploymentEnvironment);
    return createEncryptedStore({
      encryption,
      backend: filesystemBackend(config.storage.localDirectory, {
        environment: strict ? config.deploymentEnvironment : null,
        requireMount: Boolean(config.storage.requireMount),
        minFreeBytes: config.storage.minFreeBytes || 0,
      }),
    });
  }
  if (config.storage.provider === "memory" && process.env.NODE_ENV !== "production") {
    return createEncryptedStore({ encryption, backend: memoryBackend() });
  }
  return createUnavailableStorage("MAIL_STORAGE_PROVIDER is not configured");
}

module.exports = {
  STORE_MARKER,
  createMailStorage,
  createEncryptedStore,
  filesystemBackend,
  memoryBackend,
  createUnavailableStorage,
  MailStorageUnavailableError,
  MailStorageIntegrityError,
};
