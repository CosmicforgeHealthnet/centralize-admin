"use strict";

// Disposable secure CF Meet Admin Bridge for tests. It is NOT a mock
// that answers success: it independently enforces the pinned source
// contract the way the CF Meet Bridge does (signing-profile.md):
//
//   - TLS 1.3 only, client certificate chained to the test CA, exactly one
//     URI SAN equal to the enrolled workload URI, enrolled (not revoked)
//     certificate fingerprint;
//   - exactly one of each auth header; X-Service-Name principal; known,
//     unexpired HMAC key ID; timestamp within 30 s; unique nonce; HMAC v2
//     over the exact URI and body;
//   - Ed25519 JWS with exact header, pinned kid, issuer/audience/product,
//     iat <= nbf <= now < exp, short lifetime, auth_time <= iat, request
//     digest over method/URI/body, unique JTI, non-revoked session, the
//     capability permission, exact scope claims (zone/tenant on every
//     route), an approved role, a purpose from the Bridge's fixed list, and
//     the approval claim on TWO_PERSON capabilities (interface v1 §3.4);
//   - route matching only from the pinned registry; policy and feature
//     gates; JSON responses validated against the pinned result schema
//     before they are sent.
// The HQ event outbox implements the Bridge feed/ACK semantics.

const https = require("node:https");
const { once } = require("node:events");
const { createHash, createHmac, randomUUID, timingSafeEqual, verify } = require("node:crypto");
const R = require("../../src/bridge/contracts/registry");
const X = require("./bridge-fixtures");

const PRINCIPAL = "cosmicforge-hq-cfmeet-admin";
const sha = (b) => createHash("sha256").update(b).digest("hex");

function matchRoute(method, path) {
  for (const cap of R.CAPABILITIES) {
    if (cap.method !== method) continue;
    const names = [];
    const re = new RegExp("^" + R.BRIDGE_BASE.replace(/\//g, "\\/") + cap.path.replace(/\{([a-z_]+)\}/g, (_, n) => { names.push(n); return "([^/]+)"; }).replace(/\//g, "\\/") + "$");
    const m = re.exec(path);
    if (m) return { cap, params: Object.fromEntries(names.map((n, i) => [n, m[i + 1]])) };
  }
  return null;
}

async function startFakeBridge({ pki, workloadUri, staffPublicKey, hmacKeys, issuer = "cosmicforge-hq", audience = "cfmeet-bridge", roles = ["hq.cfmeet.read"], now = Date.now } = {}) {
  const state = {
    requests: [], denials: [], contractViolations: [], nonces: new Set(), jtis: new Set(), revokedSessions: new Set(), revokedFingerprints: new Set(),
    enrolledFingerprints: null, enabled: null, blockedPolicy: new Set(), handlers: {}, outbox: [], consumers: {}, projectionCoverage: "COMPLETE",
    paused: false, usedApprovals: new Set(), datasets: {}, discovery: {},
  };

  function reply(res, status, result, error, extra = {}) {
    const body = { contract_version: "1.0", product: "cfmeet", correlation_id: randomUUID(), as_of: new Date(now()).toISOString(), freshness: error ? "UNAVAILABLE" : (extra.freshness || "LIVE"), result: error ? null : result };
    if (error) body.error = { code: error, message: "Request could not be completed.", retryable: status === 503 && error !== "capability_blocked" };
    if (extra.operationId) body.error.operation_id = extra.operationId;
    res.writeHead(status, { "Content-Type": "application/json", "X-Correlation-ID": body.correlation_id });
    res.end(JSON.stringify(body));
  }

  function deny(res, status, code, why) {
    state.denials.push(why);
    reply(res, status, null, code);
  }

  function authenticate(req, body, cap, query) {
    const peer = req.socket.getPeerCertificate();
    if (!req.socket.authorized || !peer || !peer.raw) return "NO_CLIENT_CERT";
    const uris = String(peer.subjectaltname || "").split(",").map((s) => s.trim()).filter((s) => s.startsWith("URI:"));
    if (uris.length !== 1 || uris[0] !== "URI:" + workloadUri) return "CLIENT_URI_MISMATCH";
    const fp = String(peer.fingerprint256).replace(/:/g, "").toLowerCase();
    if (state.revokedFingerprints.has(fp) || (state.enrolledFingerprints && !state.enrolledFingerprints.has(fp))) return "CLIENT_NOT_ENROLLED";
    for (const h of ["authorization", "x-hq-key-id", "x-service-name", "x-service-signature", "x-service-timestamp", "x-service-signature-version", "x-service-nonce"]) {
      const count = req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === h).length;
      if (count !== 1) return "HEADER_COUNT:" + h;
    }
    const h = req.headers;
    const key = hmacKeys[h["x-hq-key-id"]];
    if (!key || key.expires <= now()) return "HMAC_KEY_UNKNOWN";
    if (h["x-service-name"] !== PRINCIPAL || h["x-service-signature-version"] !== "2") return "HMAC_VERSION_OR_NAME";
    const ts = Number(h["x-service-timestamp"]);
    if (!Number.isInteger(ts) || Math.abs(now() / 1000 - ts) > 30) return "HMAC_STALE";
    const canonical = ["2", PRINCIPAL, req.method, req.url, String(ts), h["x-service-nonce"], sha(body)].join("\n");
    const expected = Buffer.from(createHmac("sha256", key.secret).update(canonical).digest("hex"));
    const supplied = Buffer.from(String(h["x-service-signature"]));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return "HMAC_INVALID";
    const parts = String(h.authorization).replace(/^Bearer /, "").split(".");
    if (parts.length !== 3) return "JWT_MALFORMED";
    let header; let claims;
    try { header = JSON.parse(Buffer.from(parts[0], "base64url")); claims = JSON.parse(Buffer.from(parts[1], "base64url")); } catch { return "JWT_MALFORMED"; }
    if (Object.keys(header).length !== 3 || header.alg !== "EdDSA" || header.typ !== "JWT" || header.kid !== "staff-1") return "JWT_HEADER";
    if (!verify(null, Buffer.from(parts[0] + "." + parts[1]), staffPublicKey, Buffer.from(parts[2], "base64url"))) return "JWT_SIGNATURE";
    const s = Math.floor(now() / 1000);
    if (claims.iss !== issuer || claims.aud !== audience || claims.product !== "cfmeet") return "JWT_AUDIENCE";
    if (!(claims.iat <= claims.nbf && claims.nbf <= s + 1 && s < claims.exp && claims.exp - claims.iat <= 60 && claims.auth_time <= claims.iat)) return "JWT_LIFETIME";
    if (claims.request_digest !== sha([req.method, req.url, "cfmeet", sha(body)].join("\n"))) return "JWT_DIGEST";
    if (state.revokedSessions.has(claims.session_id)) return "SESSION_REVOKED";
    if (state.nonces.has(h["x-service-nonce"]) || state.jtis.has(claims.jti)) return "REPLAY";
    state.nonces.add(h["x-service-nonce"]);
    state.jtis.add(claims.jti);
    if (!claims.permissions.includes(cap.permission)) return "PERMISSION";
    if (!claims.roles.some((r) => roles.includes(r))) return "ROLE";
    if (!claims.market_scopes.includes(query.get("market")) || !claims.organization_scopes.includes(query.get("organization"))) return "SCOPE";
    if (!R.PURPOSES.includes(query.get("purpose"))) return "PURPOSE";
    const approval = approvalCheck(cap, claims);
    if (approval) return approval;
    if (R.needsZoneTenant(cap) && (!Array.isArray(claims.zone_scopes) || !claims.zone_scopes.includes(query.get("zone")) || !Array.isArray(claims.tenant_scopes) || !claims.tenant_scopes.includes(query.get("tenant")))) return "ZONE_SCOPE";
    return { claims };
  }

  // Approval claim rules (same as the CF Meet Bridge, interface v1 §3.4).
  function approvalCheck(cap, claims) {
    const a = claims.approval;
    if (!R.requiresApprovalClaim(cap)) return a === undefined ? null : "APPROVAL_NOT_ALLOWED";
    if (!a || typeof a !== "object") return "APPROVAL_REQUIRED";
    if (a.capability !== cap.id) return "APPROVAL_CAPABILITY";
    if (a.requester_ref !== claims.sub || a.approver_ref === claims.sub) return "APPROVAL_NOT_INDEPENDENT";
    const decided = Date.parse(a.decided_at);
    const expires = Date.parse(a.expires_at);
    if (!(expires > decided) || expires - decided > 43200 * 1000 || expires <= now()) return "APPROVAL_EXPIRED";
    if (!/^[0-9a-f]{64}$/.test(String(a.intent_digest))) return "APPROVAL_DIGEST";
    if (state.usedApprovals.has(a.approval_id)) return "APPROVAL_REUSED";
    state.usedApprovals.add(a.approval_id);
    return null;
  }

  // Bridge feed: global sequence, scope filter where "" matches any.
  function feed(after, limit, scope) {
    const head = state.outbox.length ? state.outbox[state.outbox.length - 1].sequence : 0;
    const matches = (e) => (e.market === "" || e.market === scope.market) && (e.scope.zone === "" || e.scope.zone === scope.zone) && (e.scope.organization === "" || e.scope.organization === scope.organization) && (e.scope.tenant === "" || e.scope.tenant === scope.tenant);
    // forceVisibleTo simulates a Bridge defect that leaks one event into one
    // tenant's feed (used to prove CF Meet Admin's own scope check).
    const events = state.outbox.filter((e) => e.sequence > after && (e.forceVisibleTo === scope.tenant || (!e.forceVisibleTo && matches(e)))).slice(0, limit).map((e) => { const { forceVisibleTo, ...rest } = e; return rest; });
    return { events, next_sequence: events.length ? events[events.length - 1].sequence : after, head_sequence: head, as_of: new Date(now()).toISOString() };
  }

  function defaultResult(cap, q, body, params) {
    const s = JSON.stringify(cap.result_schema);
    const qo = Object.fromEntries(q);
    if (cap.id === "hq.events.feed") return { result: feed(qo.cursor ? Number(qo.cursor) : 0, Number(qo.limit), qo) };
    if (cap.id === "hq.events.ack") {
      const head = state.outbox.length ? state.outbox[state.outbox.length - 1].sequence : 0;
      const prior = state.consumers[body.consumer] || 0;
      if (body.sequence > head || body.sequence < prior) return { status: 409, error: "conflict" };
      state.consumers[body.consumer] = body.sequence;
      return { result: { consumer: body.consumer, acknowledged_sequence: body.sequence } };
    }
    if (cap.id === "hq.projections.status") {
      const head = state.outbox.length ? state.outbox[state.outbox.length - 1].sequence : 0;
      const status = X.projectionStatus({ now: now(), head, coverage: state.projectionCoverage });
      status.consumer_lag = Object.fromEntries(Object.entries(state.consumers).map(([c, acked]) => [c, head - acked]));
      return { result: status };
    }
    if (cap.id === "bridge.capabilities.read") return { result: X.capabilityStates(state.discovery) };
    if (cap.id === "bridge.datasets.read") {
      const spec = state.datasets[params.dataset_id];
      if (!spec) return { status: 404, error: "not_found" };
      return { result: X.datasetSeries(params.dataset_id, qo, typeof spec === "function" ? spec(qo) : spec) };
    }
    if (cap.id === "bridge.health.read" || cap.id === "operations.health.read") return { result: X.health({ now: now() }) };
    if (s.includes("schemas/VerificationCasePage")) return { result: X.verificationCasePage(qo, { now: now(), nextCursor: qo.cursor ? null : "vpage-2" }) };
    if (s.includes("schemas/VerificationCaseDetail")) return { result: X.verificationCaseDetail(qo, params.case_id, { now: now() }) };
    if (s.includes("schemas/Summary")) {
      const finance = cap.module === "finance";
      return { result: X.summary(qo, finance ? X.FINANCE_KEYS : X.MEETING_KEYS, { now: now(), coverage: state.summaryCoverage || "COMPLETE", windowed: R.SHAPE_PARAMS[cap.query_shape].includes("start"),
        unit: finance ? (k) => (k.startsWith("charges_") ? "minor_currency" : "count") : "count", currency: finance ? (k) => (k === "charges_ngn" ? "NGN" : k === "charges_usd" ? "USD" : null) : null }) };
    }
    if (s.includes("schemas/OperationRecord")) return { result: X.operationRecord(Object.values(params)[0], { now: now() }) };
    if (s.includes("schemas/ResourceDetail")) return { result: X.resourceDetail(cap, qo, Object.values(params)[0], { now: now() }) };
    if (s.includes("schemas/ResourcePage")) return { result: X.resourcePage(cap, qo, { now: now(), nextCursor: qo.cursor ? null : "page-2-" + cap.id.length }), freshness: "PARTIAL" };
    return { status: 503, error: "capability_blocked" };
  }

  const server = https.createServer({ cert: pki.serverCert, key: pki.serverKey, ca: pki.ca, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" }, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "https://bridge.local");
      const match = matchRoute(req.method, url.pathname);
      if (!match) return deny(res, 404, "not_found", "ROUTE");
      const { cap } = match;
      const auth = authenticate(req, body, cap, url.searchParams);
      if (typeof auth === "string") return deny(res, auth === "REPLAY" ? 409 : 401, auth === "REPLAY" ? "replay_rejected" : "unauthorized", auth);
      let parsed;
      if (body.length) { try { parsed = JSON.parse(body.toString("utf8")); } catch { return deny(res, 400, "invalid_command", "BODY"); } }
      if (cap.request_body && !R.validateBody(cap, parsed).valid) return deny(res, 400, "invalid_command", "BODY_SCHEMA");
      state.requests.push({ capability: cap.id, method: req.method, url: req.url, claims: auth.claims, body: parsed });
      if (state.paused) { req.socket.destroy(); return undefined; }
      if (state.enabled && !state.enabled.has(cap.id)) return reply(res, 503, null, "capability_blocked");
      if (state.blockedPolicy.has(cap.id)) return reply(res, 503, null, "blocked_policy");
      const handler = state.handlers[cap.id];
      const custom = handler ? await handler({ cap, query: Object.fromEntries(url.searchParams), body: parsed, params: match.params, req, res }) : undefined;
      const out = custom === undefined ? defaultResult(cap, url.searchParams, parsed, match.params) : custom;
      if (out === "HANDLED") return undefined;
      if (out.destroy) { req.socket.destroy(); return undefined; }
      if (out.raw) { res.writeHead(out.status || 200, { "Content-Type": out.contentType || "application/json" }); res.end(out.raw); return undefined; }
      if (out.error) return reply(res, out.status || 503, null, out.error, { operationId: out.operationId });
      const check = R.validateResult(cap, out.result);
      if (!check.valid) { state.contractViolations.push({ capability: cap.id, errors: check.errors.slice(0, 3) }); return reply(res, 503, null, "owner_contract_invalid"); }
      return reply(res, out.status || 200, out.result, null, { freshness: out.freshness });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  let seq = 0;
  function publish(build) {
    seq += 1;
    const event = build(seq);
    state.outbox.push(event);
    return event;
  }

  // A sequence allocated now but committed (made visible) later, like a
  // slow transaction in the Bridge outbox.
  function reserveSequence() { seq += 1; return seq; }
  function commitLate(event) {
    state.outbox.push(event);
    state.outbox.sort((x, y) => x.sequence - y.sequence);
  }

  return { server, port: server.address().port, state, publish, reserveSequence, commitLate, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

// CF Meet Admin bridge configuration pointing at a fake Bridge.
function bridgeConfigFor(pki, port, { staffPrivateKey, hmacSecret, zones = ["lagos-island"], tenants = ["tenant-a"], workloadUri = "cf://test/hq/product-integration-core" } = {}) {
  return {
    enabled: true, hostname: pki.serverName, port, address: "127.0.0.1",
    market: "NG-LAGOS", organization: "cfmeet-ng", acr: "mfa", serviceKid: "svc-1", staffKid: "staff-1",
    issuer: "cosmicforge-hq", audience: "cfmeet-bridge", roleMap: { "cfmeet.ops.viewer": "hq.cfmeet.read" },
    zones, tenants, mfaMaxAgeSeconds: 300, serverFingerprints: [], revokedServerFingerprints: [], clientIdentity: { uri: workloadUri, fingerprint: "0".repeat(64), notAfter: new Date(Date.now() + 86400000).toISOString() },
    serverCa: pki.ca, clientCert: pki.clientCert, clientKey: pki.clientKey, serviceKey: hmacSecret, staffPrivateKey,
  };
}

module.exports = { startFakeBridge, bridgeConfigFor, matchRoute, PRINCIPAL };
