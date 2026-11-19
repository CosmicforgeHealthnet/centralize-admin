"use strict";

// Section 10 API catalog, generated from code (never hand-maintained):
//
//   node scripts/api-catalog.js            writes docs/product-admin/cfmeet-admin-api-catalog.json
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

const OUT = path.join(__dirname, "..", "..", "..", "docs", "product-admin", "cfmeet-admin-api-catalog.json");
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
  { family: "10.1.1 Integration", endpoints: ["manifest", "capabilities", "datasets", "syncStatus", "healthLive", "healthReady"], bridge: ["bridge.capabilities.read", "bridge.health.read"],
    notes: "Signed manifest, capability states with the pinned contract revision and live Bridge discovery (cached as runtime snapshots only when the running Bridge's openapi_sha256 equals the pin), datasets, sync status, liveness/readiness." },
  { family: "10.1.2 Overview and metrics", endpoints: ["reportGet"], reports: REPORTS.map((r) => "cfmeet.report." + r.id), metrics: true, bridge: byPattern(/\.(summary|estimate)$/).concat(["operations.health.read", "hq.projections.status", "bridge.datasets.read"]),
    notes: "Reports with source, grain, units, scope, coverage and freshness, and the 8 Bridge datasets as daily metric observations; unavailable sources answer explicit blockers, never invented values." },
  { family: "10.1.3 Resources", endpoints: ["resourceList", "resourceGet"], modules: MODULES.filter((m) => m.read).map((m) => m.read), bridgeKinds: ["READ"],
    notes: "Bounded, zone- and tenant-scoped reads of exact pinned collections with opaque continuation tokens bound to staff/scope/filters; every read audited." },
  { family: "10.1.4 Operations", endpoints: ["operationSubmit", "operationGet", "auditGet"], local: Object.keys(LOCAL), bridgeKinds: ["COMMAND", "RETRIEVAL"],
    notes: "Typed commands only; durable intent and audit before one dispatch; UNKNOWN_OUTCOME settled only by owner readback; TWO_PERSON and R3/R4 need an independent approval (12 h maximum) carried to the Bridge as the approval claim." },
  { family: "10.1.5 Events", endpoints: ["events", "eventsAck", "datasetSnapshots", "syncStatus"], bridge: ["hq.events.feed", "hq.events.ack", "hq.projections.status", "bridge.datasets.read"],
    notes: "Stage A Bridge feed/ACK and dataset pulls (worker) and Stage B derived HQ outbox, ACKs, snapshots and partition/quarantine/gap status." },
  { family: "10.1.6 Finance reports", endpoints: ["reportGet"], reports: ["cfmeet.report.finance_usage", "cfmeet.report.estimated_charges", "cfmeet.report.plan_spread"], bridge: byPattern(/^finance\./),
    notes: "Per-currency minor units, never summed across currencies; estimated charges are estimates, never invoices or recognized revenue." },
  { family: "10.1.7 Trust and safety", endpoints: ["resourceList", "resourceGet", "operationSubmit", "reportGet"], reports: ["cfmeet.report.safety_queue"], bridge: byPattern(/^(messaging|calling|communications)\./).concat(byPattern(/^meetings\.reports\./)),
    notes: "Abuse reports, moderation, holds and off-switches; no message, call or meeting content; high-risk actions need a second approver." },
  { family: "10.1.8 Verification", endpoints: ["resourceList", "resourceGet", "operationSubmit", "reportGet"], reports: ["cfmeet.report.verification_queue"], bridge: byPattern(/^verification\./),
    notes: "Shared cross-product case shape; go-live, app review and publish decisions only through propose, independent decide and run; automated recommendations are never approvals." },
  { family: "10.1.9 Pricing and plans", endpoints: ["resourceList", "resourceGet", "operationSubmit"], bridge: byPattern(/^pricing\./),
    notes: "Free / Pro / Business plans; draft and submit by editors, approve, activate, roll back and freeze by approvers with a second person; simulations never change prices." },
  { family: "10.1.10 Privacy requests", endpoints: ["operationSubmit", "operationGet", "resourceList", "resourceGet"], bridge: byPattern(/^privacy\./),
    notes: "Register and read requests; per-service completion recorded by each owner; nothing personal in HQ views." },
  { family: "10.1.11 Operations and releases", endpoints: ["operationSubmit", "operationGet", "resourceList", "reportGet"], reports: ["cfmeet.report.operations_health", "cfmeet.report.incidents"], bridge: byPattern(/^operations\./),
    notes: "Health, incidents, switches and feature switch-on requests (release managers; second approver); switch flips are R4." },
];

// Section 10.2: the fixed platform contracts agreed with the CF Meet Bridge
// (interface v1; method + suffix verbatim).
const SECTION_10_2 = [
  ["bridge.capabilities.read", "GET", "/capabilities"], ["bridge.health.read", "GET", "/health/aggregate"], ["bridge.datasets.read", "GET", "/datasets/{dataset_id}"],
  ["hq.events.feed", "GET", "/hq/events"], ["hq.events.ack", "POST", "/hq/event-acknowledgements"], ["hq.projections.status", "GET", "/hq/projections/status"],
];

function buildCatalog() {
  const map = new Map(capabilityMap(DEFAULT_ENV).map((e) => [e.bridge_capability_id, e]));
  const entry = (id) => {
    const e = map.get(id);
    if (!e) throw new Error("UNKNOWN_BRIDGE_CAPABILITY:" + id);
    return { bridge_capability_id: id, method: e.method, bridge_path: e.bridge_path, kind: e.kind, module: e.module, cfmeet_capability_id: e.cfmeet_capability_id, risk: e.risk, privacy: e.privacy, source_state: e.source_state, exposure_state: e.exposure_state, blocker_codes: e.blocker_codes };
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
    catalog: "cfmeet-admin-api-catalog",
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
