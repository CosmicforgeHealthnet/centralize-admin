"use strict";

// Product-scoped and platform-scoped actions. Staff tiers (SUPER, EXECUTIVE,
// ADMIN, EMPLOYEE) never appear here: an action is authorized only by an
// explicit, unexpired, unrevoked grant.

const ACTIONS = Object.freeze({
  // Product actions (grant_kind PRODUCT, bound to one product_id)
  "product.view": { kind: "PRODUCT", dataset: false, recentMfaSeconds: null, independentApproval: false },
  "product.manifest.read": { kind: "PRODUCT", dataset: false, recentMfaSeconds: null, independentApproval: false },
  "product.capabilities.read": { kind: "PRODUCT", dataset: false, recentMfaSeconds: 300, independentApproval: false },
  "dataset.list": { kind: "PRODUCT", dataset: false, recentMfaSeconds: null, independentApproval: false },
  "metric.read": { kind: "PRODUCT", dataset: true, recentMfaSeconds: null, independentApproval: false },
  "events.status.read": { kind: "PRODUCT", dataset: false, recentMfaSeconds: null, independentApproval: false },
  "operation.read": { kind: "PRODUCT", dataset: false, recentMfaSeconds: null, independentApproval: false },
  // Protocol 1.1 scoped live reads through a Product Admin to its source.
  // The source bridge requires a recent strong authentication, so HQ asks
  // for MFA within five minutes before delegating.
  "resource.read": { kind: "PRODUCT", dataset: false, recentMfaSeconds: 300, independentApproval: false },
  "report.read": { kind: "PRODUCT", dataset: false, recentMfaSeconds: 300, independentApproval: false },
  // Sensitive future operations: recent MFA and independent approval metadata.
  "operation.submit": { kind: "PRODUCT", dataset: false, recentMfaSeconds: 300, independentApproval: true },

  // Platform actions (grant_kind PLATFORM, no product binding)
  "integration.read": { kind: "PLATFORM", dataset: false, recentMfaSeconds: null, independentApproval: false },
  "integration.request": { kind: "PLATFORM", dataset: false, recentMfaSeconds: 300, independentApproval: false },
  "integration.verify": { kind: "PLATFORM", dataset: false, recentMfaSeconds: 300, independentApproval: false },
  "integration.review": { kind: "PLATFORM", dataset: false, recentMfaSeconds: 300, independentApproval: true },
  "integration.certify": { kind: "PLATFORM", dataset: false, recentMfaSeconds: 300, independentApproval: true },
  "integration.approve": { kind: "PLATFORM", dataset: false, recentMfaSeconds: 300, independentApproval: true },
  "integration.suspend": { kind: "PLATFORM", dataset: false, recentMfaSeconds: 300, independentApproval: false },
  "integration.revoke": { kind: "PLATFORM", dataset: false, recentMfaSeconds: 300, independentApproval: false },
  "integration.grants.manage": { kind: "PLATFORM", dataset: false, recentMfaSeconds: 300, independentApproval: false },
  "integration.subscriptions.manage": { kind: "PLATFORM", dataset: false, recentMfaSeconds: 300, independentApproval: false },
});

function actionPolicy(action) {
  return Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
}

module.exports = { ACTIONS, actionPolicy };
