"use strict";

// Offline, root-operated staging bootstrap. HTTP callers cannot construct a
// permit: only a current, signed delegation verified against separately pinned
// owner public keys can mint the in-process capability.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash, createPublicKey, verify } = require("node:crypto");
const { recordAudit } = require("../audit");
const permits = new WeakSet();
const DOMAIN = "cosmicforge-staging-onboarding-delegation-v1\n";
const TRUST_FILE = "/etc/cosmicforge/staging/secrets/pic-operator-authority/public-keys.json";
const DIMENSIONS = Object.freeze(["market", "organization", "zone", "tenant"]);
const ACTIONS = Object.freeze(["integration.read", "integration.request", "integration.verify", "integration.review", "integration.certify", "integration.approve"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
function denied(reason) { throw Object.assign(new Error(reason), { reason, status: 403 }); }
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
function equalScope(a, b) {
  return Boolean(a && b && Object.keys(a).sort().join(",") === "market,organization,tenant,zone" && Object.keys(b).sort().join(",") === "market,organization,tenant,zone" && DIMENSIONS.every((k) => Array.isArray(a[k]) && a[k].length === 1 && typeof a[k][0] === "string" && TOKEN.test(a[k][0]) && Array.isArray(b[k]) && b[k].length === 1 && a[k][0] === b[k][0]));
}
function parseSignedDecision(raw, trust, { environment, operator, now = Date.now() }) {
  if (environment !== "staging") denied("OPERATOR_STAGING_ONLY");
  let envelope;
  try { envelope = JSON.parse(raw); } catch { denied("OPERATOR_DECISION_INVALID"); }
  if (!envelope || Object.keys(envelope).sort().join(",") !== "document,key_id,signature") denied("OPERATOR_DECISION_INVALID");
  const d = envelope.document;
  // Scope and product pins come from the separately installed root-owned trust
  // entry, never from the incoming decision or a caller-supplied scope.
  const entry = trust && trust.keys && Object.prototype.hasOwnProperty.call(trust.keys, envelope.key_id) ? trust.keys[envelope.key_id] : null;
  if (!entry || entry.revoked !== false || entry.purpose !== "OWNER_DELEGATION" || !TOKEN.test(entry.product_id || "") || entry.environment !== "staging" || !equalScope(entry.allowed_scope, entry.allowed_scope) || !(Date.parse(entry.not_after) > now)) denied("OPERATOR_SIGNER_NOT_TRUSTED");
  const fields = ["schema_version", "decision_id", "operator", "owner_delegation_ref", "environment", "product_id", "allowed_scope", "issued_at", "expires_at", "allow_setup_without_staff_sessions", "allow_single_operator_onboarding"];
  if (d && Object.hasOwn(d, "allow_scoped_readonly_subscriptions")) {
    fields.push("allow_scoped_readonly_subscriptions", "readonly_subscription_datasets", "readonly_subscription_department");
    const ids=d.readonly_subscription_datasets;
    if (d.allow_scoped_readonly_subscriptions !== true || entry.allow_scoped_readonly_subscriptions !== true || !Array.isArray(ids) || ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length || ids.some(id=>typeof id!=="string" || !/^[a-z][a-z0-9_.-]{1,95}$/.test(id) || !id.startsWith(entry.product_id+".")) || JSON.stringify(ids)!==JSON.stringify(entry.readonly_subscription_datasets) || !/^[a-z][a-z0-9_-]{1,31}$/.test(d.readonly_subscription_department || "") || d.readonly_subscription_department!==entry.readonly_subscription_department) denied("OPERATOR_SUBSCRIPTION_SCOPE_DENIED");
  }
  if (!d || typeof d !== "object" || Array.isArray(d) || Object.keys(d).length !== fields.length || Object.keys(d).some((k) => !fields.includes(k)) || d.schema_version !== 1 || d.environment !== "staging" || d.product_id !== entry.product_id || d.operator !== operator || !TOKEN.test(operator || "") || !TOKEN.test(d.decision_id || "") || !TOKEN.test(d.owner_delegation_ref || "") || d.allow_setup_without_staff_sessions !== true || d.allow_single_operator_onboarding !== true || !equalScope(d.allowed_scope, entry.allowed_scope)) denied("OPERATOR_DECISION_INVALID");
  const issued = Date.parse(d.issued_at), expires = Date.parse(d.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now || expires <= issued || expires - issued > 3600000) denied("OPERATOR_DECISION_EXPIRED_OR_INVALID");
  if (Date.parse(entry.not_after) < expires) denied("OPERATOR_SIGNER_NOT_TRUSTED");
  try {
    const key = createPublicKey(entry.public_key_pem);
    if (key.asymmetricKeyType !== "ed25519" || typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature) || !verify(null, Buffer.from(DOMAIN + canonical(d)), key, Buffer.from(envelope.signature, "base64url"))) denied("OPERATOR_SIGNATURE_INVALID");
  } catch { denied("OPERATOR_SIGNATURE_INVALID"); }
  return d;
}
function protectedRead(file, privateFile) {
  if (typeof file !== "string" || !file.startsWith("/etc/cosmicforge/staging/") || file.split("/").includes("..")) denied("OPERATOR_DECISION_PATH_INVALID");
  let parent = "/";
  for (const part of file.split("/").filter(Boolean)) {
    parent = path.join(parent, part);
    const st = fs.lstatSync(parent);
    if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0) denied("OPERATOR_FILE_NOT_PROTECTED");
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== 0 || (st.mode & (privateFile ? 0o077 : 0o022)) !== 0 || st.size > 16384) denied("OPERATOR_FILE_NOT_PROTECTED");
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}
function loadOperatorPermit(file, { environment, now = Date.now() } = {}) {
  if (process.platform !== "linux" || process.getuid() !== 0) denied("OPERATOR_ROOT_REQUIRED");
  const raw = protectedRead(file, true), trust = protectedRead(TRUST_FILE, false);
  const decision = parseSignedDecision(raw, JSON.parse(trust), { environment, operator: "root@" + os.hostname(), now });
  const permit = Object.freeze({ decision: Object.freeze({ ...decision, ...(decision.readonly_subscription_datasets ? { readonly_subscription_datasets: Object.freeze(decision.readonly_subscription_datasets.slice()) } : {}), allowed_scope: Object.freeze(Object.fromEntries(Object.entries(decision.allowed_scope).map(([k, v]) => [k, Object.freeze(v.slice())]))) }), file, digest: createHash("sha256").update(raw).digest("hex"), trustDigest: createHash("sha256").update(trust).digest("hex") });
  permits.add(permit);
  return permit;
}
function validPermit(permit, { environment, productId, scope, now = Date.now() } = {}) {
  if (!permit || !permits.has(permit) || environment !== "staging" || productId !== undefined && productId !== permit.decision.product_id || Date.parse(permit.decision.expires_at) <= now || scope && !equalScope(scope, permit.decision.allowed_scope)) return false;
  try {
    const raw = protectedRead(permit.file, true), trust = protectedRead(TRUST_FILE, false);
    if (createHash("sha256").update(raw).digest("hex") !== permit.digest || createHash("sha256").update(trust).digest("hex") !== permit.trustDigest) { permits.delete(permit); return false; }
    parseSignedDecision(raw, JSON.parse(trust), { environment, operator: "root@" + os.hostname(), now });
  } catch { permits.delete(permit); return false; }
  return true;
}
async function authorizeOperator(db, permit, { environment, subject, action, correlationId, now }) {
  const subscriptionSetup = action === "integration.subscriptions.manage" && permit?.decision?.allow_scoped_readonly_subscriptions === true;
  if (!validPermit(permit, { environment, now }) || subject.staffId !== "operator:" + permit.decision.operator || (!ACTIONS.includes(action) && !subscriptionSetup)) denied("OPERATOR_NOT_AUTHORIZED");
  await recordAudit(db, { correlationId, actorType: "OPERATOR", actorId: subject.staffId, productId: permit.decision.product_id, action, outcome: "ALLOWED", reasonCode: "OWNER_DELEGATED_STAGING_SETUP", metadata: { decision_ref: permit.decision.decision_id, delegation_ref: permit.decision.owner_delegation_ref, staff_session_used: false, independence_exception: true, environment, decision_issued_at: permit.decision.issued_at, decision_expires_at: permit.decision.expires_at, decision_digest: permit.digest, authority_digest: permit.trustDigest, scope_market: permit.decision.allowed_scope.market[0], scope_organization: permit.decision.allowed_scope.organization[0], scope_zone: permit.decision.allowed_scope.zone[0], scope_tenant: permit.decision.allowed_scope.tenant[0] } });
  return { allowed: true };
}
module.exports = { loadOperatorPermit, validPermit, authorizeOperator, parseSignedDecision, equalScope, canonical, DOMAIN };
