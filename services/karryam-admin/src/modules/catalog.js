"use strict";

// Karryam Admin module catalog (Section 6). Every module is a view over the
// pinned Bridge registry: its collections are exact Bridge capabilities, so
// no module can invent a route, a field or a business rule. Each Bridge
// capability belongs to exactly one inventory module (no double counting);
// a module may additionally serve a few related capabilities owned by
// another module (e.g. the HQ support queue in Support).
//
// Exposure states are computed, never assumed from the source matrix:
//   source-matrix AVAILABLE is artifact state, not authorization.

const R = require("../bridge/contracts/registry");

const MODULES = Object.freeze([
  { id: "customer", title: "Customer Administration", read: "karryam.customers.read", rules: ["Owner keeps authority over restrictions and account status", "A submitted review never changes account status by itself", "No raw NIN, identity documents or credentials"] },
  { id: "taxi", title: "Taxi Administration", read: "karryam.taxi.read", rules: ["No raw GPS trails", "Driver/vehicle/provider relationships only as returned by the source", "No invented ride, revenue or earnings figures"] },
  { id: "dispatch", title: "Dispatch Administration", read: "karryam.dispatch.read", rules: ["Bridge-only: no direct dispatch database writes", "No fabricated handover approvals", "Legacy Logistics routes stay until parity is certified"] },
  { id: "hauling", title: "Hauling Administration", read: "karryam.hauling.read", rules: ["Historical fit decisions are not current eligibility", "No apply/clear without source-native authority"] },
  { id: "fleet", title: "Corporate Fleet Administration", read: "karryam.fleet.read", rules: ["Strict organization/employer boundaries", "Rider pricing visibility follows Fleet rules"] },
  { id: "vendor", title: "Vendor Administration", read: "karryam.vendor.read", rules: ["Partial cohorts are reported as partial coverage"] },
  { id: "wallet", title: "Wallet and Payments Administration", read: "karryam.wallet.read", rules: ["Minor units per currency; never combined", "Wallet flows are never recognized revenue", "Refunds follow the native request, approval, confirmation chain"] },
  { id: "pricing", title: "Pricing Administration", read: "karryam.pricing.read", rules: ["Pricing mutations are high risk and disabled", "No quote bind, issue or reconcile"] },
  { id: "referral", title: "Referral Administration", read: "karryam.referral.read", rules: ["No synthesized rewards, appeals, campaigns or rankings"] },
  { id: "verification", title: "Verification Administration", read: "karryam.verification.read", rules: ["Automated recommendations are not approvals", "Independent reviewer required", "No fabricated KYC or address evidence"] },
  { id: "support", title: "Support and Safety Administration", read: "karryam.support.read", related: ["hq.support.queue"], rules: ["Consent restrictions and SLA policy preserved", "No message bodies or private locations in HQ feeds"] },
  { id: "media", title: "Media Administration", read: null, rules: ["Scanner status and an access grant are required", "Short-lived single-use delivery; revocation honoured", "Nothing served publicly"] },
  { id: "analytics", title: "Analytics Administration", read: "karryam.analytics.read", rules: ["Small cells are suppressed by the source", "Completeness-dependent metrics are null under partial coverage"] },
  { id: "marketing", title: "Notifications and Marketing Administration", read: "karryam.marketing.read", related: ["hq.campaigns.readback"], rules: ["Consent is rechecked by the source at send time", "LOGGED_ONLY is never delivered", "No invented provider delivery confirmations"] },
  { id: "finance", title: "Finance and Reporting", read: "karryam.finance.read", related: ["hq.finance.report"], rules: ["Exact units, currency, period and accounting meaning", "Wallet movement is never recognized revenue"] },
  { id: "governance", title: "Governance and HQ Operations", read: "karryam.governance.read", rules: ["Signed source policy, staff permissions, feature flags and kill switches all apply", "AVAILABLE in the source matrix never authorizes execution"] },
  { id: "platform", title: "Bridge platform metadata", read: "karryam.operations.overview.read", rules: ["Metadata only; overview/search/entity reads remain blocked at the source"] },
]);

const MODULE_BY_ID = new Map(MODULES.map((m) => [m.id, m]));
const MODULE_BY_READ = new Map(MODULES.filter((m) => m.read).map((m) => [m.read, m]));

const blocker = (code, detail) => ({ code, detail: String(detail).slice(0, 240) });
const BRIDGE_TRUST = blocker("BRIDGE_TRUST_NOT_ENROLLED", "Bridge mTLS identity, HMAC key and staff signing key are not enrolled for this environment");

function sourceBlocker(cap) {
  return blocker("SOURCE_" + cap.matrix_state, cap.blocker || "Source capability is " + cap.matrix_state);
}

// The collections a module serves: its own READ capabilities plus related.
function collectionsOf(module) {
  const own = R.capabilitiesFor(module.id).filter((c) => c.kind === "READ");
  const related = (module.related || []).map((id) => R.capability(id)).filter(Boolean);
  return [...own, ...related];
}

function readExposure(cap, config) {
  if (cap.kind !== "READ") return { state: "NOT_A_READ", blockers: [] };
  if (cap.matrix_state === "BLOCKED_DEPENDENCY" || cap.matrix_state === "DISABLED") return { state: cap.matrix_state, blockers: [sourceBlocker(cap)] };
  if (!config.bridge.enabled) return { state: "BLOCKED_DEPENDENCY", blockers: [BRIDGE_TRUST] };
  if (R.needsZoneTenant(cap) && (!(config.bridge.zones || []).length || !(config.bridge.tenants || []).length)) {
    return { state: "BLOCKED_DEPENDENCY", blockers: [blocker("ZONE_TENANT_NOT_ENROLLED", "No zone/tenant scope is enrolled for this Bridge")] };
  }
  return { state: "READ_ONLY", blockers: [] };
}

function commandExposure(cap, config) {
  const id = "karryam." + cap.id;
  if (cap.matrix_state === "BLOCKED_DEPENDENCY" || cap.matrix_state === "DISABLED") return { state: "DISABLED", blockers: [sourceBlocker(cap)] };
  if (cap.risk === "R3" || cap.risk === "R4") return { state: "DISABLED", blockers: [blocker("HIGH_RISK_CERTIFICATION_REQUIRED", "R3/R4 execution requires separate certification, two-person approval and an approved owner policy")] };
  if (!config.bridge.enabled) return { state: "DISABLED", blockers: [BRIDGE_TRUST] };
  if (!config.enabledCommands.includes(id)) return { state: "DISABLED", blockers: [blocker("COMMAND_NOT_ENABLED", "Not enabled by the operator for this environment; source policy must also approve it")] };
  return { state: "AVAILABLE", blockers: [] };
}

// Closed request schema: the exact Bridge body travels in params.body and is
// validated against the pinned source schema before signing.
const COMMAND_REQUEST_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["body"],
  properties: { body: { type: "object" }, approval_ref: { type: "string", format: "uuid" } },
});

function moduleReadCapability(module, config) {
  const collections = collectionsOf(module);
  const exposures = collections.map((c) => readExposure(c, config));
  const usable = exposures.some((e) => e.state === "READ_ONLY");
  const blockers = usable ? [] : (config.bridge.enabled ? [blocker("NO_READABLE_SOURCE_CAPABILITY", "Every source collection of this module is blocked or disabled at the source")] : [BRIDGE_TRUST]);
  return {
    id: module.read, version: "1.0.0", kind: "READ", state: usable ? "READ_ONLY" : "BLOCKED_DEPENDENCY",
    risk: collections.some((c) => ["R2", "R3", "R4"].includes(c.risk)) ? "R2" : "R1",
    description: (module.title + ": " + collections.length + " source collections via the private Bridge").slice(0, 240),
    datasets: [], blockers, requires_recent_mfa: true, requires_independent_approval: false, request_schema: null,
  };
}

function commandCapability(cap, config) {
  const exposure = commandExposure(cap, config);
  return {
    id: "karryam." + cap.id, version: "1.0.0", kind: "COMMAND", state: exposure.state, risk: cap.risk,
    description: (cap.method + " " + cap.path + " (" + cap.owner + ")").slice(0, 240),
    datasets: [], blockers: exposure.blockers, requires_recent_mfa: true,
    requires_independent_approval: cap.risk === "R3" || cap.risk === "R4",
    request_schema: exposure.state === "AVAILABLE" ? COMMAND_REQUEST_SCHEMA : null,
  };
}

function manifestCapabilities(config) {
  const reads = MODULES.filter((m) => m.read).map((m) => moduleReadCapability(m, config));
  const commands = R.CAPABILITIES.filter((c) => c.kind === "COMMAND" || c.kind === "RETRIEVAL").map((c) => commandCapability(c, config));
  return { reads, commands };
}

// Full 435-entry mapping, served through capability discovery.
function capabilityMap(config) {
  return R.CAPABILITIES.map((cap) => {
    const module = MODULE_BY_ID.get(cap.module);
    const exposure = cap.kind === "READ" ? readExposure(cap, config) : cap.kind === "SYNC" ? { state: "INTERNAL_SYNC_ONLY", blockers: [] } : commandExposure(cap, config);
    return {
      bridge_capability_id: cap.id,
      module: cap.module,
      karryam_capability_id: cap.kind === "READ" ? (module.read || null) : cap.kind === "SYNC" ? null : "karryam." + cap.id,
      kind: cap.kind,
      owner: cap.owner,
      method: cap.method,
      bridge_path: R.BRIDGE_BASE + cap.path,
      permission: cap.permission,
      scope_dimensions: R.needsZoneTenant(cap) ? ["market", "organization", "zone", "tenant"] : ["market", "organization"],
      risk: cap.risk,
      privacy: cap.privacy,
      source_state: cap.matrix_state,
      exposure_state: exposure.state,
      blocker_codes: exposure.blockers.map((b) => b.code),
      source_version_required: cap.source_version_required,
      idempotency_required: cap.idempotency_required,
    };
  });
}

function moduleFor(readCapabilityId) {
  return MODULE_BY_READ.get(readCapabilityId) || null;
}

// A collection must be a READ capability served by this module.
function collectionFor(module, collectionId) {
  return collectionsOf(module).find((c) => c.id === collectionId) || null;
}

module.exports = { MODULES, MODULE_BY_ID, COMMAND_REQUEST_SCHEMA, collectionsOf, readExposure, commandExposure, manifestCapabilities, capabilityMap, moduleFor, collectionFor };
