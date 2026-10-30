"use strict";

// Pinned, reviewed Karryam Backoffice Bridge contract metadata. Drift is
// detected by recomputing these hashes against a KarryGo checkout (see the
// contract test); this file is never updated automatically.

const pinned = require("./karrygo-backoffice-v1.json");

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const PINNED_BRIDGE_CONTRACT = deepFreeze(JSON.parse(JSON.stringify(pinned)));

function bridgeContractSummary() {
  return {
    contract: PINNED_BRIDGE_CONTRACT.contract,
    contract_version: PINNED_BRIDGE_CONTRACT.contract_version,
    source_commit: PINNED_BRIDGE_CONTRACT.source_commit,
    artifact_sha256: { ...PINNED_BRIDGE_CONTRACT.artifacts },
    capability_matrix: { total: PINNED_BRIDGE_CONTRACT.capability_matrix.total, by_state: { ...PINNED_BRIDGE_CONTRACT.capability_matrix.by_state } },
    authorization_rule: PINNED_BRIDGE_CONTRACT.authorization_rule,
  };
}

module.exports = { PINNED_BRIDGE_CONTRACT, bridgeContractSummary };
