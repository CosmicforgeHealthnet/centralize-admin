"use strict";

// Shared CosmicForge protocol packages, consumed by relative path. The
// container image preserves the same packages/ + services/karryam-admin/
// layout, so these paths resolve identically in the repository and at runtime.

module.exports = {
  contracts: require("../../../packages/admin-contracts"),
  clients: require("../../../packages/service-clients"),
  identity: require("../../../packages/identity-and-permissions"),
  events: require("../../../packages/event-contracts"),
};
