"use strict";

// Strict, fail-closed configuration. Disabled by default: the service starts,
// answers liveness, and refuses every API call until explicitly enabled with
// a complete, valid configuration.

const fs = require("node:fs");
const net = require("node:net");
const { buildEndpoints, buildTrustStore, bindTrustStoreSources } = require("../registry/endpoints");

const ENVIRONMENTS = ["test", "development", "staging", "production"];

class ConfigError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "ConfigError";
    this.reason = reason;
  }
}

function readConfigFile(env, name) {
  const file = env[name];
  if (!file || !file.startsWith("/") || file.includes("..")) throw new ConfigError(name + "_REQUIRED");
  let bytes;
  try { bytes = fs.readFileSync(file); } catch { throw new ConfigError(name + "_UNREADABLE"); }
  try { return { file, bytes, json: JSON.parse(bytes.toString("utf8")) }; } catch { throw new ConfigError(name + "_UNREADABLE"); }
}

function readJsonFile(env, name) {
  return readConfigFile(env, name).json;
}

function isPrivateBind(host) {
  if (!net.isIP(host) || host === "0.0.0.0" || host === "::") return false;
  if (net.isIPv4(host)) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return host === "::1" || /^f[cd][0-9a-f]{2}:/i.test(host);
}

function parseListen(value) {
  const spec = value || "unix:/run/cosmicforge/product-integration-core.sock";
  if (spec.startsWith("unix:")) {
    const path = spec.slice(5);
    if (!path.startsWith("/") || path.includes("..") || path.length > 100) throw new ConfigError("PIC_LISTEN_INVALID");
    return { kind: "unix", path };
  }
  const match = /^tcp:(\[[0-9a-f:]+\]|[0-9.]+):(\d{2,5})$/i.exec(spec);
  if (!match) throw new ConfigError("PIC_LISTEN_INVALID");
  const host = match[1].replace(/^\[|\]$/g, "");
  if (!isPrivateBind(host)) throw new ConfigError("PIC_LISTEN_NOT_PRIVATE");
  // A non-loopback listener is a later infrastructure step that requires TLS
  // 1.3 mTLS termination; this phase only allows loopback TCP.
  if (!(host.startsWith("127.") || host === "::1")) throw new ConfigError("PIC_LISTEN_REMOTE_REQUIRES_MTLS");
  return { kind: "tcp", host, port: Number(match[2]) };
}

function loadConfig(env = process.env) {
  const enabled = env.PIC_ENABLED === "true";
  const listen = parseListen(env.PIC_LISTEN);
  if (!enabled) return { enabled: false, listen };

  const environment = env.PIC_ENVIRONMENT;
  if (!ENVIRONMENTS.includes(environment)) throw new ConfigError("PIC_ENVIRONMENT_REQUIRED");
  if (!env.PIC_DATABASE_URL) throw new ConfigError("PIC_DATABASE_URL_REQUIRED");
  if (env.PIC_MIGRATION_DATABASE_URL && env.PIC_MIGRATION_DATABASE_URL === env.PIC_DATABASE_URL) throw new ConfigError("RUNTIME_AND_MIGRATION_CREDENTIALS_MUST_DIFFER");
  const allowInsecureLoopback = env.PIC_ALLOW_INSECURE_LOOPBACK === "true";
  if (allowInsecureLoopback && !["test", "development"].includes(environment)) throw new ConfigError("INSECURE_LOOPBACK_FORBIDDEN_IN_" + environment.toUpperCase());

  const endpoints = buildEndpoints(readJsonFile(env, "PIC_ENDPOINTS_FILE"), { environment, allowInsecureLoopback });
  // The trust store is bound to the exact bytes it was built from: if the
  // operator changes it (revocation, rotation), this process fails closed
  // until it is restarted with the new trust (see bindTrustStoreSources).
  const trustSource = readConfigFile(env, "PIC_TRUSTED_SIGNERS_FILE");
  const trustSources = [{ file: trustSource.file, bytes: trustSource.bytes }];
  let trustStore;
  try { trustStore = buildTrustStore(trustSource.json, { environment, sources: trustSources }); } catch (err) { throw new ConfigError(err.reason || "PIC_TRUSTED_SIGNERS_FILE_INVALID"); }
  const recheck = Number(env.PIC_TRUST_STORE_RECHECK_SECONDS || 5);
  if (!Number.isInteger(recheck) || recheck < 1 || recheck > 60) throw new ConfigError("PIC_TRUST_STORE_RECHECK_INVALID");
  bindTrustStoreSources(trustStore, trustSources, { recheckMs: recheck * 1000 });
  const hqKeysJson = readJsonFile(env, "PIC_HQ_DELEGATION_KEYS_FILE");
  const hqDelegationKeys = {};
  for (const [kid, entry] of Object.entries(hqKeysJson.keys || {})) {
    const key = Buffer.from(String(entry.key_b64url || ""), "base64url");
    if (key.length < 32) throw new ConfigError("HQ_DELEGATION_KEY_TOO_SHORT");
    if (!entry.not_after || !(Date.parse(entry.not_after) > Date.now())) throw new ConfigError("HQ_DELEGATION_KEY_EXPIRY_REQUIRED");
    hqDelegationKeys[kid] = { key, notAfter: entry.not_after };
  }
  if (Object.keys(hqDelegationKeys).length === 0) throw new ConfigError("HQ_DELEGATION_KEYS_REQUIRED");
  for (const endpoint of endpoints.values()) {
    for (const hq of Object.values(hqDelegationKeys)) {
      if (hq.key.equals(endpoint.auth.key) || hq.key.equals(endpoint.delegation.key)) throw new ConfigError("KEY_REUSE_ACROSS_BOUNDARIES");
    }
  }

  const syncEnabled = env.PIC_SYNC_ENABLED === "true";
  const interval = Number(env.PIC_SYNC_INTERVAL_SECONDS || 60);
  const lease = Number(env.PIC_SYNC_LEASE_SECONDS || 30);
  if (!Number.isInteger(interval) || interval < 5 || interval > 3600) throw new ConfigError("PIC_SYNC_INTERVAL_INVALID");
  if (!Number.isInteger(lease) || lease < 5 || lease > 600) throw new ConfigError("PIC_SYNC_LEASE_INVALID");
  const workerId = env.PIC_WORKER_ID || null;
  if (workerId !== null && !/^[a-z0-9][a-z0-9.-]{2,63}$/.test(workerId)) throw new ConfigError("PIC_WORKER_ID_INVALID");

  return {
    enabled: true, listen, environment, databaseUrl: env.PIC_DATABASE_URL, endpoints, trustStore, hqDelegationKeys,
    sync: { enabled: syncEnabled, intervalSeconds: interval, leaseSeconds: lease, workerId },
    allowInsecureLoopback,
  };
}

module.exports = { loadConfig, parseListen, ConfigError };
