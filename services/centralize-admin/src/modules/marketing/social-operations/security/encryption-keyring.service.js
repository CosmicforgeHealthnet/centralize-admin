const crypto = require("crypto");

const KEYRING_ENV_NAMES = Object.freeze([
  "SOCIAL_OPERATIONS_ENCRYPTION_KEYS_JSON",
  "SOCIAL_ENCRYPTION_KEYS_JSON",
]);

const ACTIVE_VERSION_ENV_NAMES = Object.freeze([
  "SOCIAL_OPERATIONS_ENCRYPTION_ACTIVE_VERSION",
  "SOCIAL_ENCRYPTION_ACTIVE_VERSION",
]);

let developmentKeyring = null;

function decodeKeyMaterial(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) throw new Error("Social encryption keys must be 32 bytes");
    return Buffer.from(value);
  }

  const text = String(value || "").trim();
  if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, "hex");

  const decoded = Buffer.from(text, "base64");
  if (decoded.length === 32) return decoded;

  throw new Error("Social encryption keys must be 64 hex characters or base64 32-byte values");
}

function normalizeVersion(version) {
  const normalized = String(version || "").trim();
  if (!normalized) throw new Error("Social encryption key version is required");
  return normalized;
}

function keyEntriesFromConfig(config) {
  if (Array.isArray(config)) {
    return config.map((entry) => [
      normalizeVersion(entry.version || entry.keyVersion || entry.id),
      decodeKeyMaterial(entry.key || entry.value || entry.material),
    ]);
  }

  if (config && typeof config === "object") {
    return Object.entries(config).map(([version, key]) => [
      normalizeVersion(version),
      decodeKeyMaterial(key),
    ]);
  }

  throw new Error("Social encryption keyring must be a JSON object or array");
}

function createKeyring({ keys, activeVersion, ephemeral = false } = {}) {
  const entries = keyEntriesFromConfig(keys);
  const keyMap = new Map(entries);
  if (keyMap.size === 0) throw new Error("Social encryption keyring must contain at least one key");

  const resolvedActiveVersion = normalizeVersion(activeVersion || entries[0][0]);
  if (!keyMap.has(resolvedActiveVersion)) {
    throw new Error("Active Social encryption key version is not present in keyring");
  }

  return Object.freeze({
    activeVersion: resolvedActiveVersion,
    ephemeral,
    getActiveKey() {
      return Buffer.from(keyMap.get(resolvedActiveVersion));
    },
    getKey(version) {
      const normalized = normalizeVersion(version);
      const key = keyMap.get(normalized);
      if (!key) throw new Error("Social encryption key version is unavailable");
      return Buffer.from(key);
    },
    hasVersion(version) {
      return keyMap.has(normalizeVersion(version));
    },
    versions() {
      return [...keyMap.keys()];
    },
  });
}

function envValue(names) {
  return names.map((name) => process.env[name]).find((value) => value);
}

function envKeyringConfig() {
  const configured = envValue(KEYRING_ENV_NAMES);
  if (configured) {
    return {
      keys: JSON.parse(configured),
      activeVersion: envValue(ACTIVE_VERSION_ENV_NAMES),
      ephemeral: false,
    };
  }

  const legacyWebhookKey = process.env.SOCIAL_OPERATIONS_WEBHOOK_ENCRYPTION_KEY;
  if (legacyWebhookKey) {
    return {
      keys: { "1": legacyWebhookKey },
      activeVersion: "1",
      ephemeral: false,
    };
  }

  return null;
}

function developmentFallbackKeyring() {
  if (!developmentKeyring) {
    developmentKeyring = createKeyring({
      keys: { "dev-local": crypto.randomBytes(32) },
      activeVersion: "dev-local",
      ephemeral: true,
    });
  }
  return developmentKeyring;
}

function resolveSocialEncryptionKeyring({ keyring } = {}) {
  if (keyring) return keyring;

  const config = envKeyringConfig();
  if (config) return createKeyring(config);

  if (process.env.NODE_ENV === "production") {
    throw new Error("Social encryption keyring is required in production");
  }

  return developmentFallbackKeyring();
}

module.exports = {
  createKeyring,
  resolveSocialEncryptionKeyring,
};
