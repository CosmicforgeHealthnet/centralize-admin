"use strict";

const { actionPolicy, ACTIONS } = require("./actions");

const DIMENSIONS = Object.freeze(["market", "organization", "zone", "tenant"]);
const SCOPE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const STAFF_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const PRODUCT_ID = /^[a-z][a-z0-9-]{1,31}$/;
const DATASET_ID = /^[a-z][a-z0-9_.-]{1,95}$/;

// A grant is valid only with exact values. Wildcards ("*", "all", empty
// strings) are rejected rather than interpreted.
function grantErrors(grant) {
  const errors = [];
  if (!grant || typeof grant !== "object") return ["GRANT_INVALID"];
  if (!["PRODUCT", "PLATFORM"].includes(grant.grant_kind)) errors.push("GRANT_KIND_INVALID");
  if (!STAFF_ID.test(String(grant.staff_id))) errors.push("STAFF_INVALID");
  if (grant.grant_kind === "PRODUCT" && !PRODUCT_ID.test(String(grant.product_id))) errors.push("PRODUCT_INVALID");
  if (grant.grant_kind === "PLATFORM" && grant.product_id !== null && grant.product_id !== undefined) errors.push("PLATFORM_GRANT_HAS_PRODUCT");
  if (!["ALLOW", "DENY"].includes(grant.effect)) errors.push("EFFECT_INVALID");
  if (!Array.isArray(grant.actions) || grant.actions.length === 0) errors.push("ACTIONS_REQUIRED");
  for (const action of grant.actions || []) {
    const policy = actionPolicy(action);
    if (!policy) errors.push("UNKNOWN_ACTION:" + action);
    else if (policy.kind !== grant.grant_kind) errors.push("ACTION_KIND_MISMATCH:" + action);
  }
  for (const ds of grant.datasets || []) if (!DATASET_ID.test(String(ds))) errors.push("DATASET_INVALID");
  const scope = grant.scope || {};
  for (const key of Object.keys(scope)) if (!DIMENSIONS.includes(key)) errors.push("SCOPE_DIMENSION_INVALID:" + key);
  for (const dim of DIMENSIONS) {
    if (scope[dim] === undefined) continue;
    if (!Array.isArray(scope[dim]) || scope[dim].length === 0) errors.push("SCOPE_EMPTY:" + dim);
    else if (scope[dim].some((v) => !SCOPE_VALUE.test(String(v)) || v === "*")) errors.push("SCOPE_WILDCARD_OR_INVALID:" + dim);
  }
  if (grant.grant_kind === "PRODUCT" && grant.effect === "ALLOW" && (!scope.market || !scope.organization)) {
    errors.push("PRODUCT_GRANT_REQUIRES_MARKET_AND_ORGANIZATION");
  }
  return errors;
}

function isActive(grant, now) {
  if (grant.revoked_at) return false;
  if (grant.expires_at && Date.parse(grant.expires_at) <= now) return false;
  if (grant.not_before && Date.parse(grant.not_before) > now) return false;
  return true;
}

function deny(reason, extra = {}) {
  return { allowed: false, reason, ...extra };
}

// Computes the effective scope of one grant for one request, or null if the
// request asks for anything outside it (or outside the product's allowed
// registry scope).
function effectiveScope(requested, grantScope, productScope) {
  const result = {};
  for (const dim of DIMENSIONS) {
    const want = requested[dim];
    const granted = grantScope[dim];
    const product = productScope ? productScope[dim] : undefined;
    if (want !== undefined) {
      const values = Array.isArray(want) ? want : [want];
      if (values.length === 0 || values.some((v) => !SCOPE_VALUE.test(String(v)))) return null;
      if (!granted || values.some((v) => !granted.includes(v))) return null;
      if (product && values.some((v) => !product.includes(v))) return null;
      result[dim] = [...values];
    } else if (granted) {
      const values = product ? granted.filter((v) => product.includes(v)) : [...granted];
      if (values.length === 0) return null;
      result[dim] = values;
    }
  }
  return result;
}

/**
 * Authorizes one action. Never consults staff tier. Returns
 * { allowed, reason, grantId, effectiveScope, requirements }.
 *
 * grants === null means the policy store is unavailable: deny.
 */
function authorize({ subject, productId = null, action, datasetId = null, requestedScope = {}, grants, productScope = null, now = Date.now() }) {
  const policy = actionPolicy(action);
  if (!policy) return deny("UNKNOWN_ACTION");
  if (!subject || !STAFF_ID.test(String(subject.staffId || ""))) return deny("SUBJECT_INVALID");
  if (grants === null || grants === undefined || !Array.isArray(grants)) return deny("POLICY_UNAVAILABLE");
  if (policy.kind === "PRODUCT" && !PRODUCT_ID.test(String(productId || ""))) return deny("PRODUCT_INVALID");
  if (policy.dataset && !DATASET_ID.test(String(datasetId || ""))) return deny("DATASET_REQUIRED");
  for (const key of Object.keys(requestedScope)) if (!DIMENSIONS.includes(key)) return deny("SCOPE_DIMENSION_INVALID");

  const relevant = grants.filter((g) => g && g.staff_id === subject.staffId && g.grant_kind === policy.kind &&
    (policy.kind === "PLATFORM" || g.product_id === productId) && Array.isArray(g.actions) && g.actions.includes(action));
  // A malformed explicit deny must still deny: ignoring it would fail open.
  const brokenDeny = relevant.find((g) => g.effect === "DENY" && isActive(g, now) && grantErrors(g).length > 0);
  if (brokenDeny) return deny("POLICY_INVALID", { grantId: brokenDeny.id });
  const active = relevant.filter((g) => isActive(g, now) && grantErrors(g).length === 0);

  // Explicit deny always wins (dataset-specific denies only for that dataset).
  const denied = active.find((g) => g.effect === "DENY" && (!g.datasets || g.datasets.length === 0 || (datasetId && g.datasets.includes(datasetId))));
  if (denied) return deny("EXPLICIT_DENY", { grantId: denied.id });

  const allows = active.filter((g) => g.effect === "ALLOW").sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (allows.length === 0) {
    if (relevant.some((g) => g.effect === "ALLOW" && g.revoked_at)) return deny("GRANT_REVOKED");
    if (relevant.some((g) => g.effect === "ALLOW" && !isActive(g, now))) return deny("GRANT_EXPIRED");
    return deny(policy.kind === "PLATFORM" ? "MISSING_PLATFORM_GRANT" : "MISSING_PRODUCT_GRANT");
  }

  let datasetMissing = false;
  for (const grant of allows) {
    if (policy.dataset && !(grant.datasets || []).includes(datasetId)) { datasetMissing = true; continue; }
    const scope = policy.kind === "PRODUCT" ? effectiveScope(requestedScope, grant.scope || {}, productScope) : {};
    if (!scope) continue;
    if (policy.recentMfaSeconds) {
      const mfaAt = Number(subject.mfaAt || 0) * 1000;
      if (!mfaAt || now - mfaAt > policy.recentMfaSeconds * 1000 || mfaAt > now + 5000) return deny("RECENT_MFA_REQUIRED", { grantId: grant.id });
    }
    return {
      allowed: true,
      reason: "GRANTED",
      grantId: grant.id,
      role: grant.role || null,
      effectiveScope: scope,
      requirements: { recentMfaSeconds: policy.recentMfaSeconds, independentApproval: policy.independentApproval },
    };
  }
  return deny(datasetMissing && allows.every((g) => !(g.datasets || []).includes(datasetId)) ? "MISSING_DATASET_GRANT" : "SCOPE_DENIED");
}

// Requester/approver separation for reviewed transitions.
function requireIndependentActor(actorId, priorActorIds) {
  return !priorActorIds.filter(Boolean).includes(actorId);
}

module.exports = { DIMENSIONS, grantErrors, isActive, effectiveScope, authorize, requireIndependentActor, ACTIONS };
