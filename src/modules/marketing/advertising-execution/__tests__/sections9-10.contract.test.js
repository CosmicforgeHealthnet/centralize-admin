const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  REQUIRED_METHODS,
  assertExecutionAdapter,
} = require("../adapters/execution-adapter.interface");
const { DEFAULT_ADAPTERS, createExecutionAdapterRegistry } = require("../adapters/execution-adapter.registry");
const { runContractOperation } = require("../adapters/execution-contract.service");
const {
  createNormalizedResult,
  validateNormalizedResult,
  normalizeContractError,
} = require("../operations/normalized-result");
const {
  createUnavailableCapability,
  capabilityValidationIssues,
} = require("../capabilities/capability-result");
const {
  createCapabilityDiscoveryService,
  validateCapabilityQuery,
} = require("../capabilities/capability-discovery.service");

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function expectCode(code, fn) {
  assert.throws(fn, (error) => error.code === code);
}

function adapter(overrides = {}) {
  return {
    provider: "META",
    metadata: { status: "TEST", apiVersion: "test", writeCapable: false, supportedMethods: REQUIRED_METHODS },
    getCapabilities: async () => ({}),
    validatePlan: async () => ({}),
    buildOperations: async () => [],
    previewOperation: async () => ({ preview: true }),
    executeOperation: async () => ({ executed: true }),
    verifyOperation: async () => ({}),
    compensateOperation: async () => ({}),
    classifyError: async () => ({}),
    ...overrides,
  };
}

test("every registered provider satisfies the normalized eight-method contract", () => {
  for (const registered of Object.values(DEFAULT_ADAPTERS)) {
    assert.equal(assertExecutionAdapter(registered), registered);
    assert.deepEqual(Object.keys(registered).sort(), ["provider", "metadata", ...REQUIRED_METHODS].sort());
  }
});

test("contract validation rejects missing methods and arbitrary public methods", () => {
  const missing = adapter();
  delete missing.verifyOperation;
  assert.throws(() => assertExecutionAdapter(missing), /verifyOperation/);
  assert.throws(() => assertExecutionAdapter(adapter({ arbitraryNativeMutation: () => {} })), /unsupported public members/);
});

test("unknown providers never fall back and write-gated adapters cannot execute", async () => {
  const registry = createExecutionAdapterRegistry({ env: {} });
  expectCode("UNSUPPORTED_PROVIDER", () => registry.get("FACEBOOK"));
  await assert.rejects(registry.get("META").executeOperation({}), (error) => error.code === "EXECUTION_DISABLED");
});

test("dry-run calls previewOperation and never executeOperation", async () => {
  let previews = 0;
  let executions = 0;
  const result = await runContractOperation({
    adapter: adapter({
      previewOperation: async () => { previews += 1; return { preview: true }; },
      executeOperation: async () => { executions += 1; return { executed: true }; },
    }),
    operation: { id: "op" },
    dryRun: true,
  });
  assert.deepEqual(result, { preview: true });
  assert.equal(previews, 1);
  assert.equal(executions, 0);
});

test("normalized success result is persistence-safe", () => {
  const result = createNormalizedResult({
    status: "SUCCEEDED",
    providerRequestId: "req-1",
    nativeResourceId: "resource-1",
    nativeResourceName: "accounts/1/campaigns/2",
    returnedState: { status: "PAUSED" },
  });
  assert.equal(result.outcomeCertain, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.returnedState, { status: "PAUSED" });
});

test("normalized result rejects invalid status and certainty combinations", () => {
  expectCode("INVALID_EXECUTION_PLAN", () => validateNormalizedResult({
    status: "DONE", providerRequestId: null, nativeResourceId: null, nativeResourceName: null,
    retryable: false, outcomeCertain: true, error: null, warnings: [], returnedState: {},
  }));
  expectCode("INVALID_EXECUTION_PLAN", () => createNormalizedResult({ status: "UNKNOWN", outcomeCertain: true, error: { code: "TIMEOUT", category: "NETWORK", message: "unknown", retryable: true } }));
});

test("normalized result rejects secrets, raw bodies and oversized values", () => {
  expectCode("INVALID_EXECUTION_PLAN", () => createNormalizedResult({ status: "SUCCEEDED", returnedState: { accessToken: "secret" } }));
  expectCode("RAW_PROVIDER_PAYLOAD_FORBIDDEN", () => createNormalizedResult({ status: "SUCCEEDED", returnedState: { rawProviderResponse: {} } }));
  expectCode("INVALID_EXECUTION_PLAN", () => createNormalizedResult({ status: "SUCCEEDED", warnings: Array.from({ length: 21 }, (_, index) => `warning-${index}`) }));
  expectCode("INVALID_EXECUTION_PLAN", () => createNormalizedResult({ status: "SUCCEEDED", returnedState: { text: "x".repeat(33000) } }));
});

test("provider exceptions normalize without stack, request config or secret values", () => {
  const error = normalizeContractError({
    code: "AUTH_FAILED",
    category: "AUTH",
    message: "access_token=super-secret authorization:Bearer-secret",
    retryable: false,
    stack: "private-stack",
    config: { headers: { authorization: "secret" } },
  });
  assert.doesNotMatch(JSON.stringify(error), /super-secret|Bearer-secret|private-stack|headers/);
  assert.match(error.message, /<redacted>/);
});

test("unavailable capabilities are explicit and never claim write readiness", () => {
  const capability = createUnavailableCapability({ provider: "META", connectionId: CONNECTION_ID, accountExternalId: "acct-1", reasonCode: "ADAPTER_NOT_IMPLEMENTED" });
  assert.equal(capability.supported, false);
  assert.equal(capability.writeReady, false);
  assert.equal(capability.permissionState, "MISSING");
  assert.equal(capability.dryRunAvailable, false);
  assert.deepEqual(capability.supportedOperationTypes, []);
});

test("unsupported operation and resource produce stable validation issues", () => {
  const capability = createUnavailableCapability({ provider: "META", reasonCode: "DISABLED" });
  const issues = capabilityValidationIssues(capability, { operationType: "CREATE", resourceType: "CAMPAIGN" });
  assert.deepEqual(issues.map((issue) => issue.code), ["CAPABILITY_UNAVAILABLE", "UNSUPPORTED_OPERATION", "UNSUPPORTED_RESOURCE"]);
});

test("capability query validates provider, connection and account context", () => {
  assert.equal(validateCapabilityQuery({ provider: "meta", connectionId: CONNECTION_ID, accountExternalId: "acct-1" }).provider, "META");
  expectCode("INVALID_EXECUTION_PLAN", () => validateCapabilityQuery({ provider: "META", connectionId: "bad", accountExternalId: "acct-1" }));
  expectCode("INVALID_EXECUTION_PLAN", () => validateCapabilityQuery({ provider: "META", connectionId: CONNECTION_ID, accountExternalId: "" }));
});

test("capability discovery selects only safe connection fields and returns structural support with writes disabled", async () => {
  let query;
  const client = { marketing_ad_platform_connections: { findFirst: async (input) => {
    query = input;
    return { id: CONNECTION_ID, platform: "META", accountId: "acct-1", currency: "USD", status: "ACTIVE", requiresReauthorization: false, validationStatus: "LIVE_VALIDATED", connectionMetadata: { accountRole: "ADMIN", oauthScopes: ["ads_management"], editReady: true } };
  } } };
  const result = await createCapabilityDiscoveryService({ client, env: { MARKETING_AD_EXECUTION_META_API_VERSION: "v25.0" } }).resolve({ provider: "META", connectionId: CONNECTION_ID, accountExternalId: "acct-1" });
  assert.equal(result.supported, true);
  assert.equal(result.writeReady, false);
  assert.equal(result.unavailableReason, "GLOBAL_EXECUTION_DISABLED");
  assert.equal(result.permissionState, "AVAILABLE");
  assert.equal(result.operationSupported, true);
  assert.equal(query.select.accessToken, undefined);
  assert.equal(query.select.refreshToken, undefined);
  assert.equal(query.select.encryptedCredentials, undefined);
});

test("missing connection permission is an explicit capability blocker", async () => {
  const client = { marketing_ad_platform_connections: { findFirst: async () => null } };
  const result = await createCapabilityDiscoveryService({ client, env: { MARKETING_AD_EXECUTION_META_API_VERSION: "v25.0" } }).resolve({ provider: "META", connectionId: CONNECTION_ID, accountExternalId: "acct-1" });
  assert.equal(result.unavailableReason, "CONNECTION_NOT_FOUND");
  assert.equal(result.supported, true);
  assert.equal(result.permissionState, "MISSING");
});

test("adapter and contract imports contain no network clients or credential decryption", () => {
  const root = path.resolve(__dirname, "../adapters");
  const source = fs.readdirSync(root).filter((name) => name.endsWith(".js")).map((name) => fs.readFileSync(path.join(root, name), "utf8")).join("\n");
  assert.doesNotMatch(source, /require\(["'](?:axios|googleapis)["']\)|https?\.request|\bfetch\s*\(|decrypt(?:Credential|Token)|encryptedCredentials/);
});
