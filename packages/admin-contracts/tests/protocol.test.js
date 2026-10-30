"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../src");
const T = require("../src/testing");

const signer = T.generateSigner("synthetic-signer-1");
const trust = T.trustEntry(signer, { productId: "synthetic-third" });
const expected = { productId: "synthetic-third", serviceInstanceId: "synthetic-third-test-1", environment: "test", workloadIdentity: "cf://test/product-admin/synthetic-third", signerKid: signer.kid };

test("canonical JSON is key-order independent and rejects non-finite numbers", () => {
  assert.equal(C.canonicalize({ b: 1, a: [true, null, "x"] }), C.canonicalize({ a: [true, null, "x"], b: 1 }));
  assert.equal(C.digestOf({ a: 1 }), C.digestOf({ a: 1 }));
  assert.throws(() => C.canonicalize({ a: Infinity }));
  assert.match(C.digestOf({}), C.DIGEST_PATTERN);
});

test("validator rejects unsupported keywords and unknown properties", () => {
  assert.throws(() => C.compile({ type: "object", oneOf: [] }), /unsupported_schema_keyword/);
  const check = C.compile({ type: "object", additionalProperties: false, properties: { a: { type: "integer" } }, required: ["a"] });
  assert.equal(check({ a: 1 }).valid, true);
  assert.equal(check({ a: 1, b: 2 }).valid, false);
  assert.equal(check({ a: 1.5 }).valid, false);
  assert.equal(check({}).valid, false);
});

test("a valid signed manifest verifies and yields stable digests", () => {
  const signed = T.signedSampleManifest(signer);
  const result = C.verifyManifest(signed, { trustStore: trust, expected });
  assert.equal(result.manifest.product_id, "synthetic-third");
  assert.match(result.manifestDigest, C.DIGEST_PATTERN);
  assert.match(result.catalogDigest, C.DIGEST_PATTERN);
  // Re-issuing the same catalog changes the manifest digest but not the catalog digest.
  const reissued = C.verifyManifest(T.signedSampleManifest(signer, { issuedAt: Date.now() - 500, revision: 2 }), { trustStore: trust, expected });
  assert.notEqual(reissued.manifestDigest, result.manifestDigest);
  assert.equal(reissued.catalogDigest, result.catalogDigest);
});

test("invalid manifest signatures are rejected", () => {
  const signed = T.signedSampleManifest(signer);
  const tampered = structuredClone(signed);
  tampered.manifest.display_name = "Tampered";
  assert.throws(() => C.verifyManifest(tampered, { trustStore: trust, expected }), (e) => e.reason === "SIGNATURE_INVALID");
  const other = T.generateSigner(signer.kid);
  const forged = T.signedSampleManifest(other);
  assert.throws(() => C.verifyManifest(forged, { trustStore: trust, expected }), (e) => e.reason === "SIGNATURE_INVALID");
});

test("expired, not-yet-valid and over-long manifests are rejected", () => {
  const expired = T.signedSampleManifest(signer, { issuedAt: Date.now() - 7200000, ttlMs: 3600000 });
  assert.throws(() => C.verifyManifest(expired, { trustStore: trust, expected }), (e) => e.reason === "MANIFEST_EXPIRED");
  const future = T.signedSampleManifest(signer, { issuedAt: Date.now() + 3600000 });
  assert.throws(() => C.verifyManifest(future, { trustStore: trust, expected }), (e) => e.reason === "MANIFEST_NOT_YET_VALID");
  const long = T.signedSampleManifest(signer, { ttlMs: 30 * 86400000 });
  assert.throws(() => C.verifyManifest(long, { trustStore: trust, expected }), (e) => e.reason === "MANIFEST_VALIDITY_INVALID");
});

test("signer must be approved, enrolled for the product, unexpired and unrevoked", () => {
  const signed = T.signedSampleManifest(signer);
  assert.throws(() => C.verifyManifest(signed, { trustStore: trust, expected: { ...expected, signerKid: "other-kid" } }), (e) => e.reason === "SIGNER_NOT_APPROVED");
  assert.throws(() => C.verifyManifest(signed, { trustStore: {}, expected }), (e) => e.reason === "SIGNER_UNKNOWN");
  assert.throws(() => C.verifyManifest(signed, { trustStore: T.trustEntry(signer, { productId: "synthetic-third", revoked: true }), expected }), (e) => e.reason === "SIGNER_REVOKED");
  assert.throws(() => C.verifyManifest(signed, { trustStore: T.trustEntry(signer, { productId: "synthetic-third", notAfter: Date.now() - 1 }), expected }), (e) => e.reason === "SIGNER_EXPIRED");
  assert.throws(() => C.verifyManifest(signed, { trustStore: T.trustEntry(signer, { productId: "karryam" }), expected }), (e) => e.reason === "SIGNER_SCOPE_MISMATCH");
});

test("cross-product and cross-environment identities are rejected", () => {
  const karryamSigner = T.generateSigner("karryam-kid");
  const signed = T.signedSampleManifest(karryamSigner, { productId: "karryam", serviceInstanceId: "karryam-admin-test-1" });
  const store = T.trustEntry(karryamSigner, { productId: "karryam" });
  // A legitimately signed Karryam manifest cannot be accepted for another product registration.
  assert.throws(() => C.verifyManifest(signed, { trustStore: store, expected: { ...expected, signerKid: "karryam-kid" } }), (e) => ["SIGNER_SCOPE_MISMATCH", "PRODUCT_MISMATCH"].includes(e.reason));
  const staging = T.signedSampleManifest(signer, { environment: "staging" });
  assert.throws(() => C.verifyManifest(staging, { trustStore: trust, expected }), (e) => e.reason === "WORKLOAD_IDENTITY_MISMATCH" || e.reason === "ENVIRONMENT_MISMATCH");
  const wrongInstance = T.signedSampleManifest(signer, { serviceInstanceId: "synthetic-third-rogue" });
  assert.throws(() => C.verifyManifest(wrongInstance, { trustStore: trust, expected }), (e) => e.reason === "INSTANCE_MISMATCH");
});

test("manifests cannot carry endpoint URLs or redirect the connection", () => {
  const body = T.sampleManifest();
  body.endpoint = "https://attacker.example/internal";
  assert.throws(() => C.signManifest(body, { privateKey: signer.privateKey, kid: signer.kid }), (e) => e.reason === "MANIFEST_SCHEMA_INVALID");
  // Even if a product signs extra fields with its own tooling, HQ rejects them.
  const signed = T.signedSampleManifest(signer);
  const injected = structuredClone(signed);
  injected.manifest.callback_url = "http://169.254.169.254/";
  assert.throws(() => C.verifyManifest(injected, { trustStore: trust, expected }), (e) => e.reason === "MANIFEST_SCHEMA_INVALID");
  const lineage = T.sampleManifest();
  lineage.datasets[0].lineage.url = "https://x";
  assert.throws(() => C.signManifest(lineage, { privateKey: signer.privateKey, kid: signer.kid }));
});

test("unapproved protocol versions are rejected", () => {
  const v2 = T.sampleManifest();
  v2.protocol = { major: 2, minor: 0 };
  const signed = C.signManifest(v2, { privateKey: signer.privateKey, kid: signer.kid });
  assert.throws(() => C.verifyManifest(signed, { trustStore: trust, expected }), (e) => e.reason === "PROTOCOL_UNSUPPORTED");
  assert.equal(C.isKnownContractVersion("1.0"), true);
  assert.equal(C.isKnownContractVersion("2.0"), false);
});

test("catalog semantics: blocked capabilities need blockers, digests must match, classification cannot widen", () => {
  const bad = T.sampleManifest();
  bad.capabilities[1].blockers = [];
  assert.throws(() => C.signManifest(bad, { privateKey: signer.privateKey, kid: signer.kid }), (e) => e.reason === "CATALOG_INVALID");
  const drift = T.sampleManifest();
  drift.datasets[0].semantic_grain = "HOUR";
  assert.throws(() => C.signManifest(drift, { privateKey: signer.privateKey, kid: signer.kid }), (e) => e.detail.some((d) => d.startsWith("DATASET_SCHEMA_DIGEST_MISMATCH")));
  const widened = T.sampleManifest({ datasets: [T.sampleDataset({ allowed_fields: [{ name: "rider_phone", type: "string", classification: "RESTRICTED_PII", meaning: "Phone", unit: null }] })] });
  assert.throws(() => C.signManifest(widened, { privateKey: signer.privateKey, kid: signer.kid }), (e) => e.detail.some((d) => d.startsWith("FIELD_EXCEEDS_DATASET_CLASSIFICATION")));
});

test("compatibility: identical, additive and breaking revisions", () => {
  const base = T.sampleManifest();
  assert.equal(C.compareCatalogs(base, base).decision, "IDENTICAL");

  const additive = T.sampleManifest({ datasets: [T.sampleDataset({ version: "1.1.0", allowed_fields: [...T.sampleDataset().allowed_fields, { name: "region_code", type: "string", classification: "INTERNAL", meaning: "Region", unit: null }] })] });
  const add = C.compareCatalogs(base, additive);
  assert.equal(add.decision, "COMPATIBLE_ADDITIVE");
  assert.equal(C.activationDecision(add).allowed, false);
  assert.equal(C.activationDecision(add, { reviewed: true }).allowed, true);

  const noBump = T.sampleManifest({ datasets: [T.sampleDataset({ allowed_fields: [...T.sampleDataset().allowed_fields, { name: "region_code", type: "string", classification: "INTERNAL", meaning: "Region", unit: null }] })] });
  assert.equal(C.compareCatalogs(base, noBump).decision, "BREAKING");

  for (const change of [{ semantic_grain: "HOUR" }, { currency: "USD" }, { scope_dimensions: ["market"] }, { authorized_departments: ["finance"] }, { privacy_class: "CONFIDENTIAL" }]) {
    const next = T.sampleManifest({ datasets: [T.sampleDataset({ version: "1.1.0", ...change })] });
    const result = C.compareCatalogs(base, next);
    assert.equal(result.decision, "BREAKING", JSON.stringify(change));
    assert.equal(C.activationDecision(result, { reviewed: true }).allowed, false);
  }
  const meaning = T.sampleDataset();
  meaning.metrics = meaning.metrics.map((m) => (m.metric_id === "synthetic.gross_value" ? { ...m, definition: "Net value after refunds" } : m));
  assert.equal(C.compareCatalogs(base, T.sampleManifest({ datasets: [T.sampleDataset({ metrics: meaning.metrics })] })).decision, "BREAKING");
  const removed = T.sampleManifest({ datasets: [T.sampleDataset({ dataset_id: "synthetic.other" })] });
  removed.event_families = [];
  assert.ok(C.compareCatalogs(base, removed).changes.some((c) => c.kind === "DATASET_REMOVED"));
});

test("envelopes: honest unavailable data and truthfulness rules", () => {
  const unavailable = C.errorEnvelope({ productId: "karryam", code: "UNAVAILABLE", reason: "SOURCE_NOT_CERTIFIED" });
  assert.equal(unavailable.result, null);
  assert.equal(unavailable.as_of, null);
  assert.equal(unavailable.freshness, "UNKNOWN");
  assert.equal(C.validateEnvelope(unavailable).valid, true);
  assert.throws(() => C.okEnvelope({ productId: "karryam", coverage: "COMPLETE", result: { value: 0 } }), /COVERAGE_WITHOUT_OBSERVATION/);
  assert.throws(() => C.okEnvelope({ productId: "karryam", freshness: "FRESH", result: { value: 0 } }), /FRESHNESS_WITHOUT_OBSERVATION/);
  assert.throws(() => C.okEnvelope({ productId: "karryam", asOf: new Date(Date.now() + 3600000).toISOString(), result: {} }), /OBSERVATION_IN_FUTURE/);
  assert.equal(C.validateEnvelope({ ...unavailable, result: { revenue: 0 } }).valid, false);
});

test("metric observations cannot fabricate zero or observation times", () => {
  const base = { metric_id: "synthetic.gross_value", definition_version: "1.0.0", window_start: "2026-10-01T00:00:00Z", window_end: "2026-10-02T00:00:00Z", unit: "minor_currency", currency: "NGN" };
  assert.deepEqual(C.metricObservationErrors({ ...base, value: 0, value_state: "OBSERVED", coverage: "COMPLETE", observed_at: "2026-10-02T00:05:00Z" }), []);
  assert.ok(C.metricObservationErrors({ ...base, value: 0, value_state: "OBSERVED", coverage: "UNKNOWN", observed_at: null }).length > 0);
  assert.ok(C.metricObservationErrors({ ...base, value: 0, value_state: "UNAVAILABLE", coverage: "NONE", observed_at: null }).includes("UNAVAILABLE_WITH_VALUE"));
  assert.deepEqual(C.metricObservationErrors({ ...base, value: null, value_state: "UNAVAILABLE", coverage: "NONE", observed_at: null }), []);
});

test("endpoint table builds only fixed paths and validates parameters", () => {
  assert.equal(C.endpointPath("manifest"), "/internal/product-admin/v1/manifest");
  assert.equal(C.endpointPath("datasetSnapshots", { datasetId: "a.b" }), "/internal/product-admin/v1/datasets/a.b/snapshots");
  assert.throws(() => C.endpointPath("datasetSnapshots", { datasetId: "../../x" }));
  assert.throws(() => C.endpointPath("datasetSnapshots", { datasetId: "a/b" }));
  assert.throws(() => C.endpointPath("bridge"));
  assert.equal(Object.keys(C.ENDPOINTS).length, 12);
  assert.equal(C.matchEndpoint("GET", "/internal/product-admin/v1/operations/abc").id, "operationGet");
  assert.equal(C.matchEndpoint("GET", "/internal/karryam-admin/v1/capabilities"), null);
});

test("query parsing rejects unknown, duplicate and malformed parameters", () => {
  const spec = { ...C.PAGINATION, dataset_id: { type: "id", required: true } };
  assert.deepEqual(C.parseQuery(new URLSearchParams("dataset_id=a.b"), spec), { dataset_id: "a.b", limit: 50 });
  assert.throws(() => C.parseQuery(new URLSearchParams("dataset_id=a.b&x=1"), spec), (e) => e.reason === "UNKNOWN_PARAMETER");
  assert.throws(() => C.parseQuery(new URLSearchParams("dataset_id=a.b&dataset_id=c.d"), spec), (e) => e.reason === "DUPLICATE_PARAMETER");
  assert.throws(() => C.parseQuery(new URLSearchParams("dataset_id=a.b&limit=1000"), spec), (e) => e.reason === "INVALID_PARAMETER");
  assert.throws(() => C.parseQuery(new URLSearchParams(""), spec), (e) => e.reason === "MISSING_PARAMETER");
});

test("published JSON schemas are in sync with the source definitions", () => {
  for (const name of Object.keys(C.schemas.SCHEMAS)) {
    const file = path.join(__dirname, "..", "schemas", name + ".json");
    assert.ok(fs.existsSync(file), "missing published schema " + name);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), C.schemas.publishedSchema(name), name);
  }
  const openapi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "openapi", "product-admin-protocol-v1.openapi.json"), "utf8"));
  const documented = Object.keys(openapi.paths).sort();
  const fixed = Object.values(C.ENDPOINTS).map((e) => C.BASE_PATH + e.path).sort();
  assert.deepEqual(documented, [...new Set(fixed)].sort());
});

test("compatibility: authorization requirement changes are breaking; unclassified differences never pass as identical", () => {
  const base = T.sampleManifest();
  assert.ok(base.capabilities.length > 0);
  for (const flag of ["requires_recent_mfa", "requires_independent_approval"]) {
    const next = T.sampleManifest();
    next.capabilities = next.capabilities.map((c, i) => (i === 0 ? { ...c, [flag]: !c[flag] } : c));
    const result = C.compareCatalogs(base, next);
    assert.equal(result.decision, "BREAKING", flag);
    assert.ok(result.changes.some((c) => c.kind === "CAPABILITY_AUTHORIZATION_CHANGED"));
    assert.equal(C.activationDecision(result, { reviewed: true }).allowed, false);
  }
  // Lineage-only change is reported for review instead of looking identical.
  const lineage = T.sampleManifest({ datasets: [T.sampleDataset({ lineage: { ...T.sampleDataset().lineage, derivation: "Rebuilt from the approved source export" } })] });
  const lin = C.compareCatalogs(base, lineage);
  assert.equal(lin.decision, "COMPATIBLE_ADDITIVE");
  assert.ok(lin.changes.some((c) => c.kind === "DATASET_LINEAGE_CHANGED"));
  // A difference in a field the comparator does not know is breaking.
  const unknown = T.sampleManifest();
  unknown.capabilities = unknown.capabilities.map((c, i) => (i === 0 ? { ...c, unreviewed_extension: true } : c));
  const unk = C.compareCatalogs(base, unknown);
  assert.equal(unk.decision, "BREAKING");
  assert.ok(unk.changes.some((c) => c.kind === "UNCLASSIFIED_CHANGE"));
});

test("protocol minors newer than this HQ supports are unknown contracts", () => {
  assert.equal(C.isSupportedProtocol({ major: 1, minor: 0 }), true);
  assert.equal(C.isSupportedProtocol({ major: 1, minor: 1 }), false);
  assert.equal(C.isSupportedProtocol({ major: 1, minor: 999 }), false);
  assert.equal(C.isSupportedProtocol({ major: 2, minor: 0 }), false);
  assert.equal(C.isSupportedProtocol({ major: 1, minor: 1 }, { major: 1, minor: 1 }), true);
});

test("operation and audit reads require a staff delegation", () => {
  assert.equal(C.ENDPOINTS.operationGet.auth, "service+delegation");
  assert.equal(C.ENDPOINTS.auditGet.auth, "service+delegation");
  assert.equal(C.ENDPOINTS.operationSubmit.auth, "service+delegation");
});
