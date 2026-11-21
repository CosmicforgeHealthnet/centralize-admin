"use strict";

// HQ product gateway: browser-facing product APIs backed by the Product
// Integration Core (PIC).
//
//   /api/products/...                        product reads (navigation, manifest, datasets, metrics, ...)
//   /api/products/{id}/grants[/{grantId}]    read-only staff grant views (grant managers, recent MFA)
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
// Product Admin validate every value again). `q` (free-text search) and
// `parent` (the parent of a nested list) are list-only; PIC refuses them,
// like limit/continuation, on detail reads.
const RESOURCE_QUERY_KEYS = new Set(["market", "organization", "zone", "tenant", "purpose", "start", "end", "limit", "continuation", "q", "parent"]);
const REPORT_QUERY_KEYS = new Set(["market", "organization", "zone", "tenant", "purpose", "start", "end", "timezone", "authority", "product_code"]);
// Read-only grant listing: optional staff filter, bounded page, opaque cursor
// (PIC enforces limit 1..100 and validates the cursor again).
const GRANT_QUERY_KEYS = new Set(["staff_id", "limit", "cursor"]);
const QUERY_VALUE = /^[A-Za-z0-9._:+-]{1,64}$/;
const SPECIAL_VALUES = { continuation: /^[A-Za-z0-9_-]{16,2048}$/, timezone: /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/, staff_id: /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/, cursor: /^[A-Za-z0-9_-]{16,256}$/,
  // Same patterns as packages/admin-contracts READ_QUERY_SCHEMAS.
  q: /^[\p{L}\p{N} ._@:-]{1,128}$/u, parent: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ };
const MFA_WINDOW_MS = 5 * 60 * 1000;

const re = (source) => new RegExp("^" + source + "$");
const TRANSITIONS = "verify-identity|validate-contract|review-policy|certify-staging|approve|reject|suspend|revoke|resume-review|health-check|sync";

// [method, pattern relative to the mount, allowsQuery, options]
// options.recentMfa: the gateway also requires an MFA step-up within
// MFA_WINDOW_MS before forwarding (same rule as the admin routes).
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
  ["GET", re(`/${PRODUCT}/operations/${OPAQUE}/audit`), false],
  ["POST", re(`/${PRODUCT}/operations`), false],
  // Read-only grant views. They mirror grant administration: PIC requires
  // the platform permission integration.grants.manage (the one that creates
  // and revokes grants) and only ever returns grants of the product in the URL.
  ["GET", re(`/${PRODUCT}/grants`), GRANT_QUERY_KEYS, { recentMfa: true }],
  ["GET", re(`/${PRODUCT}/grants/${UUID}`), false, { recentMfa: true }],
  // Sensitive search (an email address or other contact identifier as q):
  // the query travels in the JSON body, so it never appears in a URL that the
  // edge proxy's access or error log records. Forwarded to PIC as the same
  // validated GET read (PIC logs paths only).
  ["POST", re(`/${PRODUCT}/resources/${OPAQUE}/${OPAQUE}/search`), false, { searchBody: true }],
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
  ["POST", re(`/${UUID}/operations/(?:enable|disable)`), false],
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

// A search term that looks like a contact identifier (an email address, or a
// phone number: 7+ digits once separators are removed) must never be in a URL
// (edge proxy logs record request lines): use the POST .../search route.
const isContactLike = (v) => v.includes("@") || v.replace(/[\s._:-]/g, "").replace(/[^0-9]/g, "").length >= 7;

// Exact allowlisted keys per route, no duplicates, bounded values.
function checkedQuery(entries, keys) {
  const seen = new Set();
  const out = new URLSearchParams();
  for (const [key, value] of entries) {
    if (!keys.has(key) || seen.has(key)) throw fail(400, "INVALID_QUERY", "Invalid product query");
    if (typeof value !== "string" || !(SPECIAL_VALUES[key] || QUERY_VALUE).test(value)) throw fail(400, "INVALID_QUERY", "Invalid product query");
    seen.add(key);
    out.append(key, value);
  }
  const qs = out.toString();
  return qs ? "?" + qs : "";
}

function metricQuery(req, keys = METRIC_QUERY_KEYS) {
  const entries = [...new URLSearchParams(rawQuery(req))];
  if (keys === RESOURCE_QUERY_KEYS && entries.some(([k, v]) => k === "q" && isContactLike(v))) {
    throw fail(400, "SENSITIVE_SEARCH_REQUIRES_POST", "Search by contact identifier with POST .../search; it must not appear in a URL");
  }
  return checkedQuery(entries, keys);
}

// POST .../search body -> the same allowlisted resource query (q required).
function searchBodyQuery(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "INVALID_QUERY", "Invalid product query");
  const entries = Object.entries(body).map(([k, v]) => [k, Number.isInteger(v) && k === "limit" ? String(v) : v]);
  if (!entries.some(([k]) => k === "q")) throw fail(400, "INVALID_QUERY", "Invalid product query");
  return checkedQuery(entries, RESOURCE_QUERY_KEYS);
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
  // override: { method, query } forwards a POST .../search as the equivalent GET read.
  return async function forward(req, res, picPath, allowsQuery, override = null) {
    if (!config.enabled) throw fail(503, "PRODUCT_INTEGRATION_DISABLED", "Product integration is disabled");
    if (!config.configured || !transport) throw fail(503, "PRODUCT_INTEGRATION_NOT_CONFIGURED", "Product integration is not configured");
    const query = override ? override.query : allowsQuery ? metricQuery(req, allowsQuery instanceof Set ? allowsQuery : METRIC_QUERY_KEYS) : "";
    const key = await readKey();
    if (!key) throw fail(503, "PRODUCT_INTEGRATION_NOT_CONFIGURED", "Product integration is not configured");
    const target = PIC_BASE + picPath + query;
    const method = override ? override.method : req.method;
    const body = method === "POST" ? Buffer.from(JSON.stringify(req.body && typeof req.body === "object" ? req.body : {})) : Buffer.alloc(0);
    const timestamp = now();
    const token = signHqDelegation({ claims: { ...claimsFor(req, timestamp), bnd: requestBinding(method, target, body) }, key, kid: config.kid, now: timestamp });
    const headers = { Accept: "application/json", "X-CF-HQ-Delegation": token };
    if (req.correlationId) headers["X-Correlation-Id"] = req.correlationId;
    if (body.length) headers["Content-Type"] = "application/json";
    const result = await call(transport, { method, path: target, body, headers });
    res.set("Cache-Control", "no-store");
    return res.status(result.status).json(result.json);
  };
}

function match(routes, method, relative) {
  const hit = routes.find(([m, pattern]) => m === method && pattern.test(relative));
  return hit ? { allowsQuery: hit[2], recentMfa: Boolean(hit[3] && hit[3].recentMfa), searchBody: Boolean(hit[3] && hit[3].searchBody) } : null;
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

  const recentMfa = requireRecentMfa(MFA_WINDOW_MS);
  const stepUp = (req, res) => new Promise((resolve, reject) => recentMfa(req, res, (err) => (err ? reject(err) : resolve())));
  const productsRouter = express.Router();
  productsRouter.use(authenticate, requireAuthSchema, requireSession);
  productsRouter.use(async (req, res, next) => {
    try {
      const relative = req.path;
      const hit = match(PRODUCT_ROUTES, req.method, relative);
      if (!hit) throw fail(404, "NOT_FOUND", "Route not found");
      if (hit.recentMfa) await stepUp(req, res);
      if (hit.searchBody) return await forward(req, res, "/products" + relative.replace(/\/search$/, ""), false, { method: "GET", query: searchBodyQuery(req.body) });
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

module.exports = { createProductGateway, PRODUCT_ROUTES, INTEGRATION_ROUTES, GRANT_ROUTES, GRANT_QUERY_KEYS, ADMIN_MOUNTS, PIC_BASE };
