"use strict";

// Strict, fail-closed configuration. The service is DISABLED by default:
// with KARRYAM_ADMIN_ENABLED unset it starts, reports not-ready and refuses
// every protocol call. Enabling it requires every credential to be present
// and valid; any problem stops startup with a sanitized reason code.

const net = require("node:net");
const { contracts, clients } = require("../packages");
const { parseListen } = require("../transport/listen-spec");
const K = require("../security/keys");

const { ConfigError } = K;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const PRODUCT_ROLE = /^[a-z][a-z0-9_.-]{1,95}$/;
const BRIDGE_ROLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const PRODUCT_ID = "karryam";

function bool(value, name) {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigError(name + "_MUST_BE_TRUE_OR_FALSE");
}

function required(env, name, pattern) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError(name + "_REQUIRED");
  if (pattern && !pattern.test(value)) throw new ConfigError(name + "_INVALID");
  return value;
}

function databaseUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new ConfigError(name + "_INVALID"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new ConfigError(name + "_INVALID");
  return value;
}

function intInRange(value, name, min, max, fallback) {
  if (value === undefined || value === "") return fallback;
  if (!/^[0-9]{1,9}$/.test(value)) throw new ConfigError(name + "_INVALID");
  const n = Number(value);
  if (n < min || n > max) throw new ConfigError(name + "_OUT_OF_RANGE");
  return n;
}

// PR #36 origin rules: HTTPS only, no credentials, path, query or fragment.
function bridgeOrigin(value) {
  let origin;
  try { origin = new URL(value); } catch { throw new ConfigError("KARRYAM_BRIDGE_ORIGIN_INVALID"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || !origin.hostname) {
    throw new ConfigError("KARRYAM_BRIDGE_ORIGIN_INVALID");
  }
  return origin;
}

function loadBridgeConfig(env) {
  const enabled = bool(env.KARRYAM_BRIDGE_ENABLED, "KARRYAM_BRIDGE_ENABLED");
  if (!enabled) return Object.freeze({ enabled: false });
  const origin = bridgeOrigin(required(env, "KARRYAM_BRIDGE_ORIGIN"));
  const address = required(env, "KARRYAM_BRIDGE_ADDRESS");
  if (!net.isIP(address) || !clients.isPrivateAddress(address)) throw new ConfigError("KARRYAM_BRIDGE_ADDRESS_NOT_PRIVATE_IP");
  const market = required(env, "KARRYAM_ADMIN_MARKET", OPAQUE);
  const organization = required(env, "KARRYAM_ADMIN_ORGANIZATION", OPAQUE);
  const acr = required(env, "KARRYAM_ADMIN_ACR", OPAQUE);
  const serviceKid = required(env, "KARRYAM_BRIDGE_SERVICE_KID", OPAQUE);
  const staffKid = required(env, "KARRYAM_BRIDGE_STAFF_KID", OPAQUE);
  const issuer = required(env, "KARRYAM_BRIDGE_ISSUER", OPAQUE);
  const audience = required(env, "KARRYAM_BRIDGE_AUDIENCE", OPAQUE);
  let roleMap;
  try { roleMap = JSON.parse(required(env, "KARRYAM_ADMIN_ROLE_MAP")); } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError("KARRYAM_ADMIN_ROLE_MAP_INVALID");
  }
  // Keys are HQ *product grant roles*; staff tiers are never mapped.
  if (!roleMap || typeof roleMap !== "object" || Array.isArray(roleMap) || Object.keys(roleMap).length === 0 ||
      Object.entries(roleMap).some(([k, v]) => !PRODUCT_ROLE.test(k) || ["SUPER", "EXECUTIVE", "ADMIN", "EMPLOYEE"].includes(k.toUpperCase()) || typeof v !== "string" || !BRIDGE_ROLE.test(v))) {
    throw new ConfigError("KARRYAM_ADMIN_ROLE_MAP_INVALID");
  }
  return Object.freeze({
    enabled: true,
    origin: origin.href,
    hostname: origin.hostname,
    port: Number(origin.port || 443),
    address,
    market, organization, acr, serviceKid, staffKid, issuer, audience,
    roleMap: Object.freeze({ ...roleMap }),
    serverCa: K.readSecretFile(required(env, "KARRYAM_BRIDGE_CA_FILE"), "KARRYAM_BRIDGE_CA_FILE"),
    clientCert: K.readSecretFile(required(env, "KARRYAM_BRIDGE_CLIENT_CERT_FILE"), "KARRYAM_BRIDGE_CLIENT_CERT_FILE"),
    clientKey: K.readSecretFile(required(env, "KARRYAM_BRIDGE_CLIENT_KEY_FILE"), "KARRYAM_BRIDGE_CLIENT_KEY_FILE"),
    serviceKey: K.loadBase64UrlKeyFile(required(env, "KARRYAM_BRIDGE_HMAC_KEY_FILE"), "KARRYAM_BRIDGE_HMAC_KEY_FILE"),
    staffPrivateKey: K.loadEd25519PrivateKey(required(env, "KARRYAM_BRIDGE_STAFF_PRIVATE_KEY_FILE"), "KARRYAM_BRIDGE_STAFF_PRIVATE_KEY_FILE"),
  });
}

function loadTls(env, listen) {
  const configured = ["KARRYAM_ADMIN_TLS_CERT_FILE", "KARRYAM_ADMIN_TLS_KEY_FILE", "KARRYAM_ADMIN_TLS_CLIENT_CA_FILE", "KARRYAM_ADMIN_ALLOWED_CLIENT_FINGERPRINTS"].filter((n) => env[n]);
  if (listen.kind === "unix") {
    if (configured.length) throw new ConfigError("TLS_NOT_SUPPORTED_ON_UNIX_SOCKET");
    return null;
  }
  if (configured.length === 0) {
    if (!listen.loopback) throw new ConfigError("NON_LOOPBACK_TCP_REQUIRES_MTLS");
    return null;
  }
  const fingerprints = required(env, "KARRYAM_ADMIN_ALLOWED_CLIENT_FINGERPRINTS").split(",").map((v) => v.trim().replace(/:/g, "").toLowerCase()).filter(Boolean);
  if (fingerprints.length === 0 || fingerprints.some((f) => !FINGERPRINT.test(f))) throw new ConfigError("KARRYAM_ADMIN_ALLOWED_CLIENT_FINGERPRINTS_INVALID");
  return Object.freeze({
    cert: K.readSecretFile(required(env, "KARRYAM_ADMIN_TLS_CERT_FILE"), "KARRYAM_ADMIN_TLS_CERT_FILE"),
    key: K.readSecretFile(required(env, "KARRYAM_ADMIN_TLS_KEY_FILE"), "KARRYAM_ADMIN_TLS_KEY_FILE"),
    clientCa: K.readSecretFile(required(env, "KARRYAM_ADMIN_TLS_CLIENT_CA_FILE"), "KARRYAM_ADMIN_TLS_CLIENT_CA_FILE"),
    allowedClientFingerprints: Object.freeze(fingerprints),
  });
}

function loadConfig(env = process.env, { now = Date.now() } = {}) {
  const listen = parseListen(env.KARRYAM_ADMIN_LISTEN);
  const enabled = bool(env.KARRYAM_ADMIN_ENABLED, "KARRYAM_ADMIN_ENABLED");
  if (!enabled) return Object.freeze({ enabled: false, productId: PRODUCT_ID, listen, tls: null });

  const environment = required(env, "KARRYAM_ADMIN_ENVIRONMENT");
  if (!contracts.ENVIRONMENTS.includes(environment)) throw new ConfigError("KARRYAM_ADMIN_ENVIRONMENT_INVALID");
  const serviceInstanceId = required(env, "KARRYAM_ADMIN_SERVICE_INSTANCE_ID", new RegExp(contracts.PATTERNS.serviceInstanceId));
  const workloadIdentity = required(env, "KARRYAM_ADMIN_WORKLOAD_IDENTITY", new RegExp(contracts.PATTERNS.workloadIdentity));
  if (!workloadIdentity.endsWith("/karryam")) throw new ConfigError("KARRYAM_ADMIN_WORKLOAD_IDENTITY_INVALID");
  const buildSha = required(env, "KARRYAM_ADMIN_BUILD_SHA", new RegExp(contracts.PATTERNS.buildSha));
  const database = databaseUrl(required(env, "KARRYAM_ADMIN_DATABASE_URL"), "KARRYAM_ADMIN_DATABASE_URL");
  if (env.KARRYAM_ADMIN_MIGRATION_DATABASE_URL && env.KARRYAM_ADMIN_MIGRATION_DATABASE_URL === database) {
    throw new ConfigError("RUNTIME_AND_MIGRATION_CREDENTIALS_MUST_DIFFER");
  }
  const serviceKeys = K.loadServiceKeys(required(env, "KARRYAM_ADMIN_HQ_SERVICE_KEYS_FILE"), { now, name: "KARRYAM_ADMIN_HQ_SERVICE_KEYS_FILE" });
  const delegationKeys = K.loadDelegationKeys(required(env, "KARRYAM_ADMIN_DELEGATION_KEYS_FILE"), { now, name: "KARRYAM_ADMIN_DELEGATION_KEYS_FILE" });
  const bridge = loadBridgeConfig(env);
  // Each trust boundary needs its own key: service authentication, staff
  // delegation and the bridge HMAC key must never share key material.
  const boundaries = [
    Object.values(serviceKeys).map((k) => k.key),
    Object.values(delegationKeys).map((k) => k.key),
    bridge.enabled && bridge.serviceKey ? [bridge.serviceKey] : [],
  ];
  for (let i = 0; i < boundaries.length; i += 1) {
    for (let j = i + 1; j < boundaries.length; j += 1) {
      if (boundaries[i].some((a) => boundaries[j].some((b) => Buffer.from(a).equals(Buffer.from(b))))) throw new ConfigError("KEY_REUSE_ACROSS_BOUNDARIES");
    }
  }

  let manifestSigner = null;
  const signerFile = env.KARRYAM_ADMIN_MANIFEST_SIGNING_KEY_FILE;
  const signerKid = env.KARRYAM_ADMIN_MANIFEST_SIGNING_KID;
  if (signerFile || signerKid) {
    if (!signerFile || !signerKid) throw new ConfigError("MANIFEST_SIGNER_REQUIRES_KEY_AND_KID");
    if (!K.KEY_ID.test(signerKid)) throw new ConfigError("KARRYAM_ADMIN_MANIFEST_SIGNING_KID_INVALID");
    manifestSigner = Object.freeze({ kid: signerKid, privateKey: K.loadEd25519PrivateKey(signerFile, "KARRYAM_ADMIN_MANIFEST_SIGNING_KEY_FILE") });
  }

  return Object.freeze({
    enabled: true,
    productId: PRODUCT_ID,
    environment,
    serviceInstanceId,
    workloadIdentity,
    buildSha,
    databaseUrl: database,
    listen,
    tls: loadTls(env, listen),
    serviceKeys,
    delegationKeys,
    allowedServices: Object.freeze(["hq-product-integration-core"]),
    manifestSigner,
    manifestRevision: intInRange(env.KARRYAM_ADMIN_MANIFEST_REVISION, "KARRYAM_ADMIN_MANIFEST_REVISION", 1, 2147483647, 1),
    manifestTtlSeconds: intInRange(env.KARRYAM_ADMIN_MANIFEST_TTL_SECONDS, "KARRYAM_ADMIN_MANIFEST_TTL_SECONDS", 300, 7 * 24 * 3600, 3600),
    bridge,
  });
}

// Never log configuration values, only which optional pieces are present.
function describeConfig(config) {
  if (!config.enabled) return { enabled: false, listen: config.listen.kind };
  return {
    enabled: true,
    environment: config.environment,
    service_instance_id: config.serviceInstanceId,
    listen: config.listen.kind,
    mtls: Boolean(config.tls),
    manifest_signer: config.manifestSigner ? "PROVISIONED" : "NOT_PROVISIONED",
    bridge: config.bridge.enabled ? "CONFIGURED_NOT_CERTIFIED" : "DISABLED",
  };
}

module.exports = { loadConfig, describeConfig, bridgeOrigin, ConfigError, PRODUCT_ID };
