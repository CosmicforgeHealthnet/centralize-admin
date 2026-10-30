"use strict";

// Server-side Product Admin Protocol v1 kit. Every Product Admin (Karryam,
// HealthNet, future products, the synthetic conformance product) mounts the
// same handler, so routing, service authentication, delegated identity,
// bounded bodies, audit-before-execute and envelope validation are
// implemented exactly once. Product-specific behaviour lives only in the
// `handlers` supplied by each Product Admin.

const { randomUUID } = require("node:crypto");
const C = require("../../admin-contracts");
const I = require("../../identity-and-permissions");
const { verifyServiceRequest, ServiceAuthError } = require("./service-auth");

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const CORRELATION = new RegExp(C.PATTERNS.correlationId);
const SECURITY_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

function defaultLogger(entry) {
  process.stdout.write(JSON.stringify(entry) + "\n");
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) { reject(new C.ProtocolError("PAYLOAD_TOO_LARGE", "BODY_TOO_LARGE")); req.resume(); return; }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new C.ProtocolError("PAYLOAD_TOO_LARGE", "BODY_TOO_LARGE")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => reject(new C.ProtocolError("INVALID_REQUEST", "BODY_ABORTED")));
  });
}

function singleHeader(rawHeaders, name) {
  const values = [];
  for (let i = 0; i < rawHeaders.length; i += 2) if (String(rawHeaders[i]).toLowerCase() === name) values.push(rawHeaders[i + 1]);
  if (values.length > 1) throw new C.ProtocolError("FORBIDDEN", "DUPLICATE_HEADER");
  return values[0];
}

/**
 * options:
 *   productId, serviceInstanceId
 *   serviceKeys          keyId -> { serviceId, key, notAfter, revoked }
 *   allowedServices      service IDs allowed to call (default HQ integration core)
 *   nonceStore           durable { claim(namespace, nonce, expiresAtMs) }
 *   delegationKeys       kid -> { key, notAfter } for cf-product-delegation+jwt
 *   delegationIssuer     default "product-integration-core"
 *   handlers             { [endpointId]: async (ctx) => ({ status?, body }) }
 *   audit                async (record) => void; throwing fails the request closed
 *   logger, now, maxBodyBytes
 */
function createProductAdminHandler(options) {
  const {
    productId, serviceInstanceId, serviceKeys, nonceStore, delegationKeys = {}, handlers, audit,
    allowedServices = ["hq-product-integration-core"], delegationIssuer = "product-integration-core",
    logger = defaultLogger, now = Date.now, maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  } = options;
  if (!new RegExp(C.PATTERNS.productId).test(String(productId))) throw new Error("product_id_invalid");
  if (!new RegExp(C.PATTERNS.serviceInstanceId).test(String(serviceInstanceId))) throw new Error("service_instance_id_invalid");
  if (typeof audit !== "function") throw new Error("audit_required");
  const audience = productId + ":" + serviceInstanceId;

  return async function handler(req, res) {
    const started = now();
    const requestId = randomUUID();
    const supplied = req.headers["x-correlation-id"];
    const correlationId = typeof supplied === "string" && CORRELATION.test(supplied) ? supplied : requestId;
    let endpointId = "unmatched";
    let serviceId = null;
    let status = 500;

    const send = (code, body) => {
      status = code;
      res.writeHead(code, { ...SECURITY_HEADERS, "X-Request-Id": requestId, "X-Correlation-Id": correlationId });
      res.end(JSON.stringify(body));
    };
    const sendError = (err) => {
      const { status: code, body } = C.errorFrom(err, productId, correlationId);
      send(code, body);
    };

    try {
      const raw = String(req.url || "");
      if (!raw.startsWith("/") || raw.startsWith("//") || raw.length > 2048 || /[\\%]/.test(raw.split("?")[0]) || raw.includes("..")) {
        throw new C.ProtocolError("INVALID_REQUEST", "REQUEST_TARGET_INVALID");
      }
      const url = new URL(raw, "http://product-admin.local");
      let pathname = url.pathname;
      if (pathname === "/health/live" || pathname === "/health/ready") pathname = C.BASE_PATH + pathname;
      const match = C.matchEndpoint(req.method, pathname);
      if (!match) throw new C.ProtocolError("NOT_FOUND", "UNKNOWN_ENDPOINT");
      endpointId = match.id;
      if (!match.methodAllowed) throw new C.ProtocolError("METHOD_NOT_ALLOWED", "METHOD_NOT_ALLOWED");
      if (!match.params) throw new C.ProtocolError("INVALID_REQUEST", "PATH_PARAMETER_INVALID");

      let body = Buffer.alloc(0);
      if (req.method === "POST") {
        if (!/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] || ""))) throw new C.ProtocolError("INVALID_REQUEST", "CONTENT_TYPE_REQUIRED");
        body = await readBody(req, maxBodyBytes);
      } else if (Number(req.headers["content-length"] || 0) > 0 || req.headers["transfer-encoding"]) {
        throw new C.ProtocolError("INVALID_REQUEST", "BODY_NOT_ALLOWED");
      }

      const ctx = { endpointId, params: match.params, query: url.searchParams, uri: raw, correlationId, requestId, productId, service: null, delegation: null, body: null, rawBody: body };

      if (match.endpoint.auth !== "none") {
        try {
          ctx.service = await verifyServiceRequest({ rawHeaders: req.rawHeaders, method: req.method, uri: raw, body, keys: serviceKeys, nonceStore: nonceStore && { claim: (svc, nonce, exp) => nonceStore.claim("svc:" + svc, nonce, exp) }, allowedServices, now: now() });
          serviceId = ctx.service.serviceId;
        } catch (err) {
          const reason = err instanceof ServiceAuthError ? err.reason : "SERVICE_AUTH_FAILED";
          logger({ service: productId + "-admin", event: "service_auth_denied", endpoint: endpointId, reason, correlation_id: correlationId });
          if (reason === "REPLAY_STORE_UNAVAILABLE") throw new C.ProtocolError("UNAVAILABLE", "REPLAY_STORE_UNAVAILABLE", { retryable: true });
          throw new C.ProtocolError("UNAUTHENTICATED", "SERVICE_AUTH_FAILED");
        }
        const token = singleHeader(req.rawHeaders, "x-cf-delegation");
        if (token !== undefined || match.endpoint.auth === "service+delegation") {
          if (token === undefined) throw new C.ProtocolError("FORBIDDEN", "DELEGATION_REQUIRED");
          try {
            const claims = I.verifyDelegation(token, { keys: delegationKeys, typ: I.TYPES.PRODUCT, issuer: delegationIssuer, audience, binding: I.requestBinding(req.method, raw, body), now: now() });
            if (claims.product_id !== productId) throw new I.DelegationError("PRODUCT_MISMATCH");
            const fresh = nonceStore && await nonceStore.claim("delegation", claims.jti, claims.exp * 1000);
            if (!fresh) throw new I.DelegationError("REPLAYED");
            ctx.delegation = claims;
          } catch (err) {
            logger({ service: productId + "-admin", event: "delegation_denied", endpoint: endpointId, reason: err.reason || "DELEGATION_INVALID", correlation_id: correlationId });
            throw new C.ProtocolError("FORBIDDEN", "DELEGATION_INVALID");
          }
        }
        // Audit before execution; no audit, no access.
        try {
          await audit({ correlation_id: correlationId, request_id: requestId, endpoint: endpointId, method: req.method, service_id: ctx.service.serviceId, staff_ref: ctx.delegation ? ctx.delegation.sub : null, action: ctx.delegation ? ctx.delegation.action : null, outcome: "ACCESS" });
        } catch {
          logger({ service: productId + "-admin", event: "audit_unavailable", endpoint: endpointId, correlation_id: correlationId });
          throw new C.ProtocolError("UNAVAILABLE", "AUDIT_UNAVAILABLE", { retryable: true });
        }
      }

      const fn = handlers[endpointId];
      if (typeof fn !== "function") throw new C.ProtocolError("UNAVAILABLE", "ENDPOINT_NOT_IMPLEMENTED");
      if (body.length) {
        try { ctx.body = JSON.parse(body.toString("utf8")); } catch { throw new C.ProtocolError("INVALID_REQUEST", "BODY_NOT_JSON"); }
        if (!ctx.body || typeof ctx.body !== "object" || Array.isArray(ctx.body)) throw new C.ProtocolError("INVALID_REQUEST", "BODY_NOT_OBJECT");
      }

      const result = await fn(ctx);
      if (endpointId === "healthLive" || endpointId === "healthReady") return send(result.status || 200, result.body);
      const check = C.validateEnvelope(result.body, { productId, now: now() });
      if (!check.valid) {
        logger({ service: productId + "-admin", event: "invalid_envelope_suppressed", endpoint: endpointId, errors: check.errors.slice(0, 3), correlation_id: correlationId });
        throw new C.ProtocolError("INTERNAL", "INVALID_RESPONSE_SUPPRESSED");
      }
      return send(result.status || (result.body.error ? C.ERROR_CODES[result.body.error.code] : 200), result.body);
    } catch (err) {
      if (!(err instanceof C.ProtocolError)) logger({ service: productId + "-admin", event: "handler_error", endpoint: endpointId, error: err && err.name, correlation_id: correlationId });
      return sendError(err);
    } finally {
      logger({ service: productId + "-admin", event: "request", endpoint: endpointId, status, service_id: serviceId, duration_ms: now() - started, correlation_id: correlationId });
    }
  };
}

module.exports = { createProductAdminHandler, SECURITY_HEADERS };
