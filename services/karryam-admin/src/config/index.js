"use strict";

// Strict, fail-closed configuration. The service is DISABLED by default:
// with KARRYAM_ADMIN_ENABLED unset it starts, reports not-ready and refuses
// every protocol call. Enabling it requires every credential to be present
// and valid; any problem stops startup with a sanitized reason code.

const net = require("node:net");
const { X509Certificate } = require("node:crypto");
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

const WORKLOAD_URI = /^(?:spiffe|cf):\/\/[a-z0-9.-]{1,63}(?:\/[A-Za-z0-9._-]{1,63}){1,6}$/;
const SCOPE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function fingerprintList(value, name) {
  if (value === undefined || value.trim() === "") return [];
  const list = value.split(",").map((v) => v.trim().replace(/:/g, "").toLowerCase()).filter(Boolean);
  if (list.some((f) => !FINGERPRINT.test(f))) throw new ConfigError(name + "_INVALID");
  return [...new Set(list)];
}

// Approved zone/tenant enrollment for zone- and tenant-scoped Bridge routes.
function scopeList(value, name) {
  if (value === undefined || value.trim() === "") return [];
  const list = value.split(",").map((v) => v.trim()).filter(Boolean);
  if (list.length > 64 || list.some((v) => !SCOPE_VALUE.test(v) || v === "*")) throw new ConfigError(name + "_INVALID");
  return [...new Set(list)];
}

// The enrolled client certificate must be currently valid, carry exactly the
// approved workload URI SAN and not be on the revocation list.
function checkClientCertificate(pem, expectedUri, revoked, now) {
  let cert;
  try { cert = new X509Certificate(pem); } catch { throw new ConfigError("KARRYAM_BRIDGE_CLIENT_CERT_INVALID"); }
  if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now) throw new ConfigError("KARRYAM_BRIDGE_CLIENT_CERT_NOT_CURRENTLY_VALID");
  const uris = String(cert.subjectAltName || "").split(",").map((s) => s.trim()).filter((s) => s.startsWith("URI:")).map((s) => s.slice(4));
  if (uris.length !== 1 || uris[0] !== expectedUri) throw new ConfigError("KARRYAM_BRIDGE_CLIENT_CERT_URI_MISMATCH");
  const fingerprint = cert.fingerprint256.replace(/:/g, "").toLowerCase();
  if (revoked.includes(fingerprint)) throw new ConfigError("KARRYAM_BRIDGE_CLIENT_CERT_REVOKED");
  return Object.freeze({ uri: expectedUri, fingerprint, notAfter: new Date(Date.parse(cert.validTo)).toISOString() });
}

function loadBridgeConfig(env, now = Date.now()) {
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
  const serverCa = K.readSecretFile(required(env, "KARRYAM_BRIDGE_CA_FILE"), "KARRYAM_BRIDGE_CA_FILE");
  const clientCert = K.readSecretFile(required(env, "KARRYAM_BRIDGE_CLIENT_CERT_FILE"), "KARRYAM_BRIDGE_CLIENT_CERT_FILE");
  const revokedServerFingerprints = fingerprintList(env.KARRYAM_BRIDGE_REVOKED_FINGERPRINTS, "KARRYAM_BRIDGE_REVOKED_FINGERPRINTS");
  const clientIdentity = checkClientCertificate(clientCert, required(env, "KARRYAM_BRIDGE_CLIENT_URI", WORKLOAD_URI), revokedServerFingerprints, now);
  return Object.freeze({
    enabled: true,
    origin: origin.href,
    hostname: origin.hostname,
    port: Number(origin.port || 443),
    address,
    market, organization, acr, serviceKid, staffKid, issuer, audience,
    zones: Object.freeze(scopeList(env.KARRYAM_ADMIN_ZONES, "KARRYAM_ADMIN_ZONES")),
    tenants: Object.freeze(scopeList(env.KARRYAM_ADMIN_TENANTS, "KARRYAM_ADMIN_TENANTS")),
    mfaMaxAgeSeconds: intInRange(env.KARRYAM_ADMIN_BRIDGE_MFA_MAX_AGE_SECONDS, "KARRYAM_ADMIN_BRIDGE_MFA_MAX_AGE_SECONDS", 30, 300, 300),
    serverFingerprints: Object.freeze(fingerprintList(env.KARRYAM_BRIDGE_SERVER_FINGERPRINTS, "KARRYAM_BRIDGE_SERVER_FINGERPRINTS")),
    revokedServerFingerprints: Object.freeze(revokedServerFingerprints),
    clientIdentity,
    roleMap: Object.freeze({ ...roleMap }),
    serverCa,
    clientCert,
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
  const bridge = loadBridgeConfig(env, now);
  // Continuation tokens are sealed with their own key (required whenever the
  // Bridge is enabled, because only then are paginated reads possible).
  const cursorKey = env.KARRYAM_ADMIN_CURSOR_KEY_FILE || bridge.enabled
    ? K.loadBase64UrlKeyFile(required(env, "KARRYAM_ADMIN_CURSOR_KEY_FILE"), "KARRYAM_ADMIN_CURSOR_KEY_FILE")
    : null;
  const enabledCommands = commandAllowlist(env.KARRYAM_ADMIN_ENABLED_COMMANDS, bridge);
  const certifiedDatasets = idList(env.KARRYAM_ADMIN_CERTIFIED_DATASETS, "KARRYAM_ADMIN_CERTIFIED_DATASETS", KNOWN_DATASETS);
  const feed = loadFeedConfig(env, bridge, environment);
  // Each trust boundary needs its own key: service authentication, staff
  // delegation, the bridge HMAC key and the continuation-token key must
  // never share key material.
  const boundaries = [
    Object.values(serviceKeys).map((k) => k.key),
    Object.values(delegationKeys).map((k) => k.key),
    bridge.enabled && bridge.serviceKey ? [bridge.serviceKey] : [],
    cursorKey ? [cursorKey] : [],
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
    cursorKey,
    enabledCommands,
    certifiedDatasets,
    feed,
  });
}

// Dataset IDs this Product Admin can publish (see sync/datasets.js).
const KNOWN_DATASETS = Object.freeze(["karryam.support_operations", "karryam.verification_pipeline", "karryam.marketing_campaigns", "karryam.sync_health"]);
const CATALOG_ID = /^[a-z][a-z0-9_.-]{1,95}$/;

function idList(value, name, known) {
  if (value === undefined || value.trim() === "") return Object.freeze([]);
  const list = [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))];
  if (list.some((v) => !CATALOG_ID.test(v) || (known && !known.includes(v)))) throw new ConfigError(name + "_INVALID");
  return Object.freeze(list);
}

// Explicitly enabled source commands. Only exact pinned COMMAND/RETRIEVAL
// capabilities qualify, R3/R4 are refused until a separate certification,
// and nothing can be enabled without an enrolled Bridge.
function commandAllowlist(value, bridge) {
  const list = idList(value, "KARRYAM_ADMIN_ENABLED_COMMANDS");
  if (list.length === 0) return list;
  if (!bridge.enabled) throw new ConfigError("KARRYAM_ADMIN_ENABLED_COMMANDS_REQUIRE_BRIDGE");
  const registry = require("../bridge/contracts/registry");
  for (const id of list) {
    const cap = id.startsWith("karryam.") ? registry.capability(id.slice("karryam.".length)) : null;
    if (!cap || !["COMMAND", "RETRIEVAL"].includes(cap.kind) || ["BLOCKED_DEPENDENCY", "DISABLED"].includes(cap.matrix_state)) throw new ConfigError("KARRYAM_ADMIN_ENABLED_COMMANDS_INVALID");
    if (cap.risk === "R3" || cap.risk === "R4") throw new ConfigError("KARRYAM_ADMIN_COMMAND_RISK_REQUIRES_CERTIFICATION");
  }
  return list;
}

// Stage A consumer (worker process). Disabled unless explicitly enabled with
// an enrolled Bridge and an operator-approved consumer principal.
function loadFeedConfig(env, bridge, environment) {
  if (!bool(env.KARRYAM_BRIDGE_FEED_ENABLED, "KARRYAM_BRIDGE_FEED_ENABLED")) return Object.freeze({ enabled: false });
  if (!bridge.enabled) throw new ConfigError("KARRYAM_BRIDGE_FEED_REQUIRES_BRIDGE");
  let scopes;
  try { scopes = JSON.parse(required(env, "KARRYAM_BRIDGE_FEED_SCOPES")); } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError("KARRYAM_BRIDGE_FEED_SCOPES_INVALID");
  }
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 32) throw new ConfigError("KARRYAM_BRIDGE_FEED_SCOPES_INVALID");
  const seen = new Set();
  for (const s of scopes) {
    if (!s || typeof s !== "object" || Object.keys(s).sort().join(",") !== "market,organization,tenant,zone") throw new ConfigError("KARRYAM_BRIDGE_FEED_SCOPES_INVALID");
    if (s.market !== bridge.market || s.organization !== bridge.organization || !bridge.zones.includes(s.zone) || !bridge.tenants.includes(s.tenant)) throw new ConfigError("KARRYAM_BRIDGE_FEED_SCOPE_NOT_ENROLLED");
    // Stage B publishes partition scopes to HQ, whose scope values are stricter.
    if (!SCOPE_VALUE.test(s.market) || !SCOPE_VALUE.test(s.organization)) throw new ConfigError("KARRYAM_BRIDGE_FEED_SCOPE_NOT_HQ_REPRESENTABLE");
    const key = [s.market, s.organization, s.zone, s.tenant].join("|");
    if (seen.has(key)) throw new ConfigError("KARRYAM_BRIDGE_FEED_SCOPES_DUPLICATE");
    seen.add(key);
  }
  return Object.freeze({
    enabled: true,
    scopes: Object.freeze(scopes.map((s) => Object.freeze({ ...s }))),
    consumer: required(env, "KARRYAM_BRIDGE_FEED_CONSUMER", OPAQUE),
    subject: required(env, "KARRYAM_BRIDGE_FEED_SUBJECT", OPAQUE),
    role: required(env, "KARRYAM_BRIDGE_FEED_ROLE", BRIDGE_ROLE),
    acr: required(env, "KARRYAM_BRIDGE_FEED_ACR", OPAQUE),
    purpose: env.KARRYAM_BRIDGE_FEED_PURPOSE ? required(env, "KARRYAM_BRIDGE_FEED_PURPOSE", OPAQUE) : "hq_event_sync",
    pageSize: intInRange(env.KARRYAM_BRIDGE_FEED_PAGE_SIZE, "KARRYAM_BRIDGE_FEED_PAGE_SIZE", 1, 100, 50),
    pollSeconds: intInRange(env.KARRYAM_BRIDGE_FEED_POLL_SECONDS, "KARRYAM_BRIDGE_FEED_POLL_SECONDS", 5, 3600, 15),
    rewindEvents: intInRange(env.KARRYAM_BRIDGE_FEED_REWIND_EVENTS, "KARRYAM_BRIDGE_FEED_REWIND_EVENTS", 0, 10000, 200),
    reconcileSeconds: intInRange(env.KARRYAM_BRIDGE_RECONCILE_INTERVAL_SECONDS, "KARRYAM_BRIDGE_RECONCILE_INTERVAL_SECONDS", 300, 7 * 86400, 86400),
    retentionDays: intInRange(env.KARRYAM_ADMIN_INBOX_RETENTION_DAYS, "KARRYAM_ADMIN_INBOX_RETENTION_DAYS", 7, 3650, 90),
    leaseSeconds: intInRange(env.KARRYAM_BRIDGE_FEED_LEASE_SECONDS, "KARRYAM_BRIDGE_FEED_LEASE_SECONDS", 10, 600, 60),
    environment,
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
    enabled_commands: config.enabledCommands.length,
    certified_datasets: config.certifiedDatasets.length,
    bridge_feed: config.feed.enabled ? { partitions: config.feed.scopes.length } : "DISABLED",
  };
}

module.exports = { loadConfig, describeConfig, bridgeOrigin, ConfigError, PRODUCT_ID };
