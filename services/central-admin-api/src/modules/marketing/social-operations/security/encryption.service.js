const crypto = require("crypto");
const {
  resolveSocialEncryptionKeyring,
} = require("./encryption-keyring.service");

const ENVELOPE_VERSION = 1;
const ALGORITHM = "AES-256-GCM";
const WIRE_PREFIX = "cf-social-aead:";

function aadFor({ purpose, keyVersion }) {
  return Buffer.from(
    JSON.stringify({
      alg: ALGORITHM,
      v: ENVELOPE_VERSION,
      keyVersion: String(keyVersion),
      purpose: String(purpose || "SOCIAL_OPERATIONS"),
    }),
  );
}

function parseEnvelope(envelopeBuffer) {
  const text = Buffer.from(envelopeBuffer).toString("utf8");
  if (!text.startsWith(WIRE_PREFIX)) {
    throw new Error("Unsupported Social encrypted envelope");
  }
  const envelope = JSON.parse(text.slice(WIRE_PREFIX.length));
  if (envelope.alg !== ALGORITHM || envelope.v !== ENVELOPE_VERSION) {
    throw new Error("Unsupported Social encrypted envelope");
  }
  return envelope;
}

function encryptBuffer(plaintext, { purpose, keyring } = {}) {
  const resolvedKeyring = resolveSocialEncryptionKeyring({ keyring });
  const keyVersion = resolvedKeyring.activeVersion;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", resolvedKeyring.getActiveKey(), iv);
  cipher.setAAD(aadFor({ purpose, keyVersion }));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext || ""))),
    cipher.final(),
  ]);
  const envelope = {
    alg: ALGORITHM,
    v: ENVELOPE_VERSION,
    keyVersion,
    purpose: String(purpose || "SOCIAL_OPERATIONS"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return Buffer.from(`${WIRE_PREFIX}${JSON.stringify(envelope)}`);
}

function decryptBuffer(envelopeBuffer, { purpose, keyring } = {}) {
  try {
    const envelope = parseEnvelope(envelopeBuffer);
    const resolvedKeyring = resolveSocialEncryptionKeyring({ keyring });
    const key = resolvedKeyring.getKey(envelope.keyVersion);
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    const effectivePurpose = purpose || envelope.purpose;
    if (purpose && purpose !== envelope.purpose) {
      throw new Error("Social encrypted envelope purpose mismatch");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aadFor({ purpose: effectivePurpose, keyVersion: envelope.keyVersion }));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new Error("Social encrypted envelope authentication failed");
  }
}

function encryptJson(value, options = {}) {
  return encryptBuffer(Buffer.from(JSON.stringify(value ?? null)), options);
}

function decryptJson(envelopeBuffer, options = {}) {
  const plaintext = decryptBuffer(envelopeBuffer, options).toString("utf8");
  return plaintext ? JSON.parse(plaintext) : null;
}

function envelopeMetadata(envelopeBuffer) {
  const envelope = parseEnvelope(envelopeBuffer);
  return {
    alg: envelope.alg,
    version: envelope.v,
    keyVersion: envelope.keyVersion,
    purpose: envelope.purpose,
  };
}

module.exports = {
  ALGORITHM,
  ENVELOPE_VERSION,
  WIRE_PREFIX,
  encryptBuffer,
  decryptBuffer,
  encryptJson,
  decryptJson,
  envelopeMetadata,
};
