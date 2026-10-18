const test = require("node:test");
const assert = require("node:assert/strict");
const { createNetworkGuard, assertPublicAddress, safeRedirectPolicy } = require("../adapters/provider-network.policy");
const { boundedRetryAfterAt, normalizeProviderError } = require("../adapters/provider-error-normalizer");
const { boundedRetryAfter } = require("../../../../shared/middlewares/error.middleware");
const { SAFE_REQUEST_ID, requestContext } = require("../../../../shared/middlewares/request-context.middleware");
const { REQUIRED_TABLES, REQUIRED_INDEXES, REQUIRED_ENUMS } = require("../execution-schema-assertion.service");
const { NON_OVERRIDABLE_CONTROLS, assertOverrideMatches, createEmergencyOverrideService } = require("../policy/emergency-override.service");
const { createExecutionEventsAdapter } = require("../integrations/execution-events.adapter");
const { createExecutionHealthService } = require("../execution.health");
const { validatePolicyKey } = require("../policy/policy.repository");

test("production network guard enforces endpoint, redirect, headers, DNS hook and response bounds", async () => {
  let captured;
  const guard = createNetworkGuard({ provider: "META", maximumResponseBytes: 4096 });
  const response = await guard.request({ request: async (options) => { captured = options; return { status: 200, headers: { "content-length": "20" }, data: {} }; } }, { method: "get", url: "https://graph.facebook.com/v25.0/me", headers: { Authorization: "Bearer test", Host: "evil.test", "X-Test": "safe\r\nvalue" } });
  assert.equal(response.status, 200); assert.equal(captured.maxRedirects, 0); assert.equal(captured.proxy, false); assert.equal(typeof captured.lookup, "function"); assert.equal(captured.headers.Host, undefined); assert.equal(captured.headers.Authorization, "Bearer test"); assert.equal(captured.headers["X-Test"], "safevalue");
  assert.throws(() => guard.requestOptions({ url: "http://graph.facebook.com/me" }), (error) => error.code === "PROVIDER_CAPABILITY_UNAVAILABLE");
  assert.throws(() => guard.requestOptions({ url: "https://graph.facebook.com:444/me" }), (error) => error.code === "PROVIDER_CAPABILITY_UNAVAILABLE");
  assert.throws(() => safeRedirectPolicy("META", "https://graph.facebook.com/v25.0/me", "https://127.0.0.1/steal"), (error) => error.code === "PROVIDER_CAPABILITY_UNAVAILABLE");
  assert.throws(() => assertPublicAddress("169.254.169.254", "META"), (error) => error.code === "PROVIDER_CAPABILITY_UNAVAILABLE");
  await assert.rejects(guard.request({ request: async () => ({ status: 200, headers: { "content-length": "5000" } }) }, { url: "https://graph.facebook.com/me" }), (error) => error.errors[0].reasonCode === "PROVIDER_RESPONSE_TOO_LARGE");
});

test("provider errors and HTTP Retry-After are stable, bounded and raw-body free", () => {
  const observedAt = new Date("2026-07-23T10:00:00Z");
  assert.equal(boundedRetryAfterAt("60", observedAt).toISOString(), "2026-07-23T10:01:00.000Z");
  assert.equal(boundedRetryAfterAt("999999", observedAt).toISOString(), "2026-07-23T11:00:00.000Z");
  const rate = normalizeProviderError({ status: 429, response: { headers: { "retry-after": "60" }, data: { accessToken: "never" } } }, { provider: "META", observedAt });
  assert.equal(rate.code, "EXECUTION_PROVIDER_RATE_LIMITED"); assert.equal(rate.category, "RATE_LIMIT"); assert.equal(rate.retryAfterAt.toISOString(), "2026-07-23T10:01:00.000Z"); assert.equal(JSON.stringify(rate.errors).includes("never"), false);
  assert.equal(boundedRetryAfter(0), "1"); assert.equal(boundedRetryAfter(999999), "3600");
  assert.equal(normalizeProviderError({ status: 403 }, { provider: "META" }).code, "EXECUTION_PROVIDER_PERMISSION_ERROR");
  assert.equal(normalizeProviderError({ status: 503, outcomeCertain: false }, { provider: "META" }).code, "EXECUTION_OUTCOME_UNKNOWN");
});

test("request correlation accepts only bounded safe identities and otherwise generates UUID", () => {
  assert.equal(SAFE_REQUEST_ID.test("request.safe-1:trace"), true); assert.equal(SAFE_REQUEST_ID.test("bad request"), false);
  const make = (value) => { const headers = {}; const req = { get: () => value }; const res = { locals: {}, setHeader: (key, item) => { headers[key] = item; } }; requestContext(req, res, () => {}); return { req, res, headers }; };
  const inbound = make("request.safe-1:trace"); assert.equal(inbound.req.correlationId, "request.safe-1:trace"); assert.equal(inbound.headers["X-Request-ID"], "request.safe-1:trace");
  const generated = make("unsafe request\nvalue"); assert.match(generated.req.correlationId, /^[0-9a-f-]{36}$/i); assert.notEqual(generated.req.correlationId, "unsafe request\nvalue");
});

test("runtime schema assertion inventory includes all prior and remediation objects", () => {
  assert.equal(REQUIRED_TABLES.length, 25); assert.equal(REQUIRED_INDEXES.length, 20); assert.equal(REQUIRED_ENUMS.length, 7);
  assert.ok(REQUIRED_TABLES.includes("marketing_execution_emergency_overrides")); assert.ok(REQUIRED_INDEXES.includes("IDX_marketing_execution_jobs_cancellation_request"));
});

test("emergency overrides are exact, two-hour bounded, MFA-backed and preserve non-overridable controls", async () => {
  const now = new Date("2026-07-23T10:00:00Z"); const actor = { id: "actor", tier: "SUPER" }; let created;
  const client = { adminUser: { findUnique: async () => ({ id: "actor", tier: "SUPER", status: "ACTIVE", twoFactorEnabled: true }) }, marketingExecutionPlan: { findUnique: async () => ({ id: "plan", platform: "META", connectionId: "connection", accountExternalId: "account" }) }, marketingExecutionRun: { findFirst: async () => null }, marketingProviderOperation: { findFirst: async () => null }, marketingExecutionEmergencyOverride: { create: async ({ data }) => { created = { id: "override", useCount: 0, ...data }; return created; } } };
  const service = createEmergencyOverrideService({ client, now: () => now, events: { emit: async () => {} } });
  const result = await service.create({ actor, input: { planId: "plan", allowedControls: ["CONNECTION_WRITE_GATE"], reason: "Urgent bounded recovery for one approved plan", expiresAt: "2026-07-23T11:00:00Z" } });
  assert.equal(result.scopeType, "PLAN"); assert.equal(created.approvedByAdminUserId, "actor"); assert.equal(created.mfaEvidenceReference, "admin-user-2fa-enabled:actor"); assert.deepEqual(created.nonOverridableControls, [...NON_OVERRIDABLE_CONTROLS]);
  assertOverrideMatches(created, { actor, plan: { id: "plan", platform: "META", connectionId: "connection", accountExternalId: "account" }, now });
  await assert.rejects(service.create({ actor, input: { planId: "plan", allowedControls: ["CONNECTION_WRITE_GATE"], reason: "Urgent bounded recovery for one approved plan", expiresAt: "2026-07-23T13:00:01Z" } }), (error) => error.errors[0].reasonCode === "OVERRIDE_EXPIRY_MUST_BE_WITHIN_TWO_HOURS");
  assert.throws(() => assertOverrideMatches({ ...created, nonOverridableControls: [] }, { actor, plan: { id: "plan", platform: "META", connectionId: "connection", accountExternalId: "account" }, now }), (error) => error.errors[0].reasonCode === "NON_OVERRIDABLE_CONTROLS_INCOMPLETE");
});

test("notifications reuse the existing event adapter and remain bounded", async () => {
  const notifications = []; const adapter = createExecutionEventsAdapter({ structuredLogger: { info: () => {} }, notificationService: { createNotification: async (value) => notifications.push(value) } });
  await adapter.emit("APPROVAL_REQUIRED", { planId: "plan", reason: "Approval needed", accessToken: "never" }, ["actor"]);
  assert.equal(notifications.length, 1); assert.equal(notifications[0].adminUserId, "actor"); assert.equal(JSON.stringify(notifications).includes("never"), false);
});

test("health uses injected full-schema evidence and functional adapter checks", async () => {
  const app = { client: { marketingExecutionJob: { count: async () => 0, findFirst: async () => null }, marketingExecutionReconciliationJob: { count: async () => 0, findFirst: async () => null } }, executionWorker: { isStarted: () => false }, reconciliationWorker: { isStarted: () => false }, adapterRegistry: { capabilities: () => [] }, metrics: { increment: () => {}, snapshot: () => ({}) }, audit: { event: async () => {} }, events: { emit: async () => {} } };
  const result = await createExecutionHealthService({ app, env: {}, schemaAssertion: { inspect: async () => ({ ready: true, category: null, counts: { tables: 25, indexes: 20, enums: 7 } }), invalidate: () => {} } }).snapshot();
  assert.equal(result.state, "disabled"); assert.equal(result.ready, true); assert.equal(result.adapters.audit.functional, true); assert.equal(result.adapters.metrics.functional, true);
});

test("policy registry rejects unknown keys and key-specific invalid values", () => {
  assert.throws(() => validatePolicyKey("unknown.policy", "BOOLEAN", true), (error) => error.errors[0].reasonCode === "UNKNOWN_POLICY_KEY");
  assert.throws(() => validatePolicyKey("approval.required.count", "INTEGER", 99), (error) => error.errors[0].reasonCode === "POLICY_INTEGER_OUT_OF_RANGE");
  assert.deepEqual(validatePolicyKey("creative.destination.domains", "JSON", ["Example.COM", "example.com"]), ["example.com"]);
});
