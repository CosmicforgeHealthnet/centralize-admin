"use strict";

// Internal HTTP API of the Product Integration Core. Reachable only from the
// Central Admin API over private transport. Every request carries a
// short-lived, request-bound HQ delegation token (cf-hq-delegation+jwt)
// signed by the Central Admin API after it validated the staff session;
// PIC re-verifies it and independently authorizes every action.

const { randomUUID } = require("node:crypto");
const C = require("../../../../packages/admin-contracts");
const I = require("../../../../packages/identity-and-permissions");
const { T } = require("../db");
const { createOnboarding, OnboardingError } = require("../onboarding/service");
const { TransitionError } = require("../onboarding/state-machine");
const { createProducts, ProductError } = require("./products");
const { AuthorizationError, authorizeStaff } = require("../authz");
const { integrationStatus } = require("../monitoring");
const { createHealthChecker } = require("../registry/health");

const BASE = "/internal/pic/v1";
const MAX_BODY = 64 * 1024;
const ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const PRODUCT = "([a-z][a-z0-9-]{1,31})";
const OPAQUE = "([A-Za-z0-9][A-Za-z0-9._:-]{0,127})";
const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

class HttpError extends Error {
  constructor(status, code, reason, detail) {
    super(reason);
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.detail = detail;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] || 0) > MAX_BODY) { req.resume(); reject(new HttpError(413, "PAYLOAD_TOO_LARGE", "BODY_TOO_LARGE")); return; }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); reject(new HttpError(413, "PAYLOAD_TOO_LARGE", "BODY_TOO_LARGE")); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => reject(new HttpError(400, "INVALID_REQUEST", "BODY_ABORTED")));
  });
}

function createApp({ pool, endpoints, trustStore, hqDelegationKeys, environment, enabled = true, nonceStore, now = Date.now, logger = () => {}, clientOptions = {}, syncEngine = null }) {
  const onboarding = createOnboarding({ pool, endpoints, trustStore, environment, now, clientOptions });
  const products = createProducts({ pool, endpoints, environment, now, clientOptions });
  const health = createHealthChecker({ pool, endpoints, trustStore, now, clientOptions });

  const admin = (suffix) => new RegExp("^" + BASE + "/admin/product-integrations/" + ID + suffix + "$");
  const transitionRoutes = {
    "verify-identity": "verifyIdentity", "validate-contract": "validateContract", "review-policy": "reviewPolicy",
    "certify-staging": "certifyStaging", approve: "approve", reject: "reject", suspend: "suspend", revoke: "revoke", "resume-review": "resumeReview",
  };
  const routes = [
    ["GET", new RegExp("^" + BASE + "/products$"), (c) => products.list(c.subject, c).then(ok)],
    ["GET", new RegExp("^" + BASE + "/products/" + PRODUCT + "/manifest$"), (c, m) => products.manifest(c.subject, m[1], c).then(env)],
    ["GET", new RegExp("^" + BASE + "/products/" + PRODUCT + "/capabilities$"), (c, m) => products.capabilities(c.subject, m[1], c).then(env)],
    ["GET", new RegExp("^" + BASE + "/products/" + PRODUCT + "/datasets$"), (c, m) => products.datasets(c.subject, m[1], c).then(env)],
    ["GET", new RegExp("^" + BASE + "/products/" + PRODUCT + "/metrics/" + OPAQUE + "$"), (c, m) => products.metric(c.subject, m[1], m[2], c.query, c).then(env)],
    ["GET", new RegExp("^" + BASE + "/products/" + PRODUCT + "/events/status$"), (c, m) => products.eventsStatus(c.subject, m[1], c).then(env)],
    ["GET", new RegExp("^" + BASE + "/products/" + PRODUCT + "/operations/" + OPAQUE + "$"), (c, m) => products.operation(c.subject, m[1], m[2], c).then(env)],
    ["POST", new RegExp("^" + BASE + "/products/" + PRODUCT + "/operations$"), (c, m) => products.submitOperation(c.subject, m[1], c.body, c).then(env)],
    ["GET", new RegExp("^" + BASE + "/admin/product-integrations$"), (c) => onboarding.list(c.subject, c).then(ok)],
    ["POST", new RegExp("^" + BASE + "/admin/product-integrations$"), (c) => onboarding.request(c.subject, c.body, c).then(created)],
    ["GET", admin(""), (c, m) => onboarding.get(c.subject, m[1], c).then(ok)],
    ["GET", admin("/monitoring"), async (c, m) => { await authorizeStaff(pool, { subject: c.subject, action: "integration.read", correlationId: c.correlationId, now: now() }); const s = await integrationStatus(pool, m[1], { now: now() }); if (!s) throw new HttpError(404, "NOT_FOUND", "NOT_FOUND"); return ok(s); }],
    ...Object.entries(transitionRoutes).map(([path, fn]) => ["POST", admin("/" + path), (c, m) => onboarding[fn](c.subject, m[1], c.body || {}, c).then(ok)]),
    ["POST", admin("/datasets/" + OPAQUE + "/approve"), (c, m) => onboarding.approveDataset(c.subject, m[1], m[2], c.body || {}, c).then(ok)],
    ["POST", admin("/subscriptions"), (c, m) => onboarding.createSubscription(c.subject, m[1], c.body || {}, c).then(created)],
    ["POST", admin("/subscriptions/" + ID + "/enable"), (c, m) => onboarding.setSubscriptionEnabled(c.subject, m[1], m[2], true, c).then(ok)],
    ["POST", admin("/subscriptions/" + ID + "/disable"), (c, m) => onboarding.setSubscriptionEnabled(c.subject, m[1], m[2], false, c).then(ok)],
    ["POST", admin("/contracts/propose"), (c, m) => onboarding.proposeContractRevision(c.subject, m[1], c).then(ok)],
    ["POST", admin("/contracts/" + ID + "/certify"), (c, m) => onboarding.certifyContract(c.subject, m[1], m[2], c.body || {}, c).then(ok)],
    ["POST", admin("/contracts/" + ID + "/activate"), (c, m) => onboarding.activateContract(c.subject, m[1], m[2], c.body || {}, c).then(ok)],
    ["POST", admin("/health-check"), async (c, m) => {
      await authorizeStaff(pool, { subject: c.subject, action: "integration.verify", correlationId: c.correlationId, now: now() });
      const { rows } = await pool.query(`SELECT * FROM ${T}hq_product_admins WHERE id = $1 AND environment = $2 AND lifecycle_status NOT IN ('REVOKED','REJECTED')`, [m[1], environment]);
      if (!rows[0]) throw new HttpError(404, "NOT_FOUND", "NOT_FOUND");
      return ok(await health.check(rows[0]));
    }],
    ["POST", admin("/sync"), async (c, m) => {
      await authorizeStaff(pool, { subject: c.subject, action: "integration.subscriptions.manage", correlationId: c.correlationId, now: now() });
      if (!syncEngine) throw new HttpError(503, "UNAVAILABLE", "SYNC_DISABLED");
      return ok(await syncEngine.tick({ productAdminId: m[1] }));
    }],
    ["POST", new RegExp("^" + BASE + "/admin/product-integration-grants$"), (c) => onboarding.grant(c.subject, c.body || {}, c).then(created)],
    ["POST", new RegExp("^" + BASE + "/admin/product-integration-grants/" + ID + "/revoke$"), (c, m) => onboarding.revokeGrant(c.subject, m[1], c.body || {}, c).then(ok)],
  ];

  function ok(data) { return { status: 200, body: { success: true, data } }; }
  function created(data) { return { status: 201, body: { success: true, data } }; }
  function env(result) { return result && result.body ? result : { status: result.error ? C.ERROR_CODES[result.error.code] : 200, body: result }; }

  async function verifyCaller(req, raw, body) {
    const tokens = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (String(req.rawHeaders[i]).toLowerCase() === "x-cf-hq-delegation") tokens.push(req.rawHeaders[i + 1]);
    if (tokens.length !== 1) throw new HttpError(401, "UNAUTHENTICATED", tokens.length ? "DUPLICATE_DELEGATION" : "DELEGATION_REQUIRED");
    let claims;
    try {
      claims = I.verifyDelegation(tokens[0], { keys: hqDelegationKeys, typ: I.TYPES.HQ, issuer: "central-admin-api", audience: "product-integration-core", binding: I.requestBinding(req.method, raw, body), now: now() });
    } catch (err) {
      throw new HttpError(401, "UNAUTHENTICATED", "DELEGATION_INVALID", err.reason);
    }
    let fresh;
    try { fresh = await nonceStore.claim("hq-delegation", claims.jti, claims.exp * 1000); } catch { throw new HttpError(503, "UNAVAILABLE", "REPLAY_STORE_UNAVAILABLE"); }
    if (!fresh) throw new HttpError(401, "UNAUTHENTICATED", "DELEGATION_REPLAYED");
    return { staffId: claims.sub, sessionId: claims.sid, authTime: claims.auth_time, mfaAt: claims.mfa_at, tier: claims.tier || null };
  }

  return async function handler(req, res) {
    const correlationId = randomUUID();
    const started = now();
    let status = 500;
    const send = (code, body) => {
      status = code;
      res.writeHead(code, { ...HEADERS, "X-Correlation-Id": correlationId });
      res.end(JSON.stringify(body && body.contract_version ? body : { ...body, correlation_id: correlationId }));
    };
    try {
      const raw = String(req.url || "");
      if (!raw.startsWith("/") || raw.startsWith("//") || raw.length > 2048 || raw.includes("..") || /[\\%]/.test(raw.split("?")[0])) throw new HttpError(400, "INVALID_REQUEST", "REQUEST_TARGET_INVALID");
      const url = new URL(raw, "http://pic.local");
      if (url.pathname === "/health/live") return send(200, { status: "live", service: "product-integration-core" });
      if (url.pathname === "/health/ready") {
        if (!enabled) return send(503, { status: "DISABLED", service: "product-integration-core" });
        try { await pool.query("SELECT 1"); return send(200, { status: "READY", service: "product-integration-core", database: "OK", upstream_products: "SEE_MONITORING" }); }
        catch { return send(503, { status: "NOT_READY", service: "product-integration-core", database: "UNAVAILABLE" }); }
      }
      if (!enabled) throw new HttpError(503, "UNAVAILABLE", "PRODUCT_INTEGRATION_DISABLED");
      const route = routes.find(([method, pattern]) => pattern.test(url.pathname) && method === req.method);
      if (!route) {
        if (routes.some(([, pattern]) => pattern.test(url.pathname))) throw new HttpError(405, "METHOD_NOT_ALLOWED", "METHOD_NOT_ALLOWED");
        throw new HttpError(404, "NOT_FOUND", "UNKNOWN_ROUTE");
      }
      let body = Buffer.alloc(0);
      if (req.method === "POST") {
        if (!/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] || ""))) throw new HttpError(400, "INVALID_REQUEST", "CONTENT_TYPE_REQUIRED");
        body = await readBody(req);
      }
      const subject = await verifyCaller(req, raw, body);
      let parsed = null;
      if (body.length) {
        try { parsed = JSON.parse(body.toString("utf8")); } catch { throw new HttpError(400, "INVALID_REQUEST", "BODY_NOT_JSON"); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "INVALID_REQUEST", "BODY_NOT_OBJECT");
      }
      const result = await route[2]({ subject, body: parsed, query: url.searchParams, correlationId }, route[1].exec(url.pathname));
      return send(result.status, result.body);
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { success: false, error: { code: err.code, reason: err.reason } });
      if (err instanceof AuthorizationError) return send(err.status, { success: false, error: { code: err.status === 503 ? "UNAVAILABLE" : "FORBIDDEN", reason: err.reason } });
      if (err instanceof OnboardingError || err instanceof TransitionError) return send(err.status, { success: false, error: { code: err.status === 404 ? "NOT_FOUND" : err.status === 403 ? "FORBIDDEN" : err.status === 400 ? "INVALID_REQUEST" : err.status === 503 ? "UNAVAILABLE" : err.status === 422 ? "UNPROCESSABLE" : "CONFLICT", reason: err.reason, detail: Array.isArray(err.detail) ? err.detail.map((d) => (typeof d === "string" ? d : d.kind || "")).slice(0, 10) : undefined } });
      if (err instanceof ProductError || err instanceof C.ProtocolError) return send(err.status, { success: false, error: { code: err.code, reason: err.reason } });
      logger({ service: "product-integration-core", event: "unhandled_error", error: err && err.name, code: err && err.code, correlation_id: correlationId });
      return send(500, { success: false, error: { code: "INTERNAL", reason: "INTERNAL_ERROR" } });
    } finally {
      logger({ service: "product-integration-core", event: "request", method: req.method, path: String(req.url || "").split("?")[0].slice(0, 160), status, duration_ms: now() - started, correlation_id: correlationId });
    }
  };
}

module.exports = { createApp, BASE, HttpError };
