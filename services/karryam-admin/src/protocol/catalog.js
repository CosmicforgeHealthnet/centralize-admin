"use strict";

// Karryam Product Admin catalog. Honest states only: nothing is advertised
// as usable unless this service can actually perform it. Domain reads
// belong to Section 6 and commands to Section 11; until then they are
// BLOCKED_DEPENDENCY or DISABLED with explicit blockers.

const { contracts } = require("../packages");
const { bridgeCapabilityState } = require("../bridge/capabilities");

const SECTION_6 = { code: "SECTION_6_DOMAIN_MODULE_NOT_IMPLEMENTED", detail: "Karryam domain module and certified owner adapter are not implemented yet" };
const NOT_CERTIFIED = { code: "COMMAND_EXECUTION_NOT_CERTIFIED", detail: "No certified owner-service execution path exists for this command" };
const SECTION_11 = { code: "SECTION_11_APPROVAL_NOT_ACTIVE", detail: "High-risk approval and execution controls are not activated" };
const BRIDGE_TRUST = { code: "BRIDGE_TRUST_NOT_ENROLLED", detail: "Bridge mTLS identity, HMAC key and staff signing key are not enrolled for this environment" };
const PIPELINE = { code: "SOURCE_EVENT_PIPELINE_NOT_IMPLEMENTED", detail: "Bridge source-event consumption and projections are later-phase work" };

function capability(id, kind, state, risk, description, { datasets = [], blockers = [], mfa = false, approval = false } = {}) {
  return { id, version: "1.0.0", kind, state, risk, description, datasets, blockers, requires_recent_mfa: mfa, requires_independent_approval: approval, request_schema: null };
}

const READS = [
  ["karryam.operations.overview.read", "Read Karryam operations overview aggregates", ["karryam.operations_daily"]],
  ["karryam.dispatch.read", "Read dispatch and delivery operations", []],
  ["karryam.taxi.read", "Read taxi ride operations", []],
  ["karryam.fleet.read", "Read fleet and vehicle operations", []],
  ["karryam.customers.read", "Read minimized customer account records", []],
  ["karryam.support.read", "Read support cases", []],
  ["karryam.verification.read", "Read provider verification cases", []],
  ["karryam.finance.read", "Read finance summaries", ["karryam.finance_daily"]],
];

const COMMANDS = [
  ["karryam.wallet.refund", "R4", "Refund a customer wallet transaction"],
  ["karryam.provider.verification.decide", "R3", "Approve or reject a provider verification step"],
  ["karryam.support.case.update", "R2", "Update a support case"],
  ["karryam.pricing.update", "R4", "Change pricing rules"],
];

function datasets() {
  return [
    contracts.withSchemaDigest({
      dataset_id: "karryam.operations_daily",
      version: "1.0.0",
      schema_id: "karryam.operations_daily",
      schema_digest: "sha256:" + "0".repeat(64),
      title: "Karryam daily operations aggregates",
      privacy_class: "INTERNAL",
      scope_dimensions: ["market", "organization", "zone"],
      authorized_departments: ["operations", "analytics"],
      semantic_grain: "DAY",
      units: ["count"],
      currency: null,
      freshness_target_seconds: 3600,
      lineage: { source_system: "karryam-backoffice-bridge", source_owner: "karryam-native-owner-services", derivation: "Daily aggregates derived by Karryam Admin from certified owner-service source events" },
      allowed_fields: [
        { name: "metric_id", type: "string", classification: "INTERNAL", meaning: "Approved metric identifier", unit: null },
        { name: "value", type: "number", classification: "INTERNAL", meaning: "Aggregate value for the reporting window", unit: null },
      ],
      metrics: [
        { metric_id: "karryam.trips_completed", version: "1.0.0", definition: "Count of trips completed in the reporting window", aggregation: "COUNT", grain: "DAY", unit: "count", currency: null },
      ],
      retention_days: 730,
      readiness: "NOT_CERTIFIED",
      blockers: [PIPELINE],
    }),
    contracts.withSchemaDigest({
      dataset_id: "karryam.finance_daily",
      version: "1.0.0",
      schema_id: "karryam.finance_daily",
      schema_digest: "sha256:" + "0".repeat(64),
      title: "Karryam daily finance aggregates",
      privacy_class: "CONFIDENTIAL",
      scope_dimensions: ["market", "organization"],
      authorized_departments: ["finance"],
      semantic_grain: "DAY",
      units: ["minor_currency"],
      currency: "NGN",
      freshness_target_seconds: 86400,
      lineage: { source_system: "karryam-backoffice-bridge", source_owner: "karryam-native-owner-services", derivation: "Daily booking value aggregates from certified owner-service ledgers" },
      allowed_fields: [
        { name: "metric_id", type: "string", classification: "INTERNAL", meaning: "Approved metric identifier", unit: null },
        { name: "value", type: "number", classification: "CONFIDENTIAL", meaning: "Aggregate monetary value in minor currency units", unit: "minor_currency" },
      ],
      metrics: [
        { metric_id: "karryam.gross_booking_value", version: "1.0.0", definition: "Sum of completed booking value in NGN minor units for the reporting window", aggregation: "SUM", grain: "DAY", unit: "minor_currency", currency: "NGN" },
      ],
      retention_days: 2555,
      readiness: "NOT_CERTIFIED",
      blockers: [PIPELINE],
    }),
  ];
}

function buildCatalog({ bridge }) {
  const bridgeState = bridgeCapabilityState(bridge);
  const capabilities = [
    capability("karryam.bridge.capabilities.read", "METADATA", bridgeState, "R0", "Discover Karryam Backoffice Bridge capability states (metadata only)", {
      blockers: bridgeState === "READ_ONLY" ? [] : [BRIDGE_TRUST], mfa: true,
    }),
    ...READS.map(([id, description, ds]) => capability(id, "READ", "BLOCKED_DEPENDENCY", "R1", description, { datasets: ds, blockers: [SECTION_6] })),
    ...COMMANDS.map(([id, risk, description]) => capability(id, "COMMAND", "DISABLED", risk, description, { blockers: [NOT_CERTIFIED, SECTION_11], mfa: true, approval: true })),
  ];
  const ds = datasets();
  const eventFamilies = [
    contracts.standardMetricObservationFamily({ family: "karryam.metric_observation", datasetId: "karryam.operations_daily", classification: "INTERNAL", status: "NOT_CERTIFIED" }),
  ];
  return { capabilities, datasets: ds, event_families: eventFamilies };
}

function findCapability(catalog, id) {
  return catalog.capabilities.find((c) => c.id === id) || null;
}

module.exports = { buildCatalog, findCapability };
