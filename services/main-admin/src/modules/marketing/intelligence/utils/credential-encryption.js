const crypto = require("crypto");

// AES-256-GCM credential encryption for advertising platform tokens.
// Stored format: "v1:<iv base64>:<auth tag base64>:<ciphertext base64>"
// Key source: MARKETING_CREDENTIALS_ENCRYPTION_KEY (64 hex chars or 32-byte base64).

const CIPHER_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

class CredentialEncryptionError extends Error {
  constructor(message) {
    super(message);
    this.name = "CredentialEncryptionError";
  }
}

function loadKey() {
  const rawKey = process.env.MARKETING_CREDENTIALS_ENCRYPTION_KEY;

  if (!rawKey || !rawKey.trim()) return null;

  const trimmed = rawKey.trim();

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === KEY_LENGTH) return decoded;

  throw new CredentialEncryptionError(
    "MARKETING_CREDENTIALS_ENCRYPTION_KEY must be 64 hex characters or a base64-encoded 32-byte key",
  );
}

function requireKey() {
  const key = loadKey();

  if (!key) {
    throw new CredentialEncryptionError(
      "MARKETING_CREDENTIALS_ENCRYPTION_KEY is not configured  cannot encrypt or decrypt platform credentials",
    );
  }

  return key;
}

function isEncryptionConfigured() {
  try {
    return loadKey() !== null;
  } catch (error) {
    return false;
  }
}

function encryptCredential(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new CredentialEncryptionError("Cannot encrypt an empty credential");
  }

  const key = requireKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    CIPHER_VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

function decryptCredential(payload) {
  if (typeof payload !== "string" || payload.length === 0) {
    throw new CredentialEncryptionError("Cannot decrypt an empty credential");
  }

  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) {
    throw new CredentialEncryptionError(
      "Stored credential is not in the expected encrypted format",
    );
  }

  const key = requireKey();
  const [, ivB64, tagB64, ciphertextB64] = parts;

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new CredentialEncryptionError(
      "Failed to decrypt stored credential  the encryption key may be wrong or the data corrupted",
    );
  }
}

module.exports = {
  CredentialEncryptionError,
  isEncryptionConfigured,
  encryptCredential,
  decryptCredential,
};
