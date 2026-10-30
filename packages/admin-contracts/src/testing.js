"use strict";

// Test-only fixtures. Keys are generated per process and never committed.
// Production and staging trust enrollment never uses anything from here.

const { generateKeyPairSync } = require("node:crypto");
const { withSchemaDigest, standardMetricObservationFamily } = require("./catalog");
const { signManifest } = require("./manifest");

function generateSigner(kid = "test-signer-1") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { kid, privateKey, publicKey };
}

function trustEntry(signer, { productId, environment = "test", notAfter = Date.now() + 86400000, revoked = false }) {
  return { [signer.kid]: { publicKey: signer.publicKey, productId, environment, notAfter, revoked } };
}

function sampleDataset(overrides = {}) {
  return withSchemaDigest({
    dataset_id: "synthetic.daily_activity",
    version: "1.0.0",
    schema_id: "synthetic.daily_activity",
    schema_digest: "sha256:" + "0".repeat(64),
    title: "Daily activity",
    privacy_class: "INTERNAL",
    scope_dimensions: ["market", "organization", "tenant"],
    authorized_departments: ["operations", "analytics"],
    semantic_grain: "DAY",
    units: ["count", "minor_currency"],
    currency: "NGN",
    freshness_target_seconds: 3600,
    lineage: { source_system: "synthetic-source", source_owner: "synthetic-owner", derivation: "Aggregated from synthetic test events" },
    allowed_fields: [
      { name: "metric_id", type: "string", classification: "INTERNAL", meaning: "Metric identifier", unit: null },
      { name: "value", type: "number", classification: "INTERNAL", meaning: "Observed aggregate value", unit: null },
    ],
    metrics: [
      { metric_id: "synthetic.completed_orders", version: "1.0.0", definition: "Count of completed orders in the window", aggregation: "COUNT", grain: "DAY", unit: "count", currency: null },
      { metric_id: "synthetic.gross_value", version: "1.0.0", definition: "Sum of completed order value in minor units", aggregation: "SUM", grain: "DAY", unit: "minor_currency", currency: "NGN" },
    ],
    retention_days: 400,
    readiness: "CERTIFIED_BY_PRODUCT",
    blockers: [],
    ...overrides,
  });
}

function sampleManifest({ productId = "synthetic-third", serviceInstanceId = "synthetic-third-test-1", environment = "test", issuedAt = Date.now() - 1000, ttlMs = 3600000, revision = 1, datasets, capabilities, eventFamilies } = {}) {
  const ds = datasets || [sampleDataset()];
  return {
    schema: "cosmicforge.product-admin.manifest/v1",
    product_id: productId,
    service_instance_id: serviceInstanceId,
    environment,
    display_name: "Synthetic Third Product",
    protocol: { major: 1, minor: 0 },
    build_sha: "0123456789abcdef0123456789abcdef01234567",
    manifest_revision: revision,
    issued_at: new Date(issuedAt).toISOString(),
    expires_at: new Date(issuedAt + ttlMs).toISOString(),
    workload_identity: "cf://" + environment + "/product-admin/" + productId,
    signing_key_id: "placeholder",
    capabilities: capabilities || [
      { id: "synthetic.metrics.read", version: "1.0.0", kind: "READ", state: "READ_ONLY", risk: "R0", description: "Read approved aggregate metrics", datasets: [ds[0].dataset_id], blockers: [], requires_recent_mfa: false, requires_independent_approval: false, request_schema: null },
      { id: "synthetic.order.cancel", version: "1.0.0", kind: "COMMAND", state: "DISABLED", risk: "R3", description: "Cancel an order", datasets: [], blockers: [{ code: "NOT_CERTIFIED", detail: "Command execution is not certified" }], requires_recent_mfa: true, requires_independent_approval: true, request_schema: null },
    ],
    datasets: ds,
    event_families: eventFamilies || [standardMetricObservationFamily({ family: "synthetic.metric_observation", datasetId: ds[0].dataset_id })],
  };
}

function signedSampleManifest(signer, options = {}) {
  return signManifest(sampleManifest(options), { privateKey: signer.privateKey, kid: signer.kid });
}

module.exports = { generateSigner, trustEntry, sampleDataset, sampleManifest, signedSampleManifest };
