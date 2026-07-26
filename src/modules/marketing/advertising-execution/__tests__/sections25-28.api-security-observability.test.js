const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createExecutionRouter, mutationTransport } = require("../execution.routes");
const { STABLE_ERROR_DEFINITIONS, executionError } = require("../execution.errors");
const { normalizeProviderError } = require("../adapters/provider-error-normalizer");
const { inspectExecutionInput, assertAllowedKeys } = require("../security/execution-input-sanitizer");
const { pagination, capabilityQuery } = require("../execution.query-validator");
const { createExecutionMetrics, sanitizeExecutionEvent, STRUCTURED_EVENT_NAMES } = require("../execution.observability");
const { EVENT_ALIASES, createExecutionEventsAdapter } = require("../integrations/execution-events.adapter");
const { hasExecutionRole } = require("../execution.authorization");
const { createExecutionHealthService } = require("../execution.health");
const { mapOperationDetail, mapPlanDetail } = require("../execution.response");

const CONTROLLERS = ["getCapabilities", "getPolicies", "updatePolicy", "createPlan", "listPlans", "getPlan", "updatePlan", "deletePlan", "validatePlan", "submitPlan", "approvePlan", "rejectPlan", "revokeApproval", "queuePlan", "cancelPlan", "createCompensation", "listRuns", "getRun", "getOperation", "retryOperation", "listDrift", "acknowledgeDrift", "convertRecommendation", "createCreativePublication", "listCreativePublications", "getHealth"];
const REQUIRED_ROUTES = [
  "GET /capabilities", "GET /policies", "PATCH /policies", "POST /plans", "GET /plans", "GET /plans/:id", "PATCH /plans/:id", "DELETE /plans/:id",
  "POST /plans/:id/validate", "POST /plans/:id/submit", "POST /plans/:id/approve", "POST /plans/:id/reject", "POST /plans/:id/revoke-approval", "POST /plans/:id/queue", "POST /plans/:id/cancel", "POST /plans/:id/create-compensation",
  "GET /runs", "GET /runs/:id", "GET /operations/:id", "POST /operations/:id/retry", "GET /drift", "POST /drift/:id/acknowledge", "POST /recommendations/:id/create-plan", "POST /creatives/:id/publications", "GET /creatives/:id/publications",
];

test("all Section 25 routes are mounted exactly once with authentication, section RBAC, and thin controllers", () => {
  const auth = (_req, _res, next) => next(); auth.kind = "auth";
  const sectionGate = (_module, _section, mode) => { const fn = (_req, _res, next) => next(); fn.sectionMode = mode; return fn; };
  const fineGate = (role) => { const fn = (_req, _res, next) => next(); fn.executionRole = role; return fn; };
  const controller = Object.fromEntries(CONTROLLERS.map((name) => { const fn = (_req, _res) => {}; fn.controllerName = name; return [name, fn]; }));
  const router = createExecutionRouter({ controller, authenticateMiddleware: auth, sectionGate, fineGate });
  assert.equal(router.stack[0].handle.kind, "auth");
  const inventory = router.stack.filter((layer) => layer.route).map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  for (const route of REQUIRED_ROUTES) assert.equal(inventory.filter((entry) => entry === route).length, 1, route);
  const requiredLayers = router.stack.filter((layer) => layer.route && REQUIRED_ROUTES.includes(`${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`));
  for (const layer of requiredLayers) {
    const handlers = layer.route.stack.map((entry) => entry.handle);
    assert.ok(handlers.some((handler) => handler.sectionMode), layer.route.path);
    assert.equal(handlers.filter((handler) => handler.controllerName).length, 1, layer.route.path);
  }
  const fineRoles = {
    "PATCH /policies": "EXECUTION_ADMIN",
    "POST /plans": "AUTHOR",
    "PATCH /plans/:id": "AUTHOR",
    "DELETE /plans/:id": "AUTHOR",
    "POST /plans/:id/validate": "AUTHOR",
    "POST /plans/:id/submit": "AUTHOR",
    "POST /plans/:id/approve": "APPROVER",
    "POST /plans/:id/reject": "APPROVER",
    "POST /plans/:id/revoke-approval": "APPROVER",
    "POST /plans/:id/queue": "AUTHOR",
    "POST /plans/:id/cancel": "AUTHOR",
    "POST /plans/:id/create-compensation": "AUTHOR",
    "POST /operations/:id/retry": "EXECUTION_ADMIN",
    "POST /drift/:id/acknowledge": "EXECUTION_ADMIN",
    "POST /recommendations/:id/create-plan": "AUTHOR",
    "POST /creatives/:id/publications": "AUTHOR",
  };
  for (const [route, role] of Object.entries(fineRoles)) {
    const layer = requiredLayers.find((entry) => `${Object.keys(entry.route.methods)[0].toUpperCase()} ${entry.route.path}` === route);
    assert.ok(layer.route.stack.some((entry) => entry.handle.executionRole === role), `${route} requires ${role}`);
  }
  assert.equal(inventory.filter((entry) => entry === "POST /plans/:id/queue").length, 1);
});

test("exact stable error registry preserves all required HTTP mappings and sanitizes details", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(STABLE_ERROR_DEFINITIONS).map(([code, value]) => [code, value.status])), {
    AD_EXECUTION_DISABLED: 503, EXECUTION_PLAN_CONFLICT: 409, EXECUTION_VALIDATION_FAILED: 422, EXECUTION_APPROVAL_REQUIRED: 409,
    EXECUTION_SELF_APPROVAL_FORBIDDEN: 403, EXECUTION_BUDGET_POLICY_VIOLATION: 422, EXECUTION_CAPABILITY_UNAVAILABLE: 409,
    EXECUTION_PRECONDITION_CHANGED: 409, EXECUTION_PROVIDER_RATE_LIMITED: 429, EXECUTION_PROVIDER_PERMISSION_ERROR: 403,
    EXECUTION_OUTCOME_UNKNOWN: 502, EXECUTION_RECONCILIATION_DRIFT: 409,
  });
  const error = executionError("EXECUTION_VALIDATION_FAILED", { accessToken: "never", nested: { signedUrl: "never", field: "budget" } });
  assert.equal(error.code, "EXECUTION_VALIDATION_FAILED"); assert.equal(error.statusCode, 422); assert.equal(JSON.stringify(error).includes("never"), false);
});

test("provider errors normalize to stable neutral categories without raw bodies", () => {
  assert.equal(normalizeProviderError({ status: 429, code: "quota", response: { headers: { "retry-after": "5" }, data: { accessToken: "never" } } }).code, "EXECUTION_PROVIDER_RATE_LIMITED");
  assert.equal(normalizeProviderError({ status: 403, code: "permission_denied" }).code, "EXECUTION_PROVIDER_PERMISSION_ERROR");
  assert.equal(normalizeProviderError({ code: "TIMEOUT_AFTER_SEND", outcomeCertain: false }).code, "EXECUTION_OUTCOME_UNKNOWN");
  assert.equal(normalizeProviderError({ code: "DRIFT" }).code, "EXECUTION_RECONCILIATION_DRIFT");
});

test("strict DTO security rejects unknown, prototype, credential, raw-provider, executable, and oversized input", () => {
  assert.throws(() => assertAllowedKeys({ expectedVersion: 1, surprise: true }, ["expectedVersion"]), (error) => error.errors[0].reasonCode === "UNKNOWN_FIELD");
  assert.throws(() => inspectExecutionInput(JSON.parse('{"__proto__":{"polluted":true}}')), (error) => error.errors[0].reasonCode === "PROTOTYPE_KEY_FORBIDDEN");
  assert.throws(() => inspectExecutionInput({ nested: { developerToken: "x" } }), (error) => error.errors[0].reasonCode === "CREDENTIAL_FIELD_FORBIDDEN");
  assert.throws(() => inspectExecutionInput({ providerResponse: {} }), (error) => error.code === "RAW_PROVIDER_PAYLOAD_FORBIDDEN");
  assert.throws(() => inspectExecutionInput({ reason: "javascript:alert(1)" }), (error) => error.errors[0].reasonCode === "EXECUTABLE_CONTENT_FORBIDDEN");
  assert.throws(() => inspectExecutionInput({ values: Array.from({ length: 201 }) }), (error) => error.errors[0].reasonCode === "ARRAY_TOO_LARGE");
});

test("pagination and capability queries are bounded and fail closed", () => {
  assert.deepEqual(pagination({ page: "2", limit: "100", sortDirection: "asc" }, ["page", "limit", "sortDirection"]), { page: 2, limit: 100, skip: 100, sortDirection: "asc" });
  assert.throws(() => pagination({ limit: "101" }, ["limit"]), (error) => error.errors[0].reasonCode === "INVALID_INTEGER");
  assert.throws(() => capabilityQuery({ provider: "META", connectionId: "11111111-1111-4111-8111-111111111111" }), (error) => error.errors[0].reasonCode === "CONNECTION_AND_ACCOUNT_REQUIRED_TOGETHER");
});

test("mutating transport accepts JSON or multipart only", () => {
  let nextCalled = false; mutationTransport({ is: (type) => type === "application/json" }, null, () => { nextCalled = true; }); assert.equal(nextCalled, true);
  assert.throws(() => mutationTransport({ is: () => false }, null, () => {}), (error) => error.errors[0].reasonCode === "APPLICATION_JSON_REQUIRED");
});

test("fine-grained roles reuse section grants and SUPER remains an explicit platform override", async () => {
  let where;
  const client = { adminSectionGrant: { findFirst: async (query) => { where = query.where; return { id: "grant" }; } } };
  assert.equal(await hasExecutionRole({ id: "actor", tier: "ADMIN" }, "APPROVER", client), true);
  assert.deepEqual(where.section.in, ["advertising-execution:approver", "advertising-execution:*"]);
  assert.equal(await hasExecutionRole({ id: "super", tier: "SUPER" }, "EMERGENCY_OPERATOR", { adminSectionGrant: { findFirst: async () => { throw new Error("should not query"); } } }), true);
  const serviceSource = fs.readFileSync(path.join(__dirname, "..", "execution.service.js"), "utf8");
  for (const role of ["AUTHOR", "APPROVER", "EXECUTION_ADMIN", "EMERGENCY_OPERATOR"]) {
    assert.match(serviceSource, new RegExp(`authorize\\(actor, "${role}"\\)`), `service must enforce ${role}`);
  }
});

test("structured events use exact names, bounded payloads, and bounded metric labels", async () => {
  assert.equal(STRUCTURED_EVENT_NAMES.length, 10); assert.equal(EVENT_ALIASES.PLAN_VALIDATED, "marketing_execution.plan_validated");
  const metrics = createExecutionMetrics(); metrics.increment("plansTotal", 1, { provider: "META" }); metrics.observe("validationDurationSeconds", 0.25, { provider: "META" });
  assert.throws(() => metrics.increment("plansTotal", 1, { planId: "unbounded" }), /Unbounded/);
  assert.throws(() => metrics.increment("undeclaredMetric", 1), /Unknown advertising execution metric/);
  const logs = []; const events = createExecutionEventsAdapter({ notificationService: null, metrics, structuredLogger: { info: (event) => logs.push(event) } });
  const emitted = await events.emit("PLAN_VALIDATED", { planId: "id", accessToken: "never", nested: { authorizationHeader: "never" } });
  assert.equal(emitted.eventName, "marketing_execution.plan_validated"); assert.equal(JSON.stringify(emitted).includes("never"), false); assert.equal(logs.length, 1);
  assert.equal(sanitizeExecutionEvent({ workerLeaseOwner: "never", ok: true }).workerLeaseOwner, undefined);
});

test("health distinguishes disabled readiness and never exposes credentials or lease owners", async () => {
  const app = { client: { marketingExecutionPlan: { count: async () => 0 }, marketingExecutionJob: { count: async () => 0, findFirst: async () => null }, marketingExecutionReconciliationJob: { count: async () => 0, findFirst: async () => null } }, executionWorker: { isStarted: () => false }, reconciliationWorker: { isStarted: () => false }, adapterRegistry: { capabilities: () => [{ provider: "META", apiVersion: "v25.0", configured: false, accessToken: "never" }] }, metrics: {}, audit: {}, events: {} };
  const result = await createExecutionHealthService({ app, env: {} }).snapshot();
  assert.equal(result.state, "unavailable"); assert.equal(result.ready, false); assert.equal(result.database.schemaAssertion.category, "SCHEMA"); assert.equal(JSON.stringify(result).includes("never"), false);
});

test("response mappers expose bounded evidence and strip secret/raw provider fields", () => {
  const operation = mapOperationDetail({ id: "op", runId: "run", itemId: "item", status: "FAILED", safeToRetry: false, outcomeCertainty: "KNOWN_FAILURE", normalizedResult: { accessToken: "never", status: "FAILED" }, attempts: [{ id: "a", number: 1, normalizedError: { rawResponse: "never" }, retryDecision: { action: "MANUAL_REVIEW", developerToken: "never" }, startedAt: new Date() }], snapshots: [], reconciliations: [], retryReviews: [] });
  assert.equal(JSON.stringify(operation).includes("never"), false);
  const plan = mapPlanDetail({ id: "p", planNumber: "P-1", sourceType: "MANUAL", platform: "META", connectionId: "c", accountExternalId: "a", name: "n", status: "DRAFT", version: 1, currencyCode: "USD", desiredState: { authorization: "never", objective: "CONVERSIONS" }, items: [], approvals: [], runs: [], validationPackets: [], validationIssues: [], originalCompensations: [], compensationLinks: [] });
  assert.equal(JSON.stringify(plan).includes("never"), false);
});

test("controllers remain thin and no Section 25 controller calls provider mutation", () => {
  const controller = fs.readFileSync(path.join(__dirname, "..", "execution.controller.js"), "utf8");
  assert.equal(/executeOperation|previewOperation|providerClients|resolveStoredCredentials/.test(controller), false);
  const routes = fs.readFileSync(path.join(__dirname, "..", "execution.routes.js"), "utf8");
  assert.equal((routes.match(/"\/plans\/:id\/queue"/g) || []).length, 1);
});
