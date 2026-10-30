"use strict";

// Builds and signs the Karryam product manifest. Without an operator-
// provisioned Ed25519 signer there is no manifest: the caller receives an
// honest UNAVAILABLE error. Signed manifests are cached for half their TTL.

const { contracts } = require("../packages");

function createManifestProvider({ config, catalog, now = Date.now }) {
  let cached = null;

  function build(at) {
    return {
      schema: contracts.MANIFEST_SCHEMA,
      product_id: config.productId,
      service_instance_id: config.serviceInstanceId,
      environment: config.environment,
      display_name: "Karryam",
      protocol: { ...contracts.PROTOCOL_VERSION },
      build_sha: config.buildSha,
      manifest_revision: config.manifestRevision,
      issued_at: new Date(at).toISOString(),
      expires_at: new Date(at + config.manifestTtlSeconds * 1000).toISOString(),
      workload_identity: config.workloadIdentity,
      signing_key_id: config.manifestSigner ? config.manifestSigner.kid : "unprovisioned",
      capabilities: catalog.capabilities,
      datasets: catalog.datasets,
      event_families: catalog.event_families,
    };
  }

  return {
    signerProvisioned: Boolean(config.manifestSigner),
    current() {
      if (!config.manifestSigner) throw new contracts.ProtocolError("UNAVAILABLE", "MANIFEST_SIGNER_NOT_PROVISIONED");
      const at = now();
      if (cached && at < cached.refreshAt) return cached.signed;
      const signed = contracts.signManifest(build(at), { privateKey: config.manifestSigner.privateKey, kid: config.manifestSigner.kid });
      cached = { signed, refreshAt: at + (config.manifestTtlSeconds * 1000) / 2 };
      return signed;
    },
  };
}

module.exports = { createManifestProvider };
