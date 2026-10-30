"use strict";

// Secret material is only ever read from operator-mounted files referenced
// by absolute paths. Values never come from the environment directly, are
// never logged, and are validated before the service starts.

const fs = require("node:fs");
const path = require("node:path");
const { createPrivateKey } = require("node:crypto");

const MAX_SECRET_FILE_BYTES = 64 * 1024;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SERVICE_ID = /^[a-z0-9][a-z0-9.-]{2,63}$/;

class ConfigError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "ConfigError";
    this.reason = reason;
  }
}

function readSecretFile(file, name) {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("..") || file.includes("\0")) {
    throw new ConfigError(name + "_PATH_INVALID");
  }
  let stat;
  try { stat = fs.statSync(file); } catch { throw new ConfigError(name + "_UNREADABLE"); }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SECRET_FILE_BYTES) throw new ConfigError(name + "_INVALID");
  try { return fs.readFileSync(file); } catch { throw new ConfigError(name + "_UNREADABLE"); }
}

function decodeKey(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.trim())) throw new ConfigError(name + "_KEY_ENCODING_INVALID");
  const key = Buffer.from(value.trim(), "base64url");
  if (key.length < 32) throw new ConfigError(name + "_KEY_TOO_SHORT");
  return key;
}

function parseJsonFile(file, name) {
  let parsed;
  try { parsed = JSON.parse(readSecretFile(file, name).toString("utf8")); } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(name + "_JSON_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ConfigError(name + "_JSON_INVALID");
  return parsed;
}

function parseNotAfter(value, name, now) {
  const ms = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(ms)) throw new ConfigError(name + "_EXPIRY_REQUIRED");
  return { iso: new Date(ms).toISOString(), live: ms > now };
}

// { keyId: { service_id, key_b64url, not_after } } -> { keyId: { serviceId, key, notAfter } }
function loadServiceKeys(file, { now = Date.now(), name = "HQ_SERVICE_KEYS" } = {}) {
  const parsed = parseJsonFile(file, name);
  const keys = {};
  let live = 0;
  for (const [keyId, entry] of Object.entries(parsed)) {
    if (!KEY_ID.test(keyId) || !entry || typeof entry !== "object") throw new ConfigError(name + "_ENTRY_INVALID");
    if (!SERVICE_ID.test(String(entry.service_id))) throw new ConfigError(name + "_SERVICE_ID_INVALID");
    const notAfter = parseNotAfter(entry.not_after, name, now);
    if (notAfter.live) live += 1;
    keys[keyId] = Object.freeze({ serviceId: entry.service_id, key: decodeKey(entry.key_b64url, name), notAfter: notAfter.iso, revoked: entry.revoked === true });
  }
  if (live === 0) throw new ConfigError(name + "_NO_LIVE_KEY");
  return Object.freeze(keys);
}

// { kid: { key_b64url, not_after } } -> { kid: { key, notAfter } }
function loadDelegationKeys(file, { now = Date.now(), name = "DELEGATION_KEYS" } = {}) {
  const parsed = parseJsonFile(file, name);
  const keys = {};
  let live = 0;
  for (const [kid, entry] of Object.entries(parsed)) {
    if (!KEY_ID.test(kid) || !entry || typeof entry !== "object") throw new ConfigError(name + "_ENTRY_INVALID");
    const notAfter = parseNotAfter(entry.not_after, name, now);
    if (notAfter.live) live += 1;
    keys[kid] = Object.freeze({ key: decodeKey(entry.key_b64url, name), notAfter: notAfter.iso });
  }
  if (live === 0) throw new ConfigError(name + "_NO_LIVE_KEY");
  return Object.freeze(keys);
}

function loadEd25519PrivateKey(file, name) {
  let key;
  try { key = createPrivateKey(readSecretFile(file, name)); } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(name + "_INVALID");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new ConfigError(name + "_NOT_ED25519");
  return key;
}

function loadBase64UrlKeyFile(file, name) {
  return decodeKey(readSecretFile(file, name).toString("utf8"), name);
}

module.exports = { ConfigError, readSecretFile, loadServiceKeys, loadDelegationKeys, loadEd25519PrivateKey, loadBase64UrlKeyFile, KEY_ID };
