"use strict";

// HQ product gateway: browser-facing product APIs backed by the Product
// Integration Core (PIC).
//
//   /api/products/...                        product reads (navigation, manifest, datasets, metrics, ...)
//   /api/admin/product-integrations/...      registry and onboarding administration
//   /api/admin/product-integration-grants/... staff product grants
//
// The gateway authenticates the staff session, then forwards only allowlisted
// route shapes to PIC with a short-lived, request-bound delegation token.
// It never grants or bypasses anything on staff tier: SUPER, EXECUTIVE and
// ADMIN have no implicit product access. PIC authorizes every action against
// explicit product/dataset/scope grants. No client header, body field or URL
// can choose the destination, and no request is forwarded to a product bridge.

const express = require("express");
const ApiError = require("../../shared/utils/ApiError");
const { loadGatewayConfig, createKeyReader } = require("./config");
const { signHqDelegation, requestBinding } = require("./delegation");
const { callPic } = require("./pic-client");

const PIC_BASE = "/internal/pic/v1";
const PRODUCT = "[a-z][a-z0-9-]{1,31}";
const OPAQUE = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DEPT = /^[A-Za-z0-9 _-]{1,64}$/;
const METRIC_QUERY_KEYS = new Set(["window_start", "window_end", "market", "organization", "zone", "tenant", "limit"]);
// Protocol 1.1 scoped reads (product-neutral allowlists; PIC and the
// Product Admin validate every value again).
const RESOURCE_QUERY_KEYS = new Set(["market", "organization", "zone", "tenant", "purpose", "start", "end", "limit", "continuation"]);
const REPORT_QUERY_KEYS = new Set(["market", "organization", "zone", "tenant", "purpose", "start", "end", "timezone", "authority", "product_code"]);
const QUERY_VALUE = /^[A-Za-z0-9._:+-]{1,64}$/;
const SPECIAL_VALUES = { continuation: /^[A-Za-z0-9_-]{16,2048}$/, timezone: /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/ };
const MFA_WINDOW_MS = 5 * 60 * 1000;

const re = (source) => new RegExp("^" + source + "$");
const TRANSITIONS = "verify-identity|validate-contract|review-policy|certify-staging|approve|reject|suspend|revoke|resume-review|health-check|sync";

// [method, pattern relative to the mount, allowsQuery]
const PRODUCT_ROUTES = [
  ["GET", re("/"), false],
  ["GET", re(`/${PRODUCT}/manifest`), false],
  ["GET", re(`/${PRODUCT}/capabilities`), false],
  ["GET", re(`/${PRODUCT}/datasets`), false],
  ["GET", re(`/${PRODUCT}/metrics/${OPAQUE}`), METRIC_QUERY_KEYS],
  ["GET", re(`/${PRODUCT}/resources/${OPAQUE}/${OPAQUE}`), RESOURCE_QUERY_KEYS],
  ["GET", re(`/${PRODUCT}/resources/${OPAQUE}/${OPAQUE}/${OPAQUE}`), RESOURCE_QUERY_KEYS],
  ["GET", re(`/${PRODUCT}/reports/${OPAQUE}`), REPORT_QUERY_KEYS],
  ["GET", re(`/${PRODUCT}/events/status`), false],
  ["GET", re(`/${PRODUCT}/operations/${OPAQUE}`), false],
  ["POST", re(`/${PRODUCT}/operations`), false],
];
const INTEGRATION_ROUTES = [
  ["GET", re("/"), false],
  ["POST", re("/"), false],
  ["GET", re(`/${UUID}`), false],
  ["GET", re(`/${UUID}/monitoring`), false],
  ["POST", re(`/${UUID}/(?:${TRANSITIONS})`), false],
  ["POST", re(`/${UUID}/datasets/${OPAQUE}/approve`), false],
  ["POST", re(`/${UUID}/subscriptions`), false],
  ["POST", re(`/${UUID}/subscriptions/${UUID}/(?:enable|disable)`), false],
  ["POST", re(`/${UUID}/contracts/propose`), false],
  ["POST", re(`/${UUID}/contracts/${UUID}/(?:certify|activate)`), false],
];
const GRANT_ROUTES = [
  ["POST", re("/"), false],
  ["POST", re(`/${UUID}/revoke`), false],
];

const ADMIN_MOUNTS = {
  "/api/admin/product-integrations": { prefix: "/admin/product-integrations", routes: INTEGRATION_ROUTES },
  "/api/admin/product-integration-grants": { prefix: "/admin/product-integration-grants", routes: GRANT_ROUTES },
};

function fail(status, code, message) {
  return new ApiError(status, message, [{ code, retryable: status === 503 }]);
}

function rawQuery(req) {
  const url = String(req.originalUrl || req.url || "");
  const index = url.indexOf("?");
  return index === -1 ? "" : url.slice(index + 1);
}

// Exact allowlisted keys per route, no duplicates, bounded values.
function metricQuery(req, keys = METRIC_QUERY_KEYS) {
  const params = new URLSearchParams(rawQuery(req));
  const seen = new Set();
  const out = new URLSearchParams();
  for (const [key, value] of params) {
    if (!keys.has(key) || seen.has(key)) throw fail(400, "INVALID_QUERY", "Invalid product query");
    if (!(SPECIAL_VALUES[key] || QUERY_VALUE).test(value)) throw fail(400, "INVALID_QUERY", "Invalid product query");
    seen.add(key);
    out.append(key, value);
  }
  const qs = out.toString();
  return qs ? "?" + qs : "";
}

function requireSession(req, _res, next) {
  const session = req.authSession;
  if (!session || !session.id || !Number.isInteger(session.tokenIssuedAt)) {
    return next(fail(403, "SESSION_REQUIRED", "A verified staff session is required"));
  }
  return next();
}

function claimsFor(req, now) {
  const session = req.authSession;
  const iat = Math.floor(now / 1000);
  const mfaMs = session.mfaVerifiedAt ? new Date(session.mfaVerifiedAt).getTime() : NaN;
  const department = typeof req.adminUser.department === "string" && DEPT.test(req.adminUser.department) ? req.adminUser.department : undefined;
  return {
    sub: String(req.adminUser.id),
    sid: String(session.id),
    auth_time: Math.min(session.tokenIssuedAt, iat),
    mfa_at: Number.isFinite(mfaMs) ? Math.floor(mfaMs / 1000) : null,
    // Informational only; PIC never authorizes on tier.
    tier: typeof req.adminUser.tier === "string" ? req.adminUser.tier : undefined,
    dept: department,
  };
}

function createForwarder({ config, readKey, transport, now, call }) {
  return async function forward(req, res, picPath, allowsQuery) {
    if (!config.enabled) throw fail(503, "PRODUCT_INTEGRATION_DISABLED", "Product integration is disabled");
    if (!config.configured || !transport) throw fail(503, "PRODUCT_INTEGRATION_NOT_CONFIGURED", "Product integration is not configured");
    const query = allowsQuery ? metricQuery(req, allowsQuery instanceof Set ? allowsQuery : METRIC_QUERY_KEYS) : "";
    const key = await readKey();
    if (!key) throw fail(503, "PRODUCT_INTEGRATION_NOT_CONFIGURED", "Product integration is not configured");
    const target = PIC_BASE + picPath + query;
    const body = req.method === "POST" ? Buffer.from(JSON.stringify(req.body && typeof req.body === "object" ? req.body : {})) : Buffer.alloc(0);
    const timestamp = now();
    const token = signHqDelegation({ claims: { ...claimsFor(req, timestamp), bnd: requestBinding(req.method, target, body) }, key, kid: config.kid, now: timestamp });
    const headers = { Accept: "application/json", "X-CF-HQ-Delegation": token };
    if (req.correlationId) headers["X-Correlation-Id"] = req.correlationId;
    if (body.length) headers["Content-Type"] = "application/json";
    const result = await call(transport, { method: req.method, path: target, body, headers });
    res.set("Cache-Control", "no-store");
    return res.status(result.status).json(result.json);
  };
}

function match(routes, method, relative) {
  const hit = routes.find(([m, pattern]) => m === method && pattern.test(relative));
  return hit ? { allowsQuery: hit[2] } : null;
}

/**
 * deps: { env, authenticate, requireAuthSchema, requireRecentMfa, transport, now, call, readKey }
 * Returns { productsRouter, adminRouter, config }.
 */
function createProductGateway(deps = {}) {
  const auth = deps.authenticate ? null : require("../../shared/middlewares/auth.middleware");
  const authenticate = deps.authenticate || auth.authenticate;
  const requireAuthSchema = deps.requireAuthSchema || auth.requireAuthSchema;
  const requireRecentMfa = deps.requireRecentMfa || auth.requireRecentMfa;
  const config = loadGatewayConfig(deps.env || process.env);
  const transport = deps.transport || (config.configured ? config.transport : null);
  const now = deps.now || Date.now;
  const readKey = deps.readKey || (config.configured ? createKeyReader(config.keyFile, { now }) : async () => null);
  const forward = createForwarder({ config, readKey, transport, now, call: deps.call || callPic });

  const productsRouter = express.Router();
  productsRouter.use(authenticate, requireAuthSchema, requireSession);
  productsRouter.use(async (req, res, next) => {
    try {
      const relative = req.path;
      const hit = match(PRODUCT_ROUTES, req.method, relative);
      if (!hit) throw fail(404, "NOT_FOUND", "Route not found");
      return await forward(req, res, "/products" + (relative === "/" ? "" : relative), hit.allowsQuery);
    } catch (err) {
      return next(err);
    }
  });

  const adminRouter = express.Router();
  adminRouter.use(authenticate, requireAuthSchema, requireSession, requireRecentMfa(MFA_WINDOW_MS));
  adminRouter.use(async (req, res, next) => {
    try {
      const mount = ADMIN_MOUNTS[req.baseUrl];
      const relative = req.path;
      const hit = mount && match(mount.routes, req.method, relative);
      if (!hit) throw fail(404, "NOT_FOUND", "Route not found");
      return await forward(req, res, mount.prefix + (relative === "/" ? "" : relative), false);
    } catch (err) {
      return next(err);
    }
  });

  return { productsRouter, adminRouter, config };
}

module.exports = { createProductGateway, PRODUCT_ROUTES, INTEGRATION_ROUTES, GRANT_ROUTES, ADMIN_MOUNTS, PIC_BASE };
