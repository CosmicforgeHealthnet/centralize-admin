"use strict";

// CF Meet Product Admin catalog (signed manifest content). Honest states
// only: nothing is advertised as usable unless this service can actually
// perform it in this environment.
//
//   - bridge capability discovery (metadata);
//   - one READ capability per Section 6 module (its collections are exact
//     pinned Bridge READ capabilities; see modules/catalog.js);
//   - one READ capability per Section 11 report;
//   - one COMMAND per pinned Bridge command/retrieval capability (DISABLED
//     unless operator-enabled; R3/R4 always DISABLED pending certification);
//   - the local governance approval commands and the approvals inbox read
//     (cfmeet.governance.read; local records, no source call);
//   - Stage B datasets and their metric-observation event families.

const { bridgeCapabilityState } = require("../bridge/capabilities");
const { manifestCapabilities } = require("../modules/catalog");
const { reportCapabilities } = require("../modules/reports");
const { localCapabilities } = require("../operations/service");
const { governanceReadCapability } = require("../modules/approvals-inbox");
const D = require("../sync/datasets");

const BRIDGE_TRUST = { code: "BRIDGE_TRUST_NOT_ENROLLED", detail: "Bridge mTLS identity, HMAC key and staff signing key are not enrolled for this environment" };

function buildCatalog(config) {
  const bridge = config.bridge;
  const bridgeState = bridgeCapabilityState(bridge);
  const { reads, commands } = manifestCapabilities(config);
  const capabilities = [
    { id: "cfmeet.bridge.capabilities.read", version: "1.0.0", kind: "METADATA", state: bridgeState, risk: "R0", description: "Discover CF Meet Admin Bridge capability states (metadata only)",
      datasets: [], blockers: bridgeState === "READ_ONLY" ? [] : [BRIDGE_TRUST], requires_recent_mfa: true, requires_independent_approval: false, request_schema: null },
    ...reads,
    ...reportCapabilities(config),
    ...commands,
    ...localCapabilities(),
    governanceReadCapability(),
  ];
  const certified = config.certifiedDatasets || [];
  return { capabilities, datasets: D.manifestDatasets(certified), event_families: D.manifestFamilies(certified) };
}

function findCapability(catalog, id) {
  return catalog.capabilities.find((c) => c.id === id) || null;
}

module.exports = { buildCatalog, findCapability };
