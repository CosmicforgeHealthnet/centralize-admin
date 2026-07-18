const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  encryptCredential,
  decryptCredential,
  isEncryptionConfigured,
  CredentialEncryptionError,
} = require("../utils/credential-encryption");

const VALID_KEY = crypto.randomBytes(32).toString("hex");

beforeEach(() => {
  process.env.MARKETING_CREDENTIALS_ENCRYPTION_KEY = VALID_KEY;
});

test("encrypts and decrypts a credential round-trip", () => {
  const encrypted = encryptCredential("super-secret-token");
  assert.notEqual(encrypted, "super-secret-token");
  assert.ok(encrypted.startsWith("v1:"));
  assert.equal(decryptCredential(encrypted), "super-secret-token");
});

test("uses a random IV for every encryption", () => {
  const first = encryptCredential("same-token");
  const second = encryptCredential("same-token");
  assert.notEqual(first, second);
});

test("fails clearly when the key is missing", () => {
  delete process.env.MARKETING_CREDENTIALS_ENCRYPTION_KEY;
  assert.equal(isEncryptionConfigured(), false);
  assert.throws(() => encryptCredential("token"), CredentialEncryptionError);
  assert.throws(() => decryptCredential("v1:a:b:c"), CredentialEncryptionError);
});

test("rejects malformed key material", () => {
  process.env.MARKETING_CREDENTIALS_ENCRYPTION_KEY = "too-short";
  assert.throws(() => encryptCredential("token"), CredentialEncryptionError);
});

test("accepts a base64 32-byte key", () => {
  process.env.MARKETING_CREDENTIALS_ENCRYPTION_KEY = crypto
    .randomBytes(32)
    .toString("base64");
  const encrypted = encryptCredential("token");
  assert.equal(decryptCredential(encrypted), "token");
});

test("detects tampered ciphertext", () => {
  const encrypted = encryptCredential("token");
  const parts = encrypted.split(":");
  parts[3] = Buffer.from("tampered-data").toString("base64");
  assert.throws(() => decryptCredential(parts.join(":")), CredentialEncryptionError);
});

test("rejects plaintext-looking values on decrypt", () => {
  assert.throws(() => decryptCredential("raw-plaintext-token"), CredentialEncryptionError);
});
