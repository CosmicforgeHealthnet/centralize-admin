"use strict";

// Section 29 — Security mandatory suite (no raw payload exposure, secret
// scan, host allowlist, JSON limits, transport/RBAC guards). HTTP-level
// authentication/RBAC/rate limiting runs in the Sections 25-28 suites; this
// suite adds recursive forbidden-key response assertions, secret-scanner
// fixture proof, SSRF-hardening coverage and the bounded JSON matrix.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { mapPlanDetail, mapRun, mapOperationDetail, mapDrift, mapPolicy } = require("../execution.response");
const {
  PROVIDER_HOSTS, assertPublicAddress, assertProviderUrl, safeRedirectPolicy, sanitizeHeaders, createNetworkGuard,
} = require("../adapters/provider-network.policy");
const { sanitizeExecutionJson, FIELD_LIMITS } = require("../execution-json.validator");
const { mutationTransport } = require("../execution.routes");

const ROOT = path.join(__dirname, "..", "..", "..", "..", "..");

const FORBIDDEN_RESPONSE_KEYS = [
  "rawrequest", "rawresponse", "rawpayload", "providerpayload", "authorization", "accesstoken",
  "refreshtoken", "developertoken", "credentialenvelope", "signedurl", "uploadtoken",
  "internalfilepath", "leaseowner", "lockowner", "stack", "clientsecret", "apikey", "cookie",
];

function assertNoForbiddenKeys(value, label, pathTrail = label) {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const compact = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
    assert.equal(FORBIDDEN_RESPONSE_KEYS.includes(compact), false, `${pathTrail}.${key} is a forbidden response key`);
    assertNoForbiddenKeys(child, label, `${pathTrail}.${key}`);
  }
}

test("29-SECURITY response mappers recursively expose no raw payloads, tokens, lease owners or stacks", () => {
  const sentinel = "sentinel-secret-value-must-not-appear";
  const plan = {
    id: "plan-1", planNumber: "MEP-1", sourceType: "MANUAL", platform: "META",
    connectionId: "11111111-1111-4111-8111-111111111111", accountExternalId: "act_123",
    name: "Plan", status: "VALIDATED", version: 1, currencyCode: "USD",
    desiredState: { nested: { authorization: sentinel, deep: { accessToken: sentinel } } },
    items: [{ id: "item-1", sequence: 0, operationType: "CREATE", resourceType: "CAMPAIGN", clientReference: "campaign", dependsOnItemIds: [], intent: { refreshToken: sentinel }, beforeState: { developerToken: sentinel }, materialHash: "a".repeat(64), status: "PENDING" }],
    validationIssues: [], validationPackets: [], approvals: [], runs: [], originalCompensations: [], compensationLinks: [],
  };
  const detail = mapPlanDetail(plan);
  assert.equal(JSON.stringify(detail).includes(sentinel), false);
  assertNoForbiddenKeys(detail, "planDetail");

  const run = mapRun({
    id: "run-1", planId: "plan-1", status: "RUNNING", trigger: "MANUAL", approvedPlanVersion: 1,
    approvalFingerprint: "a".repeat(64), submissionKey: "submission-identity-secret",
    summary: { correlationId: "corr-1", rawProviderResponse: sentinel },
    jobs: [{ id: "job-1", runId: "run-1", platform: "META", connectionId: "11111111-1111-4111-8111-111111111111", accountExternalId: "act_123", status: "RUNNING", attemptCount: 1, leaseOwner: sentinel, leaseExpiresAt: new Date() }],
    operations: [{
      id: "op-1", itemId: "item-1", runId: "run-1", status: "SUCCEEDED", outcomeCertainty: "KNOWN_SUCCESS",
      providerOperationKey: "b".repeat(64), idempotencyIdentity: { secret: sentinel },
      normalizedResult: { status: "SUCCEEDED", warnings: [] },
      attempts: [{ id: "attempt-1", number: 1, errorCode: null, errorCategory: null, retryAfterAt: null, retryDecision: { action: "VERIFY" }, startedAt: new Date(), completedAt: new Date(), rawProviderRequest: sentinel }],
      snapshots: [{ id: "snapshot-1", kind: "BEFORE", sequence: 1, hash: "c".repeat(64), capturedAt: new Date(), normalizedState: { uploadToken: sentinel } }],
      reconciliations: [], retryReviews: [],
    }],
    reconciliations: [], reconciliationJobs: [],
  });
  const serializedRun = JSON.stringify(run);
  assert.equal(serializedRun.includes(sentinel), false, "run responses never leak lease owners or raw payloads");
  // The lease owner key itself never appears on job summaries.
  assert.equal(Object.keys(run.jobs[0]).includes("leaseOwner"), false);
  assertNoForbiddenKeys(mapOperationDetail({ id: "op-1", itemId: "item-1", status: "VERIFIED", outcomeCertainty: "KNOWN_SUCCESS", providerOperationKey: "b".repeat(64), attempts: [], snapshots: [], reconciliations: [], retryReviews: [] }), "operationDetail");
  assertNoForbiddenKeys(mapDrift({ id: "drift-1", runId: "run-1", operationId: "op-1", status: "DRIFTED", differences: [], checkedAt: new Date(), acknowledgments: [] }), "drift");
  assertNoForbiddenKeys(mapPolicy({ id: "policy-1", scope: "GLOBAL", key: "execution.enabled", valueType: "BOOLEAN", value: false, enabled: true, version: 1, createdAt: new Date(), updatedAt: new Date() }), "policy");
});

test("29-SECURITY the repository secret scanner runs clean and its rules catch representative secrets", () => {
  const scannerPath = path.join(ROOT, "scripts", "social-operations", "secret-scan.js");
  const source = fs.readFileSync(scannerPath, "utf8");
  // Rule inventory covers the prohibited classes.
  for (const ruleId of ["PRIVATE_KEY_BLOCK", "DATABASE_URL_WITH_PASSWORD", "AUTHORIZATION_BEARER_LITERAL", "HIGH_CONFIDENCE_SECRET_ASSIGNMENT", "CLOUDINARY_URL_WITH_SECRET", "COMMON_TOKEN_PREFIX"]) {
    assert.ok(source.includes(`"${ruleId}"`) || source.includes(ruleId), `secret scanner must keep the ${ruleId} rule`);
  }
  // Extract the actual RULES definitions and prove they match synthetic
  // fixtures. Fixture strings are assembled at runtime so this test file can
  // never itself trip the scanner.
  const start = source.indexOf("const RULES = [");
  const end = source.indexOf("];", start);
  // eslint-disable-next-line no-eval
  const rules = eval(`(${source.slice(start + "const RULES =".length, end + 1)})`);
  const fixtures = {
    PRIVATE_KEY_BLOCK: ["-----BEGIN", "RSA PRIVATE", "KEY-----"].join(" "),
    DATABASE_URL_WITH_PASSWORD: ["postgres", "://scanner-user:", "not-a-real-password-fixture-1234", "@db.internal/app"].join(""),
    AUTHORIZATION_BEARER_LITERAL: ["Authorization: Bearer ", "A1b2".repeat(8)].join(""),
    HIGH_CONFIDENCE_SECRET_ASSIGNMENT: [["refresh", "token"].join("_"), ' = "', "f1x2".repeat(8), '"'].join(""),
    CLOUDINARY_URL_WITH_SECRET: ["cloudinary", "://123456:", "fixture-secret-value-123", "@cloudname"].join(""),
    COMMON_TOKEN_PREFIX: ["ghp", `${"A1b2".repeat(6)}xyz`].join("_"),
  };
  for (const rule of rules) {
    assert.ok(rule.pattern.test(fixtures[rule.id]), `${rule.id} must detect its synthetic fixture`);
  }
  // The scanner itself runs clean over the working tree and prints no secret values.
  const output = execFileSync(process.execPath, [scannerPath], { cwd: ROOT, encoding: "utf8" });
  assert.match(output, /status=ok|findings=0|secret-scan/i);
  for (const fixture of Object.values(fixtures)) assert.equal(output.includes(fixture), false);
});

test("29-SECURITY provider host allowlist blocks private ranges, redirects, downgrades and credentials", () => {
  // Approved hosts pass; everything else is rejected.
  assert.equal(assertProviderUrl("META", "https://graph.facebook.com/v25.0/act_1").hostname, "graph.facebook.com");
  assert.throws(() => assertProviderUrl("META", "https://evil.example/graph"), (error) => error.errors[0].reasonCode === "UNAPPROVED_PROVIDER_ENDPOINT");
  // Protocol downgrade, embedded credentials, non-443 ports and IP literals fail.
  assert.throws(() => assertProviderUrl("META", "http://graph.facebook.com/"), (error) => error.errors[0].reasonCode === "UNAPPROVED_PROVIDER_ENDPOINT");
  assert.throws(() => assertProviderUrl("META", "https://user:pass@graph.facebook.com/"), (error) => error.errors[0].reasonCode === "UNAPPROVED_PROVIDER_ENDPOINT");
  assert.throws(() => assertProviderUrl("META", "https://graph.facebook.com:8443/"), (error) => error.errors[0].reasonCode === "UNAPPROVED_PROVIDER_ENDPOINT");
  assert.throws(() => assertProviderUrl("META", "https://127.0.0.1/"), (error) => error.errors[0].reasonCode === "UNAPPROVED_PROVIDER_ENDPOINT");
  // DNS answers with private, loopback, link-local or reserved addresses are rejected.
  for (const address of ["127.0.0.1", "10.0.0.5", "172.16.1.1", "192.168.1.9", "169.254.0.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1"]) {
    assert.throws(() => assertPublicAddress(address, "META"), (error) => error.errors[0].reasonCode === "PRIVATE_OR_RESERVED_ADDRESS_FORBIDDEN", address);
  }
  assert.equal(assertPublicAddress("157.240.1.1", "META"), "157.240.1.1");
  // Redirects to another origin (including private hosts) are forbidden.
  assert.throws(() => safeRedirectPolicy("META", "https://graph.facebook.com/a", "https://evil.example/b"), (error) => error.errors[0].reasonCode === "UNAPPROVED_PROVIDER_ENDPOINT");
  assert.throws(() => safeRedirectPolicy("LINKEDIN", "https://api.linkedin.com/rest/a", "https://www.linkedin.com/b"), (error) => error.errors[0].reasonCode === "CROSS_ORIGIN_REDIRECT_FORBIDDEN");
  // Hop-by-hop and forwarding headers are stripped so Authorization can never
  // leak to a changed origin through proxy semantics.
  const headers = sanitizeHeaders({ Authorization: "Bearer safe", Host: "evil.example", "X-Forwarded-Host": "evil.example", "Proxy-Authorization": "x", Connection: "keep-alive", "X-Header": "a\r\nInjected: b" });
  assert.deepEqual(Object.keys(headers), ["Authorization", "X-Header"]);
  assert.equal(headers["X-Header"].includes("\r"), false);
  // Every provider allowlist is exact and non-empty.
  for (const [provider, hosts] of Object.entries(PROVIDER_HOSTS)) assert.ok(hosts.length >= 1, provider);
});

test("29-SECURITY the network guard enforces redirect, response-size and timeout bounds on real requests", async () => {
  const guard = createNetworkGuard({ provider: "META", timeoutMs: 5000, maximumResponseBytes: 1024 });
  const options = guard.requestOptions({ url: "https://graph.facebook.com/v25.0/act_1", timeout: 999999, maxContentLength: 999999999 });
  assert.equal(options.maxRedirects, 0);
  assert.equal(options.proxy, false);
  assert.equal(options.timeout <= 10000, true);
  assert.equal(options.maxContentLength <= 1024, true);
  assert.equal(typeof options.lookup, "function", "the guarded DNS lookup is always installed");
  // Redirect responses fail closed instead of being followed.
  await assert.rejects(guard.request({ request: async () => ({ status: 302, headers: { location: "https://evil.example/" } }) }, { url: "https://graph.facebook.com/v25.0/act_1" }), (error) => error.errors[0].reasonCode === "PROVIDER_REDIRECT_FORBIDDEN");
  // Oversized responses fail closed.
  await assert.rejects(guard.request({ request: async () => ({ status: 200, headers: { "content-length": "999999" } }) }, { url: "https://graph.facebook.com/v25.0/act_1" }), (error) => error.errors[0].reasonCode === "PROVIDER_RESPONSE_TOO_LARGE");
  // A custom scanner-style allowlist works the same way and requires hosts.
  assert.throws(() => createNetworkGuard({ allowedHosts: [], subject: "SCANNER" }), (error) => error.errors[0].reasonCode === "PROVIDER_HOST_ALLOWLIST_REQUIRED");
  const scannerGuard = createNetworkGuard({ allowedHosts: ["scanner.internal.example"], subject: "SCANNER" });
  assert.throws(() => scannerGuard.assertUrl("https://other.example/scan"), (error) => error.errors[0].reasonCode === "UNAPPROVED_PROVIDER_ENDPOINT");
});

test("29-SECURITY bounded JSON rejects oversize, depth, arrays, keys, strings, prototypes and executables", () => {
  // Byte bound per persisted field.
  assert.equal(FIELD_LIMITS.desiredState, 64 * 1024);
  assert.throws(() => sanitizeExecutionJson({ text: "a".repeat(70 * 1024) }, "desiredState"), (error) => error.code === "INVALID_EXECUTION_PLAN");
  // Depth bound: a chain deeper than 6 levels fails; a shallow one passes.
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
  assert.throws(() => sanitizeExecutionJson(deep, "intent"), (error) => error.errors[0].reasonCode === "UNSAFE_OR_OVERSIZED_JSON");
  assert.deepEqual(sanitizeExecutionJson({ a: { b: 1 } }, "intent"), { a: { b: 1 } });
  // Array and key-count bounds.
  assert.throws(() => sanitizeExecutionJson({ list: Array.from({ length: 500 }, (_, index) => index) }, "intent"), (error) => error.errors[0].reasonCode === "UNSAFE_OR_OVERSIZED_JSON");
  assert.throws(() => sanitizeExecutionJson(Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`key${index}`, index])), "intent"), (error) => error.errors[0].reasonCode === "UNSAFE_OR_OVERSIZED_JSON");
  // String bound.
  assert.throws(() => sanitizeExecutionJson({ text: "b".repeat(5000) }, "intent"), (error) => error.errors[0].reasonCode === "UNSAFE_OR_OVERSIZED_JSON");
  // Prototype-pollution keys.
  assert.throws(() => sanitizeExecutionJson(JSON.parse('{"__proto__":{"polluted":true}}'), "intent"), (error) => error.code === "INVALID_EXECUTION_PLAN");
  // Credential-like nested keys and raw provider fields.
  assert.throws(() => sanitizeExecutionJson({ nested: { credentialEnvelope: { cipher: "x" } } }, "intent"), (error) => error.errors[0].reasonCode === "SECRET_FIELD_FORBIDDEN");
  assert.throws(() => sanitizeExecutionJson({ nested: { rawResponse: {} } }, "intent"), (error) => error.code === "RAW_PROVIDER_PAYLOAD_FORBIDDEN");
  // Executable content in strings.
  assert.throws(() => sanitizeExecutionJson({ text: "<script>alert(1)</script>" }, "intent"), (error) => error.errors[0].reasonCode === "EXECUTABLE_CONTENT_FORBIDDEN");
  assert.throws(() => sanitizeExecutionJson({ text: "javascript:alert(1)" }, "intent"), (error) => error.errors[0].reasonCode === "EXECUTABLE_CONTENT_FORBIDDEN");
});

test("29-SECURITY mutating transport accepts only JSON or multipart and correlation flows stay bounded", () => {
  const request = (contentType) => ({ is: (type) => (type === "multipart/form-data" ? contentType === "multipart/form-data" : contentType === "application/json") });
  let passed = 0;
  mutationTransport(request("application/json"), null, () => passed++);
  mutationTransport(request("multipart/form-data"), null, () => passed++);
  assert.equal(passed, 2);
  assert.throws(() => mutationTransport(request("text/plain"), null, () => passed++), (error) => error.errors[0].reasonCode === "APPLICATION_JSON_REQUIRED");
  assert.equal(passed, 2);
});
