"use strict";

// HQ-side DRAFT of the CF Meet Admin Bridge contract (interface v1, as agreed
// with Track A on 2026-11-19; see docs/product-admin/cfmeet-admin-parallel-workplan.md §3).
//
// This is NOT the CF Meet contract. It lets HQ build and test cfmeet-admin
// before Track A publishes A0. It models the agreed wire format and the
// TARGET end state (realistic result schemas, some AVAILABLE commands) so the
// governed pipeline can be tested. cfmeet-admin refuses to enable the Bridge
// in staging/production while a DRAFT contract is pinned.
//
//   node contract-draft/build-draft.js          # writes the fake checkout
//   CFMEET_CHECKOUT=contract-draft node scripts/pin-bridge-contract.js --write
//
// Output layout mirrors the cfmeet repo: services/admin-bridge/docs/contract/.

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const BASE = "/internal/cfmeet-admin/v1";
const OUT = path.join(__dirname, "services", "admin-bridge", "docs", "contract");
const VERSION = "1.0.0";

const OPAQUE = "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$";
const SEGMENT = "^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$";
const opaque = { type: "string", pattern: OPAQUE, maxLength: 128 };
const time = { type: "string", format: "date-time" };
const ref = (name) => ({ $ref: "#/components/schemas/" + name });

// Agreed closed query shapes (exact order is signed).
const SHAPES = {
  SCOPED: ["market", "organization", "zone", "tenant", "purpose"],
  SCOPED_PAGE: ["market", "organization", "zone", "tenant", "purpose", "limit", "cursor"],
  SCOPED_WINDOW: ["market", "organization", "zone", "tenant", "purpose", "limit", "cursor", "start", "end"],
  SCOPED_SEARCH: ["market", "organization", "zone", "tenant", "purpose", "limit", "cursor", "q"],
};
const OPTIONAL = new Set(["cursor", "q"]);
const PARAM_SCHEMA = {
  market: opaque, organization: opaque, zone: { type: "string", enum: ["production", "sandbox"] }, tenant: opaque,
  purpose: { type: "string", pattern: "^[a-z][a-z-]{2,63}$" },
  limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string", pattern: "^[A-Za-z0-9._~:@/+=-]{1,4096}$" },
  start: time, end: time, q: { type: "string", pattern: "^[\\p{L}\\p{N} ._@:-]{1,128}$" },
};

const SCALAR = { type: ["string", "integer", "number", "boolean", "null"] };
const SCHEMAS = {
  Scope: { type: "object", additionalProperties: false, required: ["product", "market", "organization", "zone", "tenant"],
    properties: { product: { const: "cfmeet" }, market: opaque, organization: opaque, zone: opaque, tenant: opaque } },
  ResourceItem: { type: "object", required: ["id", "kind"], maxProperties: 48,
    properties: { id: opaque, kind: opaque, status: opaque, version: { type: "integer", minimum: 0 }, created_at: time, updated_at: time },
    additionalProperties: SCALAR },
  HistoryEntry: { type: "object", additionalProperties: false, required: ["at", "action", "actor_ref"],
    properties: { at: time, action: opaque, actor_ref: opaque, from_status: { type: ["string", "null"], maxLength: 128 }, to_status: { type: ["string", "null"], maxLength: 128 }, reason_code: { type: ["string", "null"], maxLength: 64 } } },
  ResourcePage: { type: "object", additionalProperties: false, required: ["contract_version", "scope", "as_of", "coverage", "items", "next_cursor"],
    properties: { contract_version: { const: "cfmeet.admin-resources.v1" }, scope: ref("Scope"), as_of: time,
      coverage: { enum: ["COMPLETE", "PARTIAL", "CONTEXT_SCOPED_PARTIAL"] }, items: { type: "array", maxItems: 100, items: ref("ResourceItem") }, next_cursor: { type: ["string", "null"], maxLength: 4096 } } },
  ResourceDetail: { type: "object", additionalProperties: false, required: ["contract_version", "scope", "as_of", "coverage", "item", "history"],
    properties: { contract_version: { const: "cfmeet.admin-resources.v1" }, scope: ref("Scope"), as_of: time,
      coverage: { enum: ["COMPLETE", "PARTIAL", "CONTEXT_SCOPED_PARTIAL"] }, item: ref("ResourceItem"), history: { type: "array", maxItems: 100, items: ref("HistoryEntry") } } },
  // Shared verification case shape (work plan §3.6).
  VerificationCase: { type: "object", additionalProperties: false,
    required: ["case_id", "product", "kind", "subject_ref", "state", "version", "assignee_ref", "submitted_at", "updated_at", "evidence"],
    properties: { case_id: { type: "string", format: "uuid" }, product: { const: "cfmeet" }, kind: { enum: ["PARTNER_GO_LIVE", "APP_REVIEW", "APP_PUBLISH"] },
      subject_ref: opaque, state: { enum: ["OPEN", "CLAIMED", "APPROVED", "REJECTED", "SUSPENDED", "PUBLISHED"] }, version: { type: "integer", minimum: 1 },
      assignee_ref: { type: ["string", "null"], maxLength: 128 }, submitted_at: time, updated_at: time,
      evidence: { type: "array", maxItems: 50, items: { type: "object", additionalProperties: false, required: ["kind", "ref", "sha256"], properties: { kind: opaque, ref: opaque, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } } } } } },
  VerificationCasePage: { type: "object", additionalProperties: false, required: ["contract_version", "scope", "as_of", "coverage", "items", "next_cursor"],
    properties: { contract_version: { const: "cfmeet.admin-resources.v1" }, scope: ref("Scope"), as_of: time, coverage: { enum: ["COMPLETE", "PARTIAL"] },
      items: { type: "array", maxItems: 100, items: ref("VerificationCase") }, next_cursor: { type: ["string", "null"], maxLength: 4096 } } },
  VerificationCaseDetail: { type: "object", additionalProperties: false, required: ["contract_version", "scope", "as_of", "coverage", "item", "history"],
    properties: { contract_version: { const: "cfmeet.admin-resources.v1" }, scope: ref("Scope"), as_of: time, coverage: { enum: ["COMPLETE", "PARTIAL"] },
      item: ref("VerificationCase"), history: { type: "array", maxItems: 100, items: ref("HistoryEntry") } } },
  Summary: { type: "object", additionalProperties: false, required: ["contract_version", "scope", "as_of", "coverage", "window", "cells"],
    properties: { contract_version: { const: "cfmeet.admin-summary.v1" }, scope: ref("Scope"), as_of: time, coverage: { enum: ["COMPLETE", "PARTIAL"] },
      window: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["start", "end"], properties: { start: time, end: time } }] },
      cells: { type: "array", maxItems: 200, items: { type: "object", additionalProperties: false, required: ["key", "value", "unit", "currency", "suppression"],
        properties: { key: opaque, value: { type: ["integer", "null"] }, unit: { enum: ["count", "minor_currency", "seconds"] }, currency: { type: ["string", "null"], pattern: "^[A-Z]{3}$" },
          suppression: { enum: ["NONE", "SMALL_CELL", "PARTIAL_COVERAGE"] } } } } } },
  Health: { type: "object", additionalProperties: false, required: ["as_of", "status", "services"],
    properties: { as_of: time, status: { enum: ["OK", "DEGRADED", "DOWN", "UNKNOWN"] },
      services: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false, required: ["service", "status", "checked_at"], properties: { service: opaque, status: { enum: ["OK", "DEGRADED", "DOWN", "UNKNOWN"] }, checked_at: time } } } } },
  CapabilityStates: { type: "object", additionalProperties: false, required: ["contract_version", "openapi_sha256", "policy_revision", "capabilities"],
    properties: { contract_version: { type: "string", maxLength: 32 }, openapi_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, policy_revision: { type: "integer", minimum: 1 },
      capabilities: { type: "array", maxItems: 1000, items: { type: "object", additionalProperties: false, required: ["id", "state"], properties: { id: opaque, state: { enum: ["AVAILABLE", "READ_ONLY", "DISABLED", "BLOCKED_DEPENDENCY"] }, blocker: { type: ["string", "null"], maxLength: 256 } } } } } },
  // Bridge dataset series (Track A §11): one row per UTC day; null = unknown, never zero.
  DatasetSeries: { type: "object", additionalProperties: false, required: ["dataset_id", "coverage", "window", "series", "next_cursor"],
    properties: { dataset_id: { type: "string", pattern: "^cfmeet\\.[a-z_]{1,48}$" }, coverage: { enum: ["COMPLETE", "PARTIAL", "NONE"] },
      window: { type: "object", additionalProperties: false, required: ["start", "end"], properties: { start: time, end: time } },
      series: { type: "array", maxItems: 31, items: { type: "object", additionalProperties: false, required: ["date", "metrics"],
        properties: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, metrics: { type: "object", maxProperties: 16, propertyNames: { pattern: "^[a-z][a-z_]{0,47}$" }, additionalProperties: { type: ["integer", "null"], minimum: 0 } } } } },
      next_cursor: { type: ["string", "null"], maxLength: 4096 } } },
  CommandRequest: { type: "object", additionalProperties: false, required: ["operation_id", "idempotency_key", "reason_code", "expected_version", "requested_at", "params"],
    properties: { operation_id: { type: "string", format: "uuid" }, idempotency_key: { type: "string", pattern: "^[A-Za-z0-9._:-]{16,128}$" },
      reason_code: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" }, case_ref: { type: "string", maxLength: 128 }, expected_version: { type: "integer", minimum: 0 },
      requested_at: time, params: { type: "object", maxProperties: 16, additionalProperties: SCALAR } } },
  CommandResult: { type: "object", additionalProperties: false, required: ["operation_id", "status", "source_version"],
    properties: { operation_id: { type: "string", format: "uuid" }, status: { enum: ["ACCEPTED", "PENDING", "CONFIRMED", "COMPLETED", "REJECTED", "FAILED_TERMINAL"] },
      source_version: { type: ["integer", "null"], minimum: 0 }, reason_code: { type: ["string", "null"], maxLength: 64 },
      receipt: { type: "object", additionalProperties: false, required: ["recorded_version", "recorded_at"], properties: { recorded_version: { type: "integer", minimum: 0 }, recorded_at: time } } } },
  OperationRecord: { type: "object", additionalProperties: false, required: ["operation_id", "status", "source_version", "updated_at"],
    properties: { operation_id: { type: "string", format: "uuid" }, status: { enum: ["ACCEPTED", "PENDING", "CONFIRMED", "COMPLETED", "REJECTED", "FAILED_TERMINAL"] },
      source_version: { type: ["integer", "null"], minimum: 0 }, reason_code: { type: ["string", "null"], maxLength: 64 }, updated_at: time } },
  ExportDownloadRequest: { type: "object", additionalProperties: false, required: ["grant_id"], properties: { grant_id: { type: "string", format: "uuid" } } },
  HQEventAck: { type: "object", additionalProperties: false, required: ["consumer", "sequence"], properties: { consumer: opaque, sequence: { type: "integer", minimum: 0 } } },
  HQEventAckResult: { type: "object", additionalProperties: false, required: ["consumer", "acknowledged_sequence"], properties: { consumer: opaque, acknowledged_sequence: { type: "integer", minimum: 0 } } },
  HQEventFeed: { type: "object", additionalProperties: false, required: ["events", "next_sequence", "head_sequence", "as_of"],
    properties: { events: { type: "array", maxItems: 500, items: { type: "object", additionalProperties: false,
      required: ["schema", "event_id", "sequence", "event_type", "source_service", "product", "entity_type", "entity_ref", "entity_version", "tombstone", "occurred_at", "emitted_at", "market", "scope", "classification", "correlation_id", "payload"],
      properties: { schema: { const: "cosmicforge.product-admin-event.v1" }, event_id: { type: "string", format: "uuid" }, sequence: { type: "integer", minimum: 1 }, event_type: opaque, source_service: opaque,
        product: { const: "cfmeet" }, entity_type: opaque, entity_ref: opaque, entity_version: { type: "integer", minimum: 1 }, tombstone: { type: "boolean" }, occurred_at: time, emitted_at: time,
        market: { type: "string", maxLength: 128 }, scope: { type: "object", additionalProperties: false, required: ["zone", "organization", "tenant"], properties: { zone: { type: "string", maxLength: 128 }, organization: { type: "string", maxLength: 128 }, tenant: { type: "string", maxLength: 128 } } },
        classification: { enum: ["PUBLIC", "INTERNAL", "OPERATIONS_MINIMIZED", "FINANCIAL_SENSITIVE", "SAFETY_EVIDENCE"] }, correlation_id: { type: "string", maxLength: 128 }, payload: { type: "object", maxProperties: 32 } } } },
      next_sequence: { type: "integer", minimum: 0 }, head_sequence: { type: "integer", minimum: 0 }, as_of: time } },
  HQProjectionStatus: { type: "object", additionalProperties: false, required: ["as_of", "freshness_threshold_seconds", "sources", "quarantined", "head_sequence", "consumer_lag"],
    properties: { as_of: time, freshness_threshold_seconds: { type: "integer", minimum: 0 },
      sources: { type: "array", items: { type: "object", additionalProperties: false, required: ["source_service", "entity_type", "projections", "last_received_at", "lag_seconds", "open_gaps", "freshness", "coverage", "last_backfill_status"],
        properties: { source_service: opaque, entity_type: opaque, projections: { type: "integer", minimum: 0 }, last_received_at: { type: ["string", "null"], format: "date-time" }, lag_seconds: { type: ["integer", "null"], minimum: 0 },
          open_gaps: { type: "integer", minimum: 0 }, freshness: { enum: ["LIVE", "STALE", "UNKNOWN"] }, coverage: { enum: ["COMPLETE", "PARTIAL_COVERAGE"] }, last_backfill_status: { enum: ["NONE", "RUNNING", "COMPLETE", "PARTIAL_COVERAGE", "FAILED"] } } } },
      quarantined: { type: "integer", minimum: 0 }, head_sequence: { type: "integer", minimum: 0 }, consumer_lag: { type: "object", additionalProperties: { type: "integer", minimum: 0 } } } },
};

// ---------------------------------------------------------------- capabilities
const CAPS = [];
const pp = (name, kind = "opaque") => (kind === "uuid" ? { name, schema: { type: "string", format: "uuid" } } : kind === "dataset" ? { name, schema: { type: "string", pattern: "^cfmeet\\.[a-z_]{1,48}$", maxLength: 56 } } : { name, schema: { type: "string", pattern: SEGMENT, maxLength: 128 } });
function params(p) { return [...p.matchAll(/\{([a-z_]+)\}/g)].map((m) => pp(m[1], m[1] === "dataset_id" ? "dataset" : m[1].endsWith("case_id") || m[1] === "operation_id" || m[1] === "request_id" ? "uuid" : "opaque")); }
const owner = (id) => id.split(".")[0] + "-service";

function add(id, method, p, o) {
  CAPS.push({
    id, method, path: p, shape: o.shape, risk: o.risk || "R1", privacy: o.privacy || "OPERATIONS_MINIMIZED",
    approval: o.approval || "NONE", state: o.state || (method === "GET" ? "READ_ONLY" : "AVAILABLE"), blocker: o.blocker || null,
    permission: o.permission || id, body: o.body || null, result: o.result === undefined ? null : o.result, media: o.media || "application/json",
    status: o.status || 200, svr: o.svr !== undefined ? o.svr : method !== "GET", idem: o.idem !== undefined ? o.idem : method !== "GET",
    flag: o.flag || "NONE", owner: o.owner || owner(id),
  });
}
const list = (id, p, o = {}) => add(id, "GET", p, { shape: "SCOPED_PAGE", result: ref("ResourcePage"), ...o });
const detail = (id, p, o = {}) => add(id, "GET", p, { shape: "SCOPED", result: ref("ResourceDetail"), ...o });
const summary = (id, p, o = {}) => add(id, "GET", p, { shape: "SCOPED_WINDOW", result: ref("Summary"), privacy: "SUPPRESSED_COUNT_METADATA", ...o });
const cmd = (id, p, o = {}) => add(id, "POST", p, { shape: "SCOPED", body: ref("CommandRequest"), result: ref("CommandResult"), ...o });
const two = (id, p, risk = "R3", o = {}) => cmd(id, p, { risk, approval: "TWO_PERSON", ...o });

// platform
add("bridge.capabilities.read", "GET", "/capabilities", { shape: "SCOPED", result: ref("CapabilityStates"), risk: "R0", privacy: "INTERNAL", owner: "admin-bridge" });
add("bridge.health.read", "GET", "/health/aggregate", { shape: "SCOPED", result: ref("Health"), risk: "R0", privacy: "INTERNAL", owner: "admin-bridge" });
add("bridge.datasets.read", "GET", "/datasets/{dataset_id}", { shape: "SCOPED_WINDOW", result: ref("DatasetSeries"), risk: "R1", privacy: "INTERNAL", owner: "admin-bridge" });
add("hq.events.feed", "GET", "/hq/events", { shape: "SCOPED_WINDOW", result: ref("HQEventFeed"), risk: "R1", owner: "admin-bridge", permission: "hq.events.read" });
add("hq.events.ack", "POST", "/hq/event-acknowledgements", { shape: "SCOPED", body: ref("HQEventAck"), result: ref("HQEventAckResult"), risk: "R1", owner: "admin-bridge", svr: false, idem: true });
add("hq.projections.status", "GET", "/hq/projections/status", { shape: "SCOPED", result: ref("HQProjectionStatus"), risk: "R0", privacy: "INTERNAL", owner: "admin-bridge", permission: "hq.projections.read" });

// accounts
list("accounts.users.list", "/accounts/users", { shape: "SCOPED_SEARCH", risk: "R2", privacy: "PERSONAL_MINIMIZED", permission: "accounts.users.read" });
detail("accounts.users.read", "/accounts/users/{user_id}", { risk: "R2", privacy: "PERSONAL_MINIMIZED", permission: "accounts.users.read" });
list("accounts.sessions.list", "/accounts/users/{user_id}/sessions", { shape: "SCOPED_PAGE", risk: "R2", privacy: "PERSONAL_MINIMIZED" });
list("accounts.devices.list", "/accounts/users/{user_id}/devices", { shape: "SCOPED_PAGE", risk: "R2", privacy: "PERSONAL_MINIMIZED" });
list("accounts.security-events.list", "/accounts/security-events", { shape: "SCOPED_WINDOW", risk: "R2", privacy: "PERSONAL_MINIMIZED" });
list("accounts.duplicates.list", "/accounts/duplicates", { risk: "R2", privacy: "PERSONAL_MINIMIZED" });
list("accounts.review-requests.list", "/accounts/review-requests", { shape: "SCOPED_WINDOW", risk: "R2" });
detail("accounts.review-requests.read", "/accounts/review-requests/{request_id}", { risk: "R2", result: ref("OperationRecord") });
cmd("accounts.review-requests.submit", "/accounts/review-requests", { risk: "R2" });
two("accounts.users.status.update", "/accounts/users/{user_id}/status");
two("accounts.users.role.update", "/accounts/users/{user_id}/role");
two("accounts.users.email.update", "/accounts/users/{user_id}/email");
two("accounts.sessions.revoke-all", "/accounts/users/{user_id}/sessions/revoke-all");
two("accounts.devices.remove", "/accounts/users/{user_id}/device-removals");
two("accounts.mfa.reset", "/accounts/users/{user_id}/mfa/reset", "R4");
two("accounts.exports.create", "/accounts/exports");
add("accounts.exports.download", "POST", "/accounts/exports/{export_id}/download", { shape: "SCOPED", body: ref("ExportDownloadRequest"), result: { type: "string" }, media: "text/csv", risk: "R2", privacy: "PERSONAL_MINIMIZED", svr: false, idem: false });
two("accounts.deletions.create", "/accounts/deletions", "R4");

// meetings
list("meetings.spaces.list", "/meetings/spaces", { shape: "SCOPED_SEARCH" });
list("meetings.meetings.list", "/meetings/meetings", { shape: "SCOPED_WINDOW" });
detail("meetings.meetings.read", "/meetings/meetings/{meeting_id}");
list("meetings.live.list", "/meetings/live");
list("meetings.participants.list", "/meetings/meetings/{meeting_id}/participants", { shape: "SCOPED_PAGE", risk: "R2", privacy: "PERSONAL_MINIMIZED" });
list("meetings.recordings.list", "/meetings/recordings", { shape: "SCOPED_WINDOW", risk: "R2" });
list("meetings.webinars.list", "/meetings/webinars", { shape: "SCOPED_WINDOW" });
list("meetings.audit.list", "/meetings/audit", { shape: "SCOPED_WINDOW", risk: "R2" });
list("meetings.reports.list", "/meetings/reports", { shape: "SCOPED_PAGE", risk: "R2", privacy: "SAFETY_EVIDENCE" });
two("meetings.meetings.end", "/meetings/meetings/{meeting_id}/end");
two("meetings.spaces.archive", "/meetings/spaces/{space_id}/archive");
two("meetings.spaces.transfer", "/meetings/spaces/{space_id}/transfer");
two("meetings.recordings.delete", "/meetings/recordings/{recording_id}/deletion", "R4");
two("meetings.reports.review", "/meetings/reports/{report_id}/review");

// messaging
list("messaging.reports.list", "/messaging/reports", { shape: "SCOPED_PAGE", risk: "R2", privacy: "SAFETY_EVIDENCE" });
list("messaging.moderation.list", "/messaging/moderation-actions", { shape: "SCOPED_WINDOW", risk: "R2" });
list("messaging.policies.list", "/messaging/policies");
list("messaging.holds.list", "/messaging/holds", { risk: "R2" });
list("messaging.exports.list", "/messaging/exports", { risk: "R2" });
list("messaging.deletion-requests.list", "/messaging/deletion-requests", { risk: "R2" });
list("messaging.audit.list", "/messaging/audit", { shape: "SCOPED_WINDOW", risk: "R2" });
list("messaging.kill-switches.list", "/messaging/off-switches");
list("messaging.failed-deliveries.list", "/messaging/failed-deliveries", { shape: "SCOPED_WINDOW" });
list("messaging.key-transparency.list", "/messaging/key-transparency", { shape: "SCOPED_WINDOW" });
two("messaging.moderation.apply", "/messaging/moderation-actions");
two("messaging.policies.update", "/messaging/policies/{policy_id}/versions");
two("messaging.holds.create", "/messaging/holds");
two("messaging.exports.create", "/messaging/exports", "R4");
two("messaging.deletions.execute", "/messaging/deletion-requests/{request_id}/execution", "R4");
two("messaging.kill-switches.set", "/messaging/off-switches/{switch_id}", "R4");
cmd("messaging.failed-deliveries.retry", "/messaging/failed-deliveries/{delivery_id}/retry", { risk: "R2" });

// calling
list("calling.calls.list", "/calling/calls", { shape: "SCOPED_WINDOW", risk: "R2" });
list("calling.live.list", "/calling/live");
list("calling.abuse-reports.list", "/calling/abuse-reports", { shape: "SCOPED_PAGE", risk: "R2", privacy: "SAFETY_EVIDENCE" });
list("calling.blocks.list", "/calling/blocks");
list("calling.limits.list", "/calling/limits");
list("calling.spend.list", "/calling/spend", { shape: "SCOPED_WINDOW", risk: "R2", privacy: "FINANCIAL_SENSITIVE" });
list("calling.routing.list", "/calling/routing");
list("calling.features.list", "/calling/enterprise-features");
list("calling.recordings.list", "/calling/recordings", { shape: "SCOPED_WINDOW", risk: "R2" });
list("calling.holds.list", "/calling/holds", { risk: "R2" });
list("calling.incidents.list", "/calling/incidents", { shape: "SCOPED_WINDOW" });
list("calling.webhook-keys.list", "/calling/webhook-keys");
list("calling.audit.list", "/calling/audit", { shape: "SCOPED_WINDOW", risk: "R2" });
cmd("calling.abuse-reports.resolve", "/calling/abuse-reports/{report_id}/resolution", { risk: "R2" });
two("calling.blocks.release", "/calling/blocks/{block_id}/release");
two("calling.limits.update", "/calling/limits/{limit_id}");
two("calling.spend.update", "/calling/spend/{account_id}/caps");
two("calling.routing.update", "/calling/routing/{route_id}");
two("calling.features.update", "/calling/enterprise-features/{feature_id}");
two("calling.holds.create", "/calling/holds");
two("calling.webhook-keys.reseal", "/calling/webhook-keys/{key_id}/reseal");

// communications
list("communications.profiles.list", "/communications/profiles", { shape: "SCOPED_SEARCH", risk: "R2", privacy: "PERSONAL_MINIMIZED" });
detail("communications.profiles.read", "/communications/profiles/{cfmeet_id}", { risk: "R2", privacy: "PERSONAL_MINIMIZED" });
list("communications.reports.list", "/communications/reports", { shape: "SCOPED_PAGE", risk: "R2", privacy: "SAFETY_EVIDENCE" });
list("communications.holds.list", "/communications/holds", { risk: "R2" });
list("communications.audit.list", "/communications/audit", { shape: "SCOPED_WINDOW", risk: "R2" });
summary("communications.metrics.read", "/communications/metrics", { shape: "SCOPED" });
two("communications.profiles.suspend", "/communications/profiles/{profile_id}/suspension");
two("communications.profiles.restore", "/communications/profiles/{profile_id}/restoration");
two("communications.reports.review", "/communications/reports/{report_id}/review");
cmd("communications.backfills.create", "/communications/backfills", { risk: "R2" });

// organizations
list("organizations.organizations.list", "/organizations/organizations", { shape: "SCOPED_SEARCH" });
detail("organizations.organizations.read", "/organizations/organizations/{organization_id}");
list("organizations.audit.list", "/organizations/organizations/{organization_id}/audit", { shape: "SCOPED_WINDOW", risk: "R2" });
list("organizations.members.list", "/organizations/organizations/{organization_id}/members", { shape: "SCOPED_PAGE", risk: "R2", privacy: "PERSONAL_MINIMIZED" });
list("organizations.teams.list", "/organizations/organizations/{organization_id}/teams", { shape: "SCOPED_PAGE" });
list("organizations.policies.list", "/organizations/policies");
list("organizations.bindings.list", "/organizations/organizations/{organization_id}/bindings");
list("organizations.events.list", "/organizations/events", { shape: "SCOPED_WINDOW" });
cmd("organizations.organizations.create", "/organizations/organizations", { risk: "R2" });
two("organizations.organizations.suspend", "/organizations/organizations/{organization_id}/suspension");
two("organizations.organizations.archive", "/organizations/organizations/{organization_id}/archive");
two("organizations.ownership.recover", "/organizations/organizations/{organization_id}/ownership-recovery", "R4");
two("organizations.exports.create", "/organizations/exports");
two("organizations.bindings.update", "/organizations/bindings/{binding_id}");
two("organizations.members.update", "/organizations/members/{member_id}");
two("organizations.teams.update", "/organizations/teams/{team_id}");
two("organizations.policies.update", "/organizations/policies/{policy_id}");
cmd("organizations.events.replay", "/organizations/events/replay", { risk: "R2" });

// partners
list("partners.workspaces.list", "/partners/workspaces", { shape: "SCOPED_SEARCH" });
detail("partners.workspaces.read", "/partners/workspaces/{workspace_id}");
list("partners.projects.list", "/partners/workspaces/{workspace_id}/projects", { shape: "SCOPED_PAGE" });
list("partners.environments.list", "/partners/workspaces/{workspace_id}/environments");
list("partners.members.list", "/partners/workspaces/{workspace_id}/members", { shape: "SCOPED_PAGE", risk: "R2", privacy: "PERSONAL_MINIMIZED" });
list("partners.keys.list", "/partners/workspaces/{workspace_id}/keys");
list("partners.service-accounts.list", "/partners/workspaces/{workspace_id}/service-accounts");
list("partners.websites.list", "/partners/workspaces/{workspace_id}/websites");
list("partners.push-keys.list", "/partners/workspaces/{workspace_id}/push-keys");
list("partners.users.list", "/partners/workspaces/{workspace_id}/users", { shape: "SCOPED_SEARCH", risk: "R2", privacy: "PERSONAL_MINIMIZED" });
list("partners.webhooks.list", "/partners/workspaces/{workspace_id}/webhooks", { shape: "SCOPED_PAGE" });
summary("partners.usage.read", "/partners/workspaces/{workspace_id}/usage");
list("partners.incidents.list", "/partners/incidents", { shape: "SCOPED_WINDOW" });
list("partners.activity.list", "/partners/activity", { shape: "SCOPED_WINDOW" });
two("partners.workspaces.state.update", "/partners/workspaces/{workspace_id}/state");
two("partners.keys.revoke", "/partners/keys/{key_id}/revocation");
two("partners.users.sign-out", "/partners/users/{user_id}/sign-out");
cmd("partners.webhooks.retry", "/partners/webhooks/{delivery_id}/retry", { risk: "R2" });
cmd("partners.workspaces.support-tier.update", "/partners/workspaces/{workspace_id}/support-tier", { risk: "R2" });
cmd("partners.incidents.create", "/partners/incidents", { risk: "R2" });

// identity
list("identity.tenants.list", "/identity/tenants", { shape: "SCOPED_SEARCH" });
list("identity.apps.list", "/identity/apps");
list("identity.environments.list", "/identity/tenants/{tenant_id}/environments");
list("identity.service-accounts.list", "/identity/tenants/{tenant_id}/service-accounts");
list("identity.scopes.list", "/identity/scopes");
list("identity.keys.list", "/identity/tenants/{tenant_id}/keys");
list("identity.records.list", "/identity/records", { shape: "SCOPED_SEARCH", risk: "R2", privacy: "PERSONAL_MINIMIZED" });
list("identity.oauth-apps.list", "/identity/oauth-apps", { shape: "SCOPED_SEARCH" });
list("identity.audit.list", "/identity/audit", { shape: "SCOPED_WINDOW", risk: "R2" });
two("identity.tenants.status.update", "/identity/tenants/{tenant_id}/status");
two("identity.scopes.update", "/identity/scopes/{scope_id}");
two("identity.keys.rotate", "/identity/keys/{key_id}/rotation", "R4");
two("identity.records.remove", "/identity/records/{record_id}/removal", "R4");

// apps
list("apps.apps.list", "/apps/apps", { shape: "SCOPED_SEARCH" });
detail("apps.apps.read", "/apps/apps/{app_id}");
list("apps.versions.list", "/apps/apps/{app_id}/versions");
list("apps.installs.list", "/apps/apps/{app_id}/installs", { shape: "SCOPED_PAGE" });
two("apps.apps.suspend", "/apps/apps/{app_id}/suspension");
two("apps.apps.lift", "/apps/apps/{app_id}/suspension-lift");

// verification (shared case shape)
list("verification.cases.list", "/verification/cases", { shape: "SCOPED_PAGE", result: ref("VerificationCasePage") });
detail("verification.cases.read", "/verification/cases/{case_id}", { result: ref("VerificationCaseDetail") });
list("verification.case-history.list", "/verification/cases/{case_id}/history", { shape: "SCOPED_PAGE" });
cmd("verification.cases.claim", "/verification/cases/{case_id}/claim", { risk: "R2" });
two("verification.partner-go-live.decide", "/verification/cases/{case_id}/go-live-decision");
two("verification.app-review.decide", "/verification/cases/{case_id}/app-review-decision");
two("verification.app-publish.execute", "/verification/cases/{case_id}/publication");
two("verification.subjects.suspend", "/verification/cases/{case_id}/suspension");

// pricing (Free / Pro / Business)
list("pricing.price-books.list", "/pricing/price-books");
list("pricing.versions.list", "/pricing/price-books/{price_book_id}/versions", { shape: "SCOPED_PAGE" });
list("pricing.activations.list", "/pricing/price-books/{price_book_id}/activations", { shape: "SCOPED_PAGE" });
list("pricing.freezes.list", "/pricing/freezes");
list("pricing.plans.list", "/pricing/plans");
list("pricing.plan-assignments.list", "/pricing/plan-assignments", { shape: "SCOPED_SEARCH", risk: "R2" });
list("pricing.overrides.list", "/pricing/overrides", { risk: "R2", privacy: "FINANCIAL_SENSITIVE" });
add("pricing.charges.simulate", "POST", "/pricing/simulations", { shape: "SCOPED", body: ref("CommandRequest"), result: ref("Summary"), risk: "R1", privacy: "FINANCIAL_SENSITIVE", svr: false, idem: false });
cmd("pricing.versions.draft", "/pricing/versions", { risk: "R2" });
cmd("pricing.versions.submit", "/pricing/versions/{version_id}/submission", { risk: "R2" });
two("pricing.versions.approve", "/pricing/versions/{version_id}/approval", "R4");
two("pricing.versions.reject", "/pricing/versions/{version_id}/rejection");
two("pricing.versions.activate", "/pricing/versions/{version_id}/activation", "R4");
two("pricing.versions.rollback", "/pricing/versions/{version_id}/rollback", "R4");
two("pricing.freezes.set", "/pricing/freezes", "R4");
two("pricing.freezes.release", "/pricing/freezes/{freeze_id}/release", "R4");
two("pricing.plan-assignments.assign", "/pricing/plan-assignments");
two("pricing.overrides.set", "/pricing/overrides");

// finance (read only)
summary("finance.usage.report", "/finance/usage", { risk: "R2", privacy: "FINANCIAL_SENSITIVE" });
summary("finance.estimated-charges.report", "/finance/estimated-charges", { risk: "R2", privacy: "FINANCIAL_SENSITIVE" });
summary("finance.plan-spread.report", "/finance/plan-spread");

// notifications
list("notifications.deliveries.list", "/notifications/deliveries", { shape: "SCOPED_WINDOW" });
list("notifications.failed-deliveries.list", "/notifications/failed-deliveries", { shape: "SCOPED_WINDOW" });
list("notifications.suppressions.list", "/notifications/suppressions", { shape: "SCOPED_SEARCH", risk: "R2", privacy: "PERSONAL_MINIMIZED" });
list("notifications.routing.list", "/notifications/routing");
list("notifications.providers.list", "/notifications/providers");
cmd("notifications.failed-deliveries.retry", "/notifications/failed-deliveries/{delivery_id}/retry", { risk: "R2" });
cmd("notifications.suppressions.remove", "/notifications/suppressions/{suppression_id}/removal", { risk: "R2" });
two("notifications.routing.update", "/notifications/routing/{route_id}");
two("notifications.reroutes.cancel", "/notifications/reroutes/{reroute_id}/cancellation");

// privacy
list("privacy.requests.list", "/privacy/requests", { shape: "SCOPED_PAGE", risk: "R2" });
detail("privacy.requests.read", "/privacy/requests/{request_id}", { risk: "R2" });
list("privacy.service-status.list", "/privacy/service-status");
cmd("privacy.requests.register", "/privacy/requests", { risk: "R2" });
two("privacy.requests.complete-service", "/privacy/requests/{request_id}/service-completions");

// operations
add("operations.health.read", "GET", "/operations/health", { shape: "SCOPED", result: ref("Health"), risk: "R0", privacy: "INTERNAL" });
list("operations.incidents.list", "/operations/incidents", { shape: "SCOPED_WINDOW" });
list("operations.switches.list", "/operations/switches");
list("operations.switch-on-requests.list", "/operations/switch-on-requests", { shape: "SCOPED_WINDOW" });
detail("operations.switch-on-requests.read", "/operations/switch-on-requests/{request_id}", { result: ref("OperationRecord") });
list("operations.releases.list", "/operations/releases", { shape: "SCOPED_WINDOW" });
cmd("operations.incidents.resolve", "/operations/incidents/{incident_id}/resolution", { risk: "R2" });
two("operations.switches.flip", "/operations/switches/{switch_id}", "R4");
two("operations.switch-on-requests.create", "/operations/switch-on-requests");

// audit
list("audit.events.search", "/audit/events", { shape: "SCOPED_SEARCH", risk: "R2" });

// telecom (read-only summaries, not released)
summary("telecom.numbers.summary", "/telecom/numbers", { shape: "SCOPED", state: "DISABLED", blocker: "Telecom administration is not released for HQ" });
two("telecom.numbers.assign", "/telecom/numbers/{number_id}/assignment", "R3", { state: "DISABLED", blocker: "Telecom administration is not released for HQ" });
summary("telecom.carriers.summary", "/telecom/carriers/summary", { shape: "SCOPED", state: "BLOCKED_DEPENDENCY", blocker: "Carrier reporting owner endpoint does not exist yet" });

// ---------------------------------------------------------------- outputs
function envelope(result) {
  return { type: "object", additionalProperties: false, required: ["contract_version", "product", "correlation_id", "as_of", "freshness", "result"],
    properties: { contract_version: { const: "1.0" }, product: { const: "cfmeet" }, correlation_id: { type: "string", format: "uuid" }, as_of: time,
      freshness: { enum: ["LIVE", "RECENT", "STALE", "PARTIAL", "UNKNOWN", "UNAVAILABLE"] }, result, error: { type: "null" } } };
}

function openapi() {
  const paths = {};
  for (const c of CAPS) {
    const full = BASE + c.path;
    const parameters = [
      ...params(c.path).map((p) => ({ name: p.name, in: "path", required: true, schema: p.schema })),
      ...SHAPES[c.shape].map((n) => ({ name: n, in: "query", required: !OPTIONAL.has(n), schema: PARAM_SCHEMA[n] })),
    ];
    const content = c.media === "application/json" ? { "application/json": { schema: envelope(c.result) } } : { [c.media]: { schema: c.result } };
    const op = { operationId: c.id, summary: c.id, parameters, responses: { [String(c.status)]: { description: "OK", content } } };
    if (c.body) op.requestBody = { required: true, content: { "application/json": { schema: c.body } } };
    paths[full] = paths[full] || {};
    paths[full][c.method.toLowerCase()] = op;
  }
  return { openapi: "3.1.0", info: { title: "CF Meet Admin Bridge (HQ DRAFT)", version: VERSION, "x-hq-draft": true }, paths, components: { schemas: SCHEMAS } };
}

function matrix() {
  return CAPS.map((c) => ({
    id: c.id, version: "1.0", owner: c.owner, method: c.method, bridge_endpoint: c.path, source_endpoint: null, state: c.state,
    permission: c.permission, risk: c.risk, privacy: c.privacy, scope: "cfmeet + exact market, organization, zone and tenant",
    source_version_required: c.svr, idempotency_required: c.idem, approval: c.approval, feature_flag: c.flag, blocker: c.blocker,
    tests: ["DRAFT_NOT_IMPLEMENTED"],
  }));
}

// Event adapters for the provisional HQ datasets (karryam adapter shape).
const EVENTS = {
  contract: "cfmeet.admin-events.v1",
  export_schema: "cosmicforge.product-admin-event.v1",
  max_event_bytes: 16384,
  source_files_hash: "sha256 of the file with line endings normalized to LF",
  source_files: {},
  exportable_classifications: ["PUBLIC", "INTERNAL", "OPERATIONS_MINIMIZED", "FINANCIAL_SENSITIVE", "SAFETY_EVIDENCE"],
  // Track A A0 export types (fields are provisional until A7). One adapter per
  // (source_service, export_type): a type emitted by several owners repeats.
  adapters: [
    ...["developer-platform"].map((svc) => ({ source_service: svc, export_type: "partner.workspace.changed.v1", entity_type: "partner_workspace", classification: "OPERATIONS_MINIMIZED",
      fields: { state: { kind: "ENUM", required: true, enum: ["ACTIVE", "RESTRICTED", "SUSPENDED", "CLOSED"] }, live: { kind: "BOOL", required: true }, support_tier: { kind: "OPAQUE_NULLABLE" }, updated_at: { kind: "TIME", required: true } } })),
    ...["developer-platform"].map((svc) => ({ source_service: svc, export_type: "app.review.changed.v1", entity_type: "app", classification: "OPERATIONS_MINIMIZED",
      fields: { state: { kind: "ENUM", required: true, enum: ["DRAFT", "IN_REVIEW", "PUBLISHED", "SUSPENDED", "REJECTED"] }, updated_at: { kind: "TIME", required: true } } })),
    ...["developer-platform"].map((svc) => ({ source_service: svc, export_type: "verification.case.changed.v1", entity_type: "verification_case", classification: "OPERATIONS_MINIMIZED",
      fields: { kind: { kind: "ENUM", required: true, enum: ["PARTNER_GO_LIVE", "APP_REVIEW", "APP_PUBLISH"] }, state: { kind: "ENUM", required: true, enum: ["OPEN", "CLAIMED", "APPROVED", "REJECTED", "SUSPENDED", "PUBLISHED"] }, assignee: { kind: "OPAQUE_NULLABLE" }, submitted_at: { kind: "TIME", required: true } } })),
    ...["messaging", "calling", "communications", "meeting-service"].map((svc) => ({ source_service: svc, export_type: "abuse.report.changed.v1", entity_type: "abuse_report", classification: "SAFETY_EVIDENCE",
      fields: { status: { kind: "ENUM", required: true, enum: ["OPEN", "UNDER_REVIEW", "ACTIONED", "DISMISSED", "ESCALATED"] }, severity: { kind: "ENUM", required: true, enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] }, assignee: { kind: "OPAQUE_NULLABLE" }, created_at: { kind: "TIME", required: true } } })),
    ...["messaging", "calling", "notifications", "meeting-service", "developer-platform"].map((svc) => ({ source_service: svc, export_type: "incident.changed.v1", entity_type: "incident", classification: "OPERATIONS_MINIMIZED",
      fields: { status: { kind: "ENUM", required: true, enum: ["OPEN", "MITIGATED", "RESOLVED"] }, severity: { kind: "ENUM", required: true, enum: ["SEV1", "SEV2", "SEV3", "SEV4"] }, opened_at: { kind: "TIME", required: true }, resolved_at: { kind: "TIME_NULLABLE" } } })),
    { source_service: "developer-platform", export_type: "pricing.version.changed.v1", entity_type: "price_version", classification: "FINANCIAL_SENSITIVE",
      fields: { state: { kind: "ENUM", required: true, enum: ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "ACTIVE", "ROLLED_BACK", "FROZEN"] }, plan: { kind: "ENUM", required: true, enum: ["FREE", "PRO", "BUSINESS"] }, updated_at: { kind: "TIME", required: true } } },
  ],
};

function signingProfile() {
  return [
    "# CF Meet Admin Bridge signing profile v1 (HQ DRAFT)",
    "",
    "Mirrors the agreed interface (centralize-admin docs/product-admin/cfmeet-admin-parallel-workplan.md §3).",
    "",
    "- Transport: private network, TLS 1.3 mutual TLS, HQ client certificate pinned by fingerprint.",
    "- HMAC v2: hex HMAC-SHA256 over LF-joined `2`, `cosmicforge-hq-cfmeet-admin`, METHOD, exact request URI with query, unix seconds, nonce, hex sha256(body). Skew ±30 s; nonce single use.",
    "- request_digest: hex sha256 of METHOD LF URI LF `cfmeet` LF hex sha256(body).",
    "- Staff assertion: Ed25519 JWS, header exactly {alg:EdDSA, typ:JWT, kid}; claims iss, sub, aud, product=cfmeet, roles, permissions, market_scopes, organization_scopes, zone_scopes, tenant_scopes (always), session_id, auth_time, acr, jti, iat, nbf, exp (exp-iat ≤ 60), request_digest.",
    "- approval claim (required when the capability's approval is TWO_PERSON): {approval_id, capability, requester_ref, approver_ref, intent_digest, decided_at, expires_at}. Rejected if capability ≠ route, requester_ref ≠ sub, approver_ref = sub, expired, expires_at − decided_at > 43200 s, or approval_id reused.",
    "- Query shapes (exact order): " + Object.entries(SHAPES).map(([k, v]) => k + " = " + v.join(",")).join("; ") + ".",
    "- Purposes (hyphenated): support-review, verification-review, abuse-review, billing-review, pricing-change, ops-incident, release-request, privacy-request, admin-ui-capabilities, metrics-read, event-sync.",
    "",
  ].join("\n");
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const serialize = (v) => JSON.stringify(v, null, 1) + "\n";

function build() {
  fs.mkdirSync(OUT, { recursive: true });
  const files = {
    "openapi.json": serialize(openapi()),
    "CFMEET_ADMIN_CAPABILITY_MATRIX.json": serialize(matrix()),
    "event-adapters.v1.json": serialize(EVENTS),
    "signing-profile.md": signingProfile(),
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), text);
  const sums = Object.entries(files).map(([name, text]) => sha(Buffer.from(text)) + "  " + name).join("\n") + "\n";
  fs.writeFileSync(path.join(OUT, "SHA256SUMS"), sums);
  return { capabilities: CAPS.length, files: Object.keys(files).length + 1 };
}

if (require.main === module) console.log(JSON.stringify(build()));

module.exports = { build, CAPS, SHAPES, VERSION, OUT };
