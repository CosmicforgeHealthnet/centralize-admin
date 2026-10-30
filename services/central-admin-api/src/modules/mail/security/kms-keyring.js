"use strict";

// KMS-managed Mail keyring.
//
// MAIL_KMS_PROVIDER=env      -> MAIL_ENCRYPTION_KEYS holds raw base64 32-byte
//                               keys ("v1:<base64>"). Development/staging only.
// MAIL_KMS_PROVIDER=aws-kms  -> MAIL_ENCRYPTION_KEYS holds KMS-wrapped data keys
//                               ("v2:kms:<base64 CiphertextBlob>"). They are
//                               unwrapped once at startup with KMS Decrypt,
//                               bound to an encryption context, kept in memory
//                               only and never logged or returned by the API.
//
// The AES-256-GCM wire format of mail-encryption.service.js is unchanged, so
// envelopes written under older key versions keep decrypting after rotation as
// long as their key version stays in the keyring.

const { signRequest } = require("./aws-sigv4");

const VERSION_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
const CONTEXT_PURPOSE = "cosmicforge-mail-keyring";

function encryptionContext({ environment, version }) {
  return { purpose: CONTEXT_PURPOSE, environment: String(environment || "development"), keyVersion: String(version) };
}

function parseKeyringEntries(value) {
  const entries = [];
  for (const raw of String(value || "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const separator = raw.indexOf(":");
    if (separator <= 0) continue;
    const version = raw.slice(0, separator).trim();
    const rest = raw.slice(separator + 1).trim();
    if (!VERSION_PATTERN.test(version)) continue;
    if (rest.startsWith("kms:")) entries.push({ version, wrapped: Buffer.from(rest.slice(4), "base64") });
    else entries.push({ version, raw: Buffer.from(rest, "base64") });
  }
  return entries;
}

function createAwsKmsClient({ region, endpoint, credentials, keyId, timeoutMs = 5000, fetchImpl = globalThis.fetch, clock = () => new Date() }) {
  const url = String(endpoint || `https://kms.${region}.amazonaws.com`).replace(/\/+$/, "") + "/";

  async function call(target, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    const signed = signRequest({
      method: "POST",
      url,
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `TrentService.${target}` },
      body,
      region,
      service: "kms",
      credentials,
      now: clock(),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { method: "POST", headers: signed.headers, body, signal: controller.signal, redirect: "error" });
    } catch (error) {
      const failure = new Error(error.name === "AbortError" ? "KMS request timed out" : "KMS request failed");
      failure.code = "MAIL_KMS_UNAVAILABLE";
      throw failure;
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) {
      let type = "";
      try {
        type = String(JSON.parse(text).__type || "").split("#").pop();
      } catch {
        type = "";
      }
      const failure = new Error(`KMS ${target} failed (${response.status}${type ? ` ${type}` : ""})`);
      failure.code = response.status >= 500 ? "MAIL_KMS_UNAVAILABLE" : "MAIL_KMS_DENIED";
      failure.kmsErrorType = type;
      throw failure;
    }
    return JSON.parse(text || "{}");
  }

  return {
    async decrypt(ciphertext, context) {
      const result = await call("Decrypt", { CiphertextBlob: Buffer.from(ciphertext).toString("base64"), EncryptionContext: context, ...(keyId ? { KeyId: keyId } : {}) });
      return Buffer.from(result.Plaintext, "base64");
    },
    async generateDataKey(context) {
      if (!keyId) throw new Error("MAIL_KMS_KEY_ID is required to generate a data key");
      const result = await call("GenerateDataKey", { KeyId: keyId, KeySpec: "AES_256", EncryptionContext: context });
      return { plaintext: Buffer.from(result.Plaintext, "base64"), ciphertext: Buffer.from(result.CiphertextBlob, "base64"), keyId: result.KeyId };
    },
  };
}

/**
 * Resolves the configured keyring into { keys: Map<version, Buffer>, active }.
 * Throws (fail closed) when any wrapped entry cannot be unwrapped, a raw key is
 * used with aws-kms, or the active version is missing.
 */
async function resolveMailKeyring({ provider = "env", keys, activeKey, environment, kmsClient }) {
  const entries = parseKeyringEntries(keys);
  const resolved = new Map();
  for (const entry of entries) {
    if (entry.raw) {
      if (provider === "aws-kms") throw Object.assign(new Error(`Key ${entry.version} is not KMS-wrapped; raw keys are refused with MAIL_KMS_PROVIDER=aws-kms`), { code: "MAIL_KMS_CONFIG" });
      if (entry.raw.length === 32) resolved.set(entry.version, entry.raw);
      continue;
    }
    if (provider !== "aws-kms" || !kmsClient) throw Object.assign(new Error(`Key ${entry.version} is KMS-wrapped but MAIL_KMS_PROVIDER is not aws-kms`), { code: "MAIL_KMS_CONFIG" });
    const plaintext = await kmsClient.decrypt(entry.wrapped, encryptionContext({ environment, version: entry.version }));
    if (plaintext.length !== 32) throw Object.assign(new Error(`Unwrapped key ${entry.version} is not 256-bit`), { code: "MAIL_KMS_CONFIG" });
    resolved.set(entry.version, plaintext);
  }
  if (!resolved.size) return { keys: resolved, active: null };
  if (activeKey && !resolved.has(activeKey)) throw Object.assign(new Error(`Active key ${activeKey} is not in the keyring`), { code: "MAIL_KMS_CONFIG" });
  return { keys: resolved, active: activeKey || [...resolved.keys()].pop() };
}

module.exports = { resolveMailKeyring, createAwsKmsClient, parseKeyringEntries, encryptionContext, CONTEXT_PURPOSE };
