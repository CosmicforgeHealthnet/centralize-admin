"use strict";
const fs = require("node:fs");
const { createPrivateKey } = require("node:crypto");
const { bridgeOrigin } = require("./bridge-client");
const { OPAQUE } = require("./protocol");

function secretFile(env, name) {
  const path = env[name];
  if (!path || !path.startsWith("/")) throw new Error("missing_secret_file");
  return fs.readFileSync(path);
}
function loadConfig(env = process.env) {
  const enabled = env.KARRYAM_ADMIN_ENABLED === "true";
  if (!enabled) return { enabled: false };
  const market = env.KARRYAM_ADMIN_MARKET, organization = env.KARRYAM_ADMIN_ORGANIZATION, acr = env.KARRYAM_ADMIN_ACR;
  if (![market, organization, acr, env.KARRYAM_BRIDGE_STAFF_KID, env.KARRYAM_BRIDGE_SERVICE_KID].every(x => typeof x === "string" && OPAQUE.test(x))) throw new Error("invalid_scope_or_key_ids");
  const roles = JSON.parse(env.KARRYAM_ADMIN_ROLE_MAP || "{}");
  if (!roles || Array.isArray(roles) || Object.keys(roles).length < 1 || Object.values(roles).some(x => typeof x !== "string" || !OPAQUE.test(x))) throw new Error("invalid_role_map");
  const socketPath = env.KARRYAM_ADMIN_SOCKET_PATH;
  if (!socketPath || !socketPath.startsWith("/") || socketPath.includes("..")) throw new Error("invalid_socket_path");
  const bridge = bridgeOrigin(env.KARRYAM_BRIDGE_ORIGIN || "");
  if (!bridge.hostname) throw new Error("invalid_bridge_origin");
  const delegationSecret = Buffer.from(secretFile(env, "KARRYAM_HQ_DELEGATION_SECRET_FILE").toString("utf8").trim(), "base64url");
  const serviceKey = Buffer.from(secretFile(env, "KARRYAM_BRIDGE_HMAC_KEY_FILE").toString("utf8").trim(), "base64url");
  if (delegationSecret.length < 32 || serviceKey.length < 32) throw new Error("short_secret");
  const staffPrivateKey = createPrivateKey(secretFile(env, "KARRYAM_BRIDGE_STAFF_PRIVATE_KEY_FILE"));
  if (staffPrivateKey.asymmetricKeyType !== "ed25519") throw new Error("wrong_signing_key_type");
  const issuer = env.KARRYAM_BRIDGE_ISSUER, audience = env.KARRYAM_BRIDGE_AUDIENCE;
  if (!issuer || !audience) throw new Error("missing_bridge_policy");
  return {
    enabled, socketPath, market, organization, acr, roles, delegationSecret, serviceKey, staffPrivateKey,
    bridgeOrigin: bridge.href, issuer, audience,
    staffKid: env.KARRYAM_BRIDGE_STAFF_KID, serviceKid: env.KARRYAM_BRIDGE_SERVICE_KID,
    clientCert: secretFile(env, "KARRYAM_BRIDGE_CLIENT_CERT_FILE"),
    clientKey: secretFile(env, "KARRYAM_BRIDGE_CLIENT_KEY_FILE"),
    serverCa: secretFile(env, "KARRYAM_BRIDGE_CA_FILE")
  };
}
module.exports = { loadConfig };
