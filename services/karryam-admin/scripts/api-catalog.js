"use strict";

// Section 10 API catalog, generated from code (never hand-maintained):
//
//   node scripts/api-catalog.js            writes docs/product-admin/karryam-admin-api-catalog.json
//   node scripts/api-catalog.js --check    exits 1 when the committed catalog drifted
//
// Every Section 10.1 family is mapped to the existing generic routes (HQ
// gateway -> Product Integration Core -> Product Admin Protocol v1.1) and to
// exact pinned Bridge capabilities with their real methods and paths. States
// are computed for an unenrolled environment (the default): nothing appears
// operationally available unless it is.

const fs = require("node:fs");
const path = require("node:path");
const { contracts } = require("../src/packages");
const R = require("../src/bridge/contracts/registry");
const { PINNED_BRIDGE_CONTRACT } = require("../src/bridge/contracts");
const { MODULES, capabilityMap } = require("../src/modules/catalog");
const { REPORTS } = require("../src/modules/reports");
const { LOCAL } = require("../src/operations/service");

const OUT = path.join(__dirname, "..", "..", "..", "docs", "product-admin", "karryam-admin-api-catalog.json");
const DEFAULT_ENV = Object.freeze({ bridge: { enabled: false }, enabledCommands: [], highRiskCertified: [] });

// Protocol endpoint -> [HQ gateway route, PIC route] (both generic).
const ROUTES = {
  manifest: ["GET /api/products/{product}/manifest", "GET /internal/pic/v1/products/{product}/manifest"],
  capabilities: ["GET /api/products/{product}/capabilities", "GET /internal/pic/v1/products/{product}/capabilities"],
  datasets: ["GET /api/products/{product}/datasets", "GET /internal/pic/v1/products/{product}/datasets"],
  datasetSnapshots: [null, "PIC sync engine (service-to-service)"],
  events: [null, "PIC sync engine (service-to-service)"],
  eventsAck: [null, "PIC sync engine (service-to-service)"],
  syncStatus: ["GET /api/products/{product}/events/status", "GET /internal/pic/v1/products/{product}/events/status"],
  operationSubmit: ["POST /api/products/{product}/operations", "POST /internal/pic/v1/products/{product}/operations"],
  operationGet: ["GET /api/products/{product}/operations/{operationId}", "GET /internal/pic/v1/products/{product}/operations/{operationId}"],
  auditGet: ["GET /api/products/{product}/operations/{operationId}/audit", "GET /internal/pic/v1/products/{product}/operations/{operationId}/audit"],
  resourceList: ["GET /api/products/{product}/resources/{capabilityId}/{collectionId}", "GET /internal/pic/v1/products/{product}/resources/{capabilityId}/{collectionId}"],
  resourceGet: ["GET /api/products/{product}/resources/{capabilityId}/{collectionId}/{resourceId}", "GET /internal/pic/v1/products/{product}/resources/{capabilityId}/{collectionId}/{resourceId}"],
  reportGet: ["GET /api/products/{product}/reports/{reportId}", "GET /internal/pic/v1/products/{product}/reports/{reportId}"],
  healthLive: [null, "PIC health checker"],
  healthReady: [null, "PIC health checker"],
};
const METRIC_ROUTE = ["GET /api/products/{product}/metrics/{metricId}", "GET /internal/pic/v1/products/{product}/metrics/{metricId}", "HQ projection (derived outbox, Stage B)"];

const byPattern = (re) => R.CAPABILITIES.filter((c) => re.test(c.id)).map((c) => c.id);
const FAMILIES = [
  { family: "10.1.1 Integration", endpoints: ["manifest", "capabilities", "datasets", "syncStatus", "healthLive", "healthReady"], bridge: ["bridge.capabilities"],
    notes: "Signed manifest, capability states with the pinned contract revision and live Bridge discovery (cached as runtime snapshots), datasets, sync status, liveness/readiness." },
  { family: "10.1.2 Overview and metrics", endpoints: ["reportGet"], reports: REPORTS.map((r) => "karryam.report." + r.id), metrics: true, bridge: byPattern(/^analytics\.scoped\./).concat(["hq.projections.status"]),
    notes: "14 reports with source, grain, units, scope, coverage and freshness; unavailable sources answer explicit blockers, never invented values." },
  { family: "10.1.3 Resources", endpoints: ["resourceList", "resourceGet"], modules: MODULES.filter((m) => m.read).map((m) => m.read), bridgeKinds: ["READ"],
    notes: "Bounded, scoped, stably sorted reads of exact pinned collections with opaque continuation tokens bound to staff/scope/filters; every read audited." },
  { family: "10.1.4 Operations", endpoints: ["operationSubmit", "operationGet", "auditGet"], local: Object.keys(LOCAL), bridgeKinds: ["COMMAND", "RETRIEVAL"],
    notes: "Typed commands only; durable intent and audit before one dispatch; UNKNOWN_OUTCOME settled only by owner readback; R3/R4 need certification, runtime availability and an independent approval." },
  { family: "10.1.5 Events", endpoints: ["events", "eventsAck", "datasetSnapshots", "syncStatus"], bridge: ["hq.events.feed", "hq.events.ack", "hq.projections.status"],
    notes: "Stage A Bridge feed/ACK (worker) and Stage B derived HQ outbox, ACKs, snapshots and partition/quarantine/gap status." },
  { family: "10.1.6 Finance reports", endpoints: ["reportGet", "resourceList"], reports: ["karryam.report.wallet_by_currency", "karryam.report.payment_reconciliation"], bridge: ["hq.finance.report"],
    notes: "Read-oriented HQ interface; the Bridge adapter uses the source's real POST method. Per-currency minor units, never summed across currencies, wallet movement never revenue." },
  { family: "10.1.7 Support", endpoints: ["resourceList", "resourceGet", "operationSubmit", "reportGet"], reports: ["karryam.report.support_queue"], bridge: byPattern(/^support\./).concat(["hq.support.queue"]),
    notes: "Cases, SOS queue, case events/evidence (classified), controlled native actions through governed operations with owner readback." },
  { family: "10.1.8 Verification", endpoints: ["resourceList", "resourceGet", "operationSubmit", "reportGet"], reports: ["karryam.report.verification_pipeline"], bridge: byPattern(/^verification\./),
    notes: "Cases, stages, findings; decisions only through the source's independent decision workflow; automated recommendations are never approvals." },
  { family: "10.1.9 Campaigns", endpoints: ["operationSubmit", "operationGet", "resourceGet", "reportGet"], reports: ["karryam.report.marketing_evidence"], bridge: ["hq.campaigns.submit", "hq.campaigns.readback", "hq.campaigns.cancel"],
    notes: "Campaign intents, readback and cancellation; consent rechecked by the source; LOGGED_ONLY never reported as delivered. The HQ Marketing module remains the group-wide marketing application." },
  { family: "10.1.10 Privacy requests", endpoints: ["operationSubmit", "operationGet", "resourceGet"], bridge: ["hq.privacy.register", "hq.privacy.read", "hq.privacy.fulfilment"],
    notes: "Register, read, record fulfilment; fulfilled only on source-native confirmation; local erasure only after an owner-confirmed fulfilment and never under legal hold." },
  { family: "10.1.11 Exports", endpoints: ["operationSubmit", "operationGet"], bridge: ["hq.exports.create", "hq.exports.download", "hq.media.legacy-mapping"],
    notes: "Scoped export creation (R3: certification + independent approval); single-use, short-lived download through the source; download tokens never stored or returned in receipts." },
];

// Section 10.2: the 17 pinned HQ Bridge contracts (method + suffix verbatim).
const SECTION_10_2 = [
  ["hq.events.feed", "GET", "/hq/events"], ["hq.events.ack", "POST", "/hq/event-acknowledgements"], ["hq.projections.status", "GET", "/hq/projections/status"],
  ["hq.support.queue", "GET", "/hq/support/cases"], ["hq.approvals.propose", "POST", "/hq/approvals"], ["hq.approvals.read", "GET", "/hq/approvals/{approval_id}"],
  ["hq.approvals.decide", "POST", "/hq/approvals/{approval_id}/decisions"], ["hq.campaigns.submit", "POST", "/hq/campaigns"], ["hq.campaigns.readback", "GET", "/hq/campaign-operations/{operation_id}"],
  ["hq.campaigns.cancel", "POST", "/hq/campaign-operations/{operation_id}/cancellations"], ["hq.finance.report", "POST", "/hq/finance/reports"], ["hq.privacy.register", "POST", "/hq/privacy-requests"],
  ["hq.privacy.read", "GET", "/hq/privacy-requests/{request_id}"], ["hq.privacy.fulfilment", "POST", "/hq/privacy-requests/{request_id}/fulfilments"], ["hq.exports.create", "POST", "/hq/exports"],
  ["hq.media.legacy-mapping", "POST", "/hq/media/legacy-mappings"], ["hq.exports.download", "POST", "/hq/exports/{export_id}/download"],
];

function buildCatalog() {
  const map = new Map(capabilityMap(DEFAULT_ENV).map((e) => [e.bridge_capability_id, e]));
  const entry = (id) => {
    const e = map.get(id);
    if (!e) throw new Error("UNKNOWN_BRIDGE_CAPABILITY:" + id);
    return { bridge_capability_id: id, method: e.method, bridge_path: e.bridge_path, kind: e.kind, module: e.module, karryam_capability_id: e.karryam_capability_id, risk: e.risk, privacy: e.privacy, source_state: e.source_state, exposure_state: e.exposure_state, blocker_codes: e.blocker_codes };
  };
  const endpoint = (id) => {
    const ep = contracts.ENDPOINTS[id];
    if (!ep) throw new Error("UNKNOWN_PROTOCOL_ENDPOINT:" + id);
    return { protocol_endpoint: id, method: ep.method, product_admin_path: contracts.BASE_PATH + ep.path, auth: ep.auth, hq_gateway: ROUTES[id][0], pic: ROUTES[id][1] };
  };
  const families = FAMILIES.map((f) => {
    const bridge = f.bridge ? f.bridge.map(entry) : [];
    const kinds = f.bridgeKinds ? R.CAPABILITIES.filter((c) => f.bridgeKinds.includes(c.kind)).map((c) => entry(c.id)) : [];
    const all = [...bridge, ...kinds];
    const states = {};
    for (const b of all) states[b.exposure_state] = (states[b.exposure_state] || 0) + 1;
    return {
      family: f.family, notes: f.notes,
      endpoints: f.endpoints.map(endpoint),
      ...(f.metrics ? { metric_route: METRIC_ROUTE } : {}),
      ...(f.reports ? { reports: f.reports } : {}),
      ...(f.modules ? { module_read_capabilities: f.modules } : {}),
      ...(f.local ? { local_governance_commands: f.local } : {}),
      bridge_capability_count: all.length,
      exposure_states_unenrolled: states,
      ...(f.bridge ? { bridge_capabilities: bridge } : {}),
    };
  });
  return {
    catalog: "karryam-admin-api-catalog",
    protocol: { name: contracts.PROTOCOL_NAME, major: contracts.PROTOCOL_VERSION.major, minor: contracts.PROTOCOL_VERSION.minor, base_path: contracts.BASE_PATH },
    bridge_contract: { contract: PINNED_BRIDGE_CONTRACT.contract, version: PINNED_BRIDGE_CONTRACT.contract_version, source_commit: PINNED_BRIDGE_CONTRACT.source_commit, base_path: R.BRIDGE_BASE, capabilities: R.CAPABILITIES.length },
    exposure_environment: "unenrolled default (no Bridge enrollment, no enabled commands, no high-risk certification)",
    http_status_policy: Object.fromEntries(Object.entries(contracts.ERROR_CODES)),
    operation_states: ["REJECTED", "RECORDED", "DISPATCHING", "SUCCEEDED", "FAILED", "UNKNOWN_OUTCOME"],
    families,
    section_10_2_hq_bridge_contracts: SECTION_10_2.map(([id, method, suffix]) => ({ ...entry(id), specified_method: method, specified_suffix: suffix, matches_specification: entry(id).method === method && entry(id).bridge_path === R.BRIDGE_BASE + suffix })),
  };
}

if (require.main === module) {
  const json = JSON.stringify(buildCatalog(), null, 2) + "\n";
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : "";
    if (current !== json) { console.error("API catalog drift: run node scripts/api-catalog.js and review the change"); process.exit(1); }
    console.log("api catalog in sync");
  } else {
    fs.writeFileSync(OUT, json);
    console.log("wrote " + path.relative(process.cwd(), OUT));
  }
}

module.exports = { buildCatalog, SECTION_10_2, FAMILIES, OUT };
