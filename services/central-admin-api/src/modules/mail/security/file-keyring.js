"use strict";

// Self-hosted Mail keyring (MAIL_KMS_PROVIDER=file). No cloud KMS.
//
// The keyring is a JSON file generated ON THE SERVER (never in GitHub, never
// in an environment variable) and mounted read-only into the API and the Mail
// worker:
//
//   {
//     "format": "cosmicforge-mail-keyring/1",
//     "environment": "production",
//     "active": "v1",
//     "keys": { "v1": "<base64 of 32 random bytes>" },
//     "createdAt": "2026-10-29T00:00:00.000Z"
//   }
//
// Rules (fail closed with code MAIL_KMS_CONFIG):
// - the file must be a regular file, not readable or writable by group/other;
// - on staging/production its "environment" must equal the deployment, so a
//   staging keyring can never be mounted into production (or vice versa);
// - every key is exactly 256 bits and the active version is present.
//
// Recovery: scripts/mail/keyring.js seals the keyring to an offline recovery
// public key (RSA-OAEP-SHA256 + AES-256-GCM). Only the owner's private key,
// kept off the server, can open the escrow. Key fingerprints (a one-way hash
// of each key) are the only key-derived values ever printed.

const crypto = require("crypto");
const fs = require("fs");

const FORMAT = "cosmicforge-mail-keyring/1";
const ESCROW_FORMAT = "cosmicforge-mail-keyring-escrow/1";
const VERSION_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
const STRICT_ENVIRONMENTS = new Set(["staging", "production"]);
const MIN_RSA_BITS = 3072;

function configError(message) {
  return Object.assign(new Error(message), { code: "MAIL_KMS_CONFIG" });
}

function fingerprint(key) {
  return crypto.createHash("sha256").update("cosmicforge-mail-key-fingerprint:v1:").update(key).digest("hex").slice(0, 16);
}

// Validates a parsed keyring document and returns { keys: Map, active, environment }.
function validateKeyringDocument(document, { environment } = {}) {
  if (!document || typeof document !== "object" || document.format !== FORMAT) throw configError("Mail keyring file has an unsupported format");
  const declared = String(document.environment || "").toLowerCase();
  if (!declared) throw configError("Mail keyring file does not declare its environment");
  if (environment && STRICT_ENVIRONMENTS.has(environment) && declared !== environment) {
    throw configError(`Mail keyring belongs to ${declared}, not ${environment}`);
  }
  const keys = new Map();
  for (const [version, value] of Object.entries(document.keys || {})) {
    if (!VERSION_PATTERN.test(version)) throw configError(`Mail keyring version ${JSON.stringify(version)} is invalid`);
    const key = Buffer.from(String(value || ""), "base64");
    if (key.length !== 32 || key.toString("base64") !== String(value)) throw configError(`Mail key ${version} is not a 256-bit base64 key`);
    keys.set(version, key);
  }
  if (!keys.size) throw configError("Mail keyring file holds no keys");
  const active = String(document.active || "");
  if (!keys.has(active)) throw configError(`Active Mail key ${active || "(none)"} is not in the keyring`);
  return { keys, active, environment: declared };
}

// Reads the keyring file. `strictPermissions` refuses group/other access.
function readKeyringFile(file, { environment, strictPermissions = true, fsImpl = fs } = {}) {
  if (!file || !String(file).startsWith("/")) throw configError("MAIL_ENCRYPTION_KEYRING_FILE must be an absolute path");
  let stat;
  try {
    stat = fsImpl.statSync(file);
  } catch (error) {
    throw configError(error.code === "ENOENT" ? "Mail keyring file is missing" : "Mail keyring file is not readable");
  }
  if (!stat.isFile()) throw configError("Mail keyring path is not a regular file");
  if (strictPermissions && (stat.mode & 0o077) !== 0) throw configError("Mail keyring file is accessible to group/other (must be 0400 or 0600)");
  let document;
  try {
    document = JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch {
    throw configError("Mail keyring file is not valid JSON");
  }
  return validateKeyringDocument(document, { environment });
}

function newKeyringDocument({ environment, version = "v1", now = new Date() }) {
  if (!["development", "test", "staging", "production"].includes(environment)) throw configError("environment must be development, test, staging or production");
  return { format: FORMAT, environment, active: version, keys: { [version]: crypto.randomBytes(32).toString("base64") }, createdAt: now.toISOString() };
}

function nextVersion(document) {
  const numbers = Object.keys(document.keys || {}).map((v) => /^v(\d+)$/.exec(v)).filter(Boolean).map((m) => Number(m[1]));
  return `v${(numbers.length ? Math.max(...numbers) : 0) + 1}`;
}

function describeKeyring(document) {
  const { keys, active, environment } = validateKeyringDocument(document);
  return { environment, active, versions: [...keys.entries()].map(([version, key]) => ({ version, fingerprint: fingerprint(key) })) };
}

// Escrow: seal the whole keyring document to an RSA public key.
function sealKeyring(document, recipientPublicKeyPem) {
  const description = describeKeyring(document);
  const publicKey = crypto.createPublicKey(recipientPublicKeyPem);
  if (publicKey.asymmetricKeyType !== "rsa") throw configError("The recovery key must be an RSA public key");
  const bits = publicKey.asymmetricKeyDetails?.modulusLength || 0;
  if (bits < MIN_RSA_BITS) throw configError(`The recovery key must be RSA with at least ${MIN_RSA_BITS} bits`);
  const contentKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const header = { format: ESCROW_FORMAT, environment: description.environment, active: description.active, versions: description.versions, recipient: recipientFingerprint(publicKey) };
  const cipher = crypto.createCipheriv("aes-256-gcm", contentKey, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(document))), cipher.final()]);
  const wrappedKey = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, contentKey);
  return { ...header, wrappedKey: wrappedKey.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: body.toString("base64") };
}

function openEscrow(escrow, privateKeyPem) {
  if (!escrow || escrow.format !== ESCROW_FORMAT) throw configError("Not a Mail keyring escrow");
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const contentKey = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(escrow.wrappedKey, "base64"));
  const header = { format: escrow.format, environment: escrow.environment, active: escrow.active, versions: escrow.versions, recipient: escrow.recipient };
  const decipher = crypto.createDecipheriv("aes-256-gcm", contentKey, Buffer.from(escrow.iv, "base64"));
  decipher.setAAD(Buffer.from(JSON.stringify(header)));
  decipher.setAuthTag(Buffer.from(escrow.tag, "base64"));
  const document = JSON.parse(Buffer.concat([decipher.update(Buffer.from(escrow.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  const description = describeKeyring(document);
  if (JSON.stringify(description.versions) !== JSON.stringify(escrow.versions)) throw configError("Escrow header does not match its content");
  return document;
}

// Compares an escrow with a keyring without any private key: same environment,
// same active version, same versions and fingerprints.
function escrowMatches(escrow, document) {
  const description = describeKeyring(document);
  return Boolean(escrow && escrow.format === ESCROW_FORMAT && escrow.environment === description.environment && escrow.active === description.active && JSON.stringify(escrow.versions) === JSON.stringify(description.versions));
}

function recipientFingerprint(publicKey) {
  return crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}

module.exports = {
  FORMAT,
  ESCROW_FORMAT,
  MIN_RSA_BITS,
  fingerprint,
  validateKeyringDocument,
  readKeyringFile,
  newKeyringDocument,
  nextVersion,
  describeKeyring,
  sealKeyring,
  openEscrow,
  escrowMatches,
  recipientFingerprint,
};
