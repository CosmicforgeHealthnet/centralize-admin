"use strict";

// Operator-controlled endpoint allowlist and signer trust store.
//
// The registry stores only an `endpoint_ref`. The destination, TLS material,
// service key and per-product delegation key are resolved here from operator
// configuration. Nothing a product sends (manifest, event, response) can add
// or change an entry, and an entry is bound to exactly one product and
// environment so one product's endpoint can never be registered for another.

const fs = require("node:fs");
const { createPublicKey, createHash } = require("node:crypto");
const S = require("../../../../packages/service-clients");

const SERVICE_ID = "hq-product-integration-core";

class EndpointError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "EndpointError";
    this.reason = reason;
  }
}

function readSecret(entry, label) {
  if (entry && typeof entry.key_b64url === "string") return Buffer.from(entry.key_b64url, "base64url");
  if (entry && typeof entry.key_file === "string" && entry.key_file.startsWith("/")) return Buffer.from(fs.readFileSync(entry.key_file, "utf8").trim(), "base64url");
  throw new EndpointError(label + "_KEY_MISSING");
}

function readPem(file, label) {
  if (typeof file !== "string" || !file.startsWith("/")) throw new EndpointError(label + "_FILE_INVALID");
  return fs.readFileSync(file);
}

/**
 * Builds the in-memory endpoint registry from the parsed operator JSON.
 * Returns Map(ref -> { ref, productId, environment, target, auth, delegation, fingerprint256 }).
 */
function buildEndpoints(json, { environment, allowInsecureLoopback = false } = {}) {
  const map = new Map();
  // Keys are symmetric: whoever holds one can sign with it. A key shared by
  // two Product Admin endpoints would let one product sign as HQ to the
  // other, or mint delegations for it, so every key must be unique.
  const seenKeys = [];
  const entries = (json && json.endpoints) || {};
  for (const [ref, raw] of Object.entries(entries)) {
    if (!raw || typeof raw !== "object") throw new EndpointError("ENDPOINT_INVALID");
    if (raw.environment !== environment) continue; // environment isolation
    // Network transports must pin the approved server certificate.
    if (raw.transport === "https" && !(raw.tls && /^[0-9a-f]{64}$/i.test(String(raw.tls.server_fingerprint256 || "").replace(/:/g, "")))) throw new EndpointError("SERVER_FINGERPRINT_PIN_REQUIRED");
    const tls = raw.tls ? {
      ca: raw.tls.ca_pem ? Buffer.from(raw.tls.ca_pem) : readPem(raw.tls.ca_file, "CA"),
      cert: raw.tls.cert_pem ? Buffer.from(raw.tls.cert_pem) : readPem(raw.tls.cert_file, "CERT"),
      key: raw.tls.key_pem ? Buffer.from(raw.tls.key_pem) : readPem(raw.tls.key_file, "KEY"),
      serverFingerprint256: raw.tls.server_fingerprint256 || null,
    } : undefined;
    const target = S.createFixedTarget({ ref, transport: raw.transport, socketPath: raw.socket_path, origin: raw.origin, address: raw.address, serverName: raw.server_name, tls }, { allowInsecureLoopback });
    const serviceKey = readSecret(raw.service_auth, "SERVICE");
    const delegationKey = readSecret(raw.delegation, "DELEGATION");
    if (serviceKey.length < 32 || delegationKey.length < 32) throw new EndpointError("KEY_TOO_SHORT");
    if (serviceKey.equals(delegationKey)) throw new EndpointError("KEY_REUSE");
    if (seenKeys.some((k) => k.equals(serviceKey) || k.equals(delegationKey))) throw new EndpointError("KEY_REUSE_ACROSS_BOUNDARIES");
    seenKeys.push(serviceKey, delegationKey);
    map.set(ref, Object.freeze({
      ref,
      productId: raw.product_id,
      environment: raw.environment,
      target,
      fingerprint256: target.tls && target.tls.serverFingerprint256 ? target.tls.serverFingerprint256 : null,
      auth: Object.freeze({ serviceId: SERVICE_ID, keyId: raw.service_auth.key_id, key: serviceKey }),
      delegation: Object.freeze({ kid: raw.delegation.kid, key: delegationKey }),
    }));
  }
  return map;
}

// `sources` (optional) collects every file read and the exact bytes used, so
// the loaded store can be bound to them (bindTrustStoreSources).
function buildTrustStore(json, { environment, sources = null }) {
  const store = {};
  for (const [kid, raw] of Object.entries((json && json.signers) || {})) {
    if (raw.environment !== environment) continue;
    let pem = raw.public_key_pem || null;
    if (!pem && raw.public_key_file) {
      const bytes = fs.readFileSync(raw.public_key_file);
      if (sources) sources.push({ file: raw.public_key_file, bytes });
      pem = bytes.toString("utf8");
    }
    if (!pem) throw new EndpointError("SIGNER_KEY_MISSING");
    store[kid] = Object.freeze({ publicKey: createPublicKey(pem), productId: raw.product_id, environment: raw.environment, notAfter: raw.not_after, revoked: Boolean(raw.revoked) });
  }
  return store;
}

/**
 * Resolves a product client strictly from the registry row's endpoint_ref.
 * The endpoint must be bound to the same product and environment.
 */
function resolveEndpoint(endpoints, row) {
  const endpoint = endpoints.get(row.endpoint_ref);
  if (!endpoint) throw new EndpointError("ENDPOINT_NOT_ALLOWLISTED");
  if (endpoint.productId !== row.product_id || endpoint.environment !== row.environment) throw new EndpointError("ENDPOINT_PRODUCT_MISMATCH");
  return endpoint;
}

function clientFor(endpoints, row, { timeoutMs = 4000, maxResponseBytes = 1024 * 1024 } = {}) {
  const endpoint = resolveEndpoint(endpoints, row);
  return S.createProductAdminClient({ productId: row.product_id, target: endpoint.target, auth: endpoint.auth, timeoutMs, maxResponseBytes });
}

// Trust-store lifecycle. The trust store is loaded once, at process start,
// and is never reloaded in place. To revoke, expire or rotate a signer the
// operator changes the trust-store file and restarts the service. Until that
// restart the running process must not keep trusting what it loaded:
// isCurrent() re-reads the source files (at most every `recheckMs`) and,
// once any byte differs or a file cannot be read, returns false for the rest
// of the process lifetime. Every consumer (sync gate, health checker,
// onboarding, staff reads) then fails closed with TRUST_STORE_CHANGED.
function trustFingerprint(sources) {
  const hash = createHash("sha256");
  for (const { file, bytes } of sources) hash.update(file).update("\0").update(bytes).update("\0");
  return hash.digest("hex");
}

function bindTrustStoreSources(store, sources, { recheckMs = 5000, now = Date.now, read = (file) => fs.readFileSync(file) } = {}) {
  const loaded = trustFingerprint(sources);
  const files = sources.map((s) => s.file);
  let current = true;
  let checkedAt = now();
  Object.defineProperty(store, "isCurrent", {
    enumerable: false,
    value: () => {
      if (!current) return false;
      if (now() - checkedAt < recheckMs) return true;
      checkedAt = now();
      try { current = trustFingerprint(files.map((file) => ({ file, bytes: read(file) }))) === loaded; } catch { current = false; }
      return current;
    },
  });
  Object.defineProperty(store, "fingerprint", { enumerable: false, value: "sha256:" + loaded });
  return store;
}

module.exports = { SERVICE_ID, EndpointError, buildEndpoints, buildTrustStore, bindTrustStoreSources, resolveEndpoint, clientFor };
