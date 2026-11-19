"use strict";

// CF Meet Admin module catalog (Section 6). Every module is a view over the
// pinned Bridge registry: its collections are exact Bridge capabilities, so
// no module can invent a route, a field or a business rule. Each Bridge
// capability belongs to exactly one inventory module (no double counting);
// a module may additionally serve a few related capabilities owned by
// another module (none today for CF Meet).
//
// Exposure states are computed, never assumed from the source matrix:
//   source-matrix AVAILABLE is artifact state, not authorization.

const R = require("../bridge/contracts/registry");

const MODULES = Object.freeze([
  { id: "accounts", title: "Accounts Administration", read: "cfmeet.accounts.read", rules: ["Account status, role and email changes need a second approver", "No credentials, MFA secrets or raw contact details", "Deletion and export follow the privacy pipeline"] },
  { id: "meetings", title: "Meetings Administration", read: "cfmeet.meetings.read", rules: ["No media, transcripts or chat content", "Ending a live meeting or deleting a recording needs a second approver"] },
  { id: "messaging", title: "Messaging Safety Administration", read: "cfmeet.messaging.read", rules: ["End-to-end encrypted content is never readable by HQ", "Holds, exports and deletions need a second approver", "Off-switches are high risk and audited"] },
  { id: "calling", title: "Calling Administration", read: "cfmeet.calling.read", rules: ["No call audio or recordings content", "Limits, spend caps and routing changes need a second approver"] },
  { id: "communications", title: "Communications Profiles Administration", read: "cfmeet.communications.read", rules: ["Profile suspension and restoration need a second approver", "Backfills and replays never resend messages"] },
  { id: "organizations", title: "Organizations Administration", read: "cfmeet.organizations.read", rules: ["Strict organization boundaries", "Ownership recovery is R4 and needs a second approver"] },
  { id: "partners", title: "Partners and Developer Platform", read: "cfmeet.partners.read", rules: ["Key material is never shown, only key metadata", "Workspace state and key revocation need a second approver"] },
  { id: "identity", title: "Identity and Access Administration", read: "cfmeet.identity.read", rules: ["Key rotation and identity removal are R4", "Scopes change only with a second approver"] },
  { id: "apps", title: "Apps Administration", read: "cfmeet.apps.read", rules: ["Suspension and lifting need a second approver"] },
  { id: "verification", title: "Verification Administration", read: "cfmeet.verification.read", rules: ["Shared verification case shape across products", "Automated recommendations are not decisions", "Go-live, review and publish decisions need a second approver"] },
  { id: "pricing", title: "Pricing and Plans Administration", read: "cfmeet.pricing.read", rules: ["Plans start as Free, Pro and Business", "Approve, activate, roll back and freeze need a second approver", "Simulations never change prices"] },
  { id: "finance", title: "Finance Reporting", read: "cfmeet.finance.read", rules: ["Minor units per currency; never combined", "Estimated charges are estimates, not invoices"] },
  { id: "notifications", title: "Notifications Administration", read: "cfmeet.notifications.read", rules: ["No message content", "Routing changes and reroute cancellation need a second approver"] },
  { id: "privacy", title: "Privacy Requests", read: "cfmeet.privacy.read", rules: ["Per-service completion is recorded by each owner", "No personal data in HQ views"] },
  { id: "operations", title: "Operations and Releases", read: "cfmeet.operations.read", rules: ["Switch flips are R4", "Feature switch-on requests need a second approver and are audited"] },
  { id: "audit", title: "CF Meet Audit Search", read: "cfmeet.audit.read", rules: ["One search across CF Meet owner audit; read only"] },
  { id: "telecom", title: "Telecom Summaries", read: "cfmeet.telecom.read", rules: ["Read-only summaries; not released for HQ yet"] },
  { id: "platform", title: "Bridge platform metadata", read: "cfmeet.platform.read", rules: ["Metadata only: discovery, aggregate health, datasets and projection status"] },
]);

const MODULE_BY_ID = new Map(MODULES.map((m) => [m.id, m]));
const MODULE_BY_READ = new Map(MODULES.filter((m) => m.read).map((m) => [m.read, m]));

const blocker = (code, detail) => ({ code, detail: String(detail).slice(0, 240) });
const BRIDGE_TRUST = blocker("BRIDGE_TRUST_NOT_ENROLLED", "Bridge mTLS identity, HMAC key and staff signing key are not enrolled for this environment");
const HIGH_RISK = blocker("HIGH_RISK_CERTIFICATION_REQUIRED", "R3/R4 execution requires a two-reviewer certification for the pinned contract, runtime Bridge availability, recent MFA and an independent approval of the exact intent");

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
  const id = "cfmeet." + cap.id;
  if (cap.matrix_state === "BLOCKED_DEPENDENCY" || cap.matrix_state === "DISABLED") return { state: "DISABLED", blockers: [sourceBlocker(cap)] };
  const high = cap.risk === "R3" || cap.risk === "R4";
  if (!config.bridge.enabled) return { state: "DISABLED", blockers: [BRIDGE_TRUST, ...(high ? [HIGH_RISK] : [])] };
  if (!config.enabledCommands.includes(id)) return { state: "DISABLED", blockers: [blocker("COMMAND_NOT_ENABLED", "Not enabled by the operator for this environment; source policy must also approve it"), ...(high ? [HIGH_RISK] : [])] };
  // R3/R4 (Section 11.3): an operator listing alone is never enough; a
  // two-reviewer certification for the pinned contract must be in force.
  // Execution still needs runtime Bridge availability, recent MFA, an
  // independent approval of the exact intent and the Bridge's own decision.
  if (high && !(config.highRiskCertified || []).includes(id)) return { state: "DISABLED", blockers: [HIGH_RISK] };
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
    id: "cfmeet." + cap.id, version: "1.0.0", kind: "COMMAND", state: exposure.state, risk: cap.risk,
    description: (cap.method + " " + cap.path + " (" + cap.owner + ")").slice(0, 240),
    datasets: [], blockers: exposure.blockers, requires_recent_mfa: true,
    // R3/R4 always, and every Bridge TWO_PERSON capability (Track A matrix).
    requires_independent_approval: cap.risk === "R3" || cap.risk === "R4" || cap.approval === "TWO_PERSON",
    request_schema: exposure.state === "AVAILABLE" ? COMMAND_REQUEST_SCHEMA : null,
  };
}

function manifestCapabilities(config) {
  const reads = MODULES.filter((m) => m.read).map((m) => moduleReadCapability(m, config));
  const commands = R.CAPABILITIES.filter((c) => c.kind === "COMMAND" || c.kind === "RETRIEVAL").map((c) => commandCapability(c, config));
  return { reads, commands };
}

// Full mapping of every pinned Bridge capability, served through capability discovery.
function capabilityMap(config) {
  return R.CAPABILITIES.map((cap) => {
    const module = MODULE_BY_ID.get(cap.module);
    const exposure = cap.kind === "READ" ? readExposure(cap, config) : cap.kind === "SYNC" ? { state: "INTERNAL_SYNC_ONLY", blockers: [] } : commandExposure(cap, config);
    return {
      bridge_capability_id: cap.id,
      module: cap.module,
      cfmeet_capability_id: cap.kind === "READ" ? (module.read || null) : cap.kind === "SYNC" ? null : "cfmeet." + cap.id,
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
