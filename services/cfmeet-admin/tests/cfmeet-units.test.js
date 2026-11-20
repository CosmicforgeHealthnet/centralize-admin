"use strict";

// Functional suite: runs against HQ's interface-v1 target registry (see helpers/target-contract.js).
require("./helpers/target-contract");


// Unit coverage for the CF Meet-specific pieces: the strict schema compiler,
// the Bridge dataset-series -> HQ observation mapping, multi-owner event
// verification, and the bridge client's local approval-claim checks.

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, generateKeyPairSync, randomBytes } = require("node:crypto");
const { compileBridgeSchema, checkSchema } = require("../src/bridge/contracts/schema");
const D = require("../src/sync/datasets");
const { verifyEvent, ADAPTERS } = require("../src/sync/bridge-events");
const { createBridgeClient } = require("../src/bridge/client");
const X = require("./helpers/bridge-fixtures");

test("schema compiler: every supported keyword validates, unsupported ones fail at compile time", () => {
  const components = { Item: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } }, additionalProperties: false } };
  const v = compileBridgeSchema({
    type: "object", required: ["s", "n", "a", "o"], minProperties: 4, maxProperties: 10,
    properties: {
      s: { type: "string", minLength: 2, maxLength: 5, pattern: "^[a-z]+$" },
      n: { type: "number", minimum: 1, maximum: 10, exclusiveMinimum: 0, exclusiveMaximum: 11 },
      a: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { $ref: "#/components/schemas/Item" }, contains: { properties: { id: { const: "x" } } }, minContains: 1, maxContains: 1 },
      o: { type: "object", propertyNames: { pattern: "^[a-z]$" }, additionalProperties: { type: "integer" } },
      e: { enum: ["A", "B"] }, c: { const: 7 }, d: { type: "string", format: "date" }, t: { type: "string", format: "date-time" }, u: { type: "string", format: "uuid" },
      b: { type: "string", format: "binary" },
    },
    allOf: [{ required: ["s"] }], anyOf: [{ required: ["n"] }, { required: ["zz"] }], oneOf: [{ required: ["a"] }, { required: ["never"] }],
    not: { required: ["forbidden"] }, if: { required: ["e"] }, then: { required: ["c"] }, else: { not: { required: ["c"] } },
  }, components);
  const good = { s: "abc", n: 5, a: [{ id: "x" }, { id: "y" }], o: { k: 1 } };
  assert.equal(v(good).valid, true, JSON.stringify(v(good).errors));
  assert.equal(v({ ...good, e: "A", c: 7, d: "2026-11-19", t: "2026-11-19T10:00:00Z", u: randomUUID(), b: "raw" }).valid, true);
  const keywords = (value) => v(value).errors.map((e) => e.keyword);
  assert.ok(keywords({ ...good, s: "A" }).includes("pattern") && keywords({ ...good, s: "A" }).includes("minLength"));
  assert.ok(keywords({ ...good, s: "abcdef" }).includes("maxLength"));
  assert.deepEqual(keywords({ ...good, n: 0 }).sort(), ["exclusiveMinimum", "minimum"]);
  assert.deepEqual(keywords({ ...good, n: 11 }).sort(), ["exclusiveMaximum", "maximum"]);
  assert.ok(keywords({ ...good, a: [] }).includes("minItems"));
  assert.ok(keywords({ ...good, a: [{ id: "x" }, { id: "x" }] }).includes("uniqueItems"));
  assert.ok(keywords({ ...good, a: [{ id: "x" }, { id: "y" }, { id: "z" }, { id: "w" }] }).includes("maxItems"));
  assert.ok(keywords({ ...good, a: [{ id: "y" }] }).includes("contains"));
  assert.ok(keywords({ ...good, a: [{ id: "x" }, { id: "x", n: 1 }] }).includes("maxContains") || keywords({ ...good, a: [{ id: "x" }, { id: "x", n: 1 }] }).includes("additionalProperties"));
  assert.ok(keywords({ ...good, a: [{ nope: 1 }] }).includes("required"));
  assert.ok(keywords({ ...good, o: { KK: 1 } }).includes("pattern"), "propertyNames");
  assert.ok(keywords({ ...good, o: { k: "x" } }).includes("type"), "additionalProperties schema");
  assert.ok(keywords({ ...good, e: "C", c: 7 }).includes("enum"));
  assert.ok(keywords({ ...good, e: "A" }).includes("required"), "if/then");
  assert.ok(keywords({ ...good, c: 7 }).includes("not"), "if/else");
  assert.ok(keywords({ ...good, c: 8, e: "A" }).includes("const"));
  assert.ok(keywords({ ...good, forbidden: 1 }).includes("not"));
  assert.ok(keywords({ ...good, d: "2026-13-45" }).includes("format"));
  assert.ok(keywords({ ...good, t: "yesterday" }).includes("format"));
  assert.ok(keywords({ ...good, u: "not-a-uuid" }).includes("format"));
  assert.ok(keywords({ s: "abc", n: 5, a: [{ id: "x" }], o: {} }).length === 0);
  assert.ok(keywords({ s: "abc" }).includes("minProperties"));
  assert.ok(keywords({ ...good, p1: 1, p2: 2, p3: 3, p4: 4, p5: 5, p6: 6, p7: 7 }).includes("maxProperties"));
  assert.ok(keywords("x").includes("type"));
  assert.ok(compileBridgeSchema(false, components)(1).errors[0].keyword === "false");
  assert.equal(compileBridgeSchema(true, components)(1).valid, true);
  // anyOf/oneOf failures.
  const any = compileBridgeSchema({ anyOf: [{ type: "string" }, { type: "integer" }], oneOf: [{ type: "integer" }, { minimum: 0 }] }, components);
  assert.deepEqual(any(true).errors.map((e) => e.keyword), ["anyOf"], "minimum ignores non-numbers, so exactly one oneOf branch passes");
  assert.deepEqual(any(5).errors.map((e) => e.keyword), ["oneOf"], "matches both oneOf branches");
  // Depth limit and error cap.
  let deep = { type: "array" };
  for (let i = 0; i < 70; i += 1) deep = { type: "array", items: deep };
  let value = [];
  for (let i = 0; i < 70; i += 1) value = [value];
  assert.ok(compileBridgeSchema(deep, components)(value).errors.some((e) => e.keyword === "depth"));
  const many = compileBridgeSchema({ type: "array", items: { type: "string" } }, components)(Array.from({ length: 50 }, (_, i) => i));
  assert.equal(many.errors.length, 20, "errors are capped");
  // Compile-time refusals.
  assert.throws(() => checkSchema({ unevaluatedProperties: false }, components), /unsupported_schema_keyword/);
  assert.throws(() => checkSchema({ type: "string", format: "email" }, components), /unsupported_format/);
  assert.throws(() => checkSchema({ type: "decimal" }, components), /unsupported_type/);
  assert.throws(() => checkSchema({ $ref: "#/components/schemas/Missing" }, components), /unresolved_ref/);
  assert.throws(() => checkSchema({ $ref: "http://evil/schema" }, components), /unresolved_ref/);
  assert.throws(() => checkSchema([], components), /invalid_schema/);
  assert.throws(() => checkSchema({ pattern: "(" }, components));
  assert.doesNotThrow(() => checkSchema({ title: "x", description: "y", allOf: [true], properties: { a: { $ref: "#/components/schemas/Item" }, b: { $ref: "#/components/schemas/Item" } } }, components));
});

test("dataset series: per-day observations, honest coverage, unknown metrics and malformed series refused", () => {
  const def = D.BY_DATASET.get("cfmeet.meetings_daily");
  const at = new Date("2026-11-19T12:00:00Z").toISOString();
  const series = (over = {}) => ({ dataset_id: def.dataset_id, coverage: "COMPLETE", window: { start: "2026-11-18T00:00:00Z", end: at }, next_cursor: null,
    series: [{ date: "2026-11-18", metrics: { meetings: 12, participant_minutes: 340, peak_live_meetings: 4 } }, { date: "2026-11-19", metrics: { meetings: 3, participant_minutes: null } }], ...over });
  const obs = D.seriesObservations(def, series(), { observedAt: at });
  assert.equal(obs.length, 6, "every metric for every day");
  const one = (metric, day) => obs.find((o) => o.metric_id === def.dataset_id + "." + metric && o.window_start.startsWith(day));
  assert.equal(one("meetings", "2026-11-18").value, 12);
  assert.equal(one("participant_minutes", "2026-11-18").unit, "minute");
  assert.equal(one("participant_minutes", "2026-11-19").value_state, "UNAVAILABLE", "null is unknown");
  assert.equal(one("peak_live_meetings", "2026-11-19").value_state, "UNAVAILABLE", "missing is unknown");
  assert.equal(one("meetings", "2026-11-19").window_end, "2026-11-20T00:00:00.000Z");
  const partial = D.seriesObservations(def, series({ coverage: "PARTIAL" }), { observedAt: at });
  assert.ok(partial.every((o) => o.value === null && o.coverage === "PARTIAL" && o.observed_at === null));
  assert.ok(D.seriesObservations(def, series({ series: [{ date: "2026-11-18", metrics: { meetings: -1 } }] }), { observedAt: at }).every((o) => o.value === null), "negative counts are never published");
  const reason = (fn) => { try { fn(); return null; } catch (e) { return e.reason; } };
  assert.equal(reason(() => D.seriesObservations(D.BY_DATASET.get("cfmeet.sync_health"), series(), { observedAt: at })), "NOT_A_BRIDGE_DATASET");
  assert.equal(reason(() => D.seriesObservations(def, series({ dataset_id: "cfmeet.apps_daily" }), { observedAt: at })), "DATASET_MISMATCH");
  assert.equal(reason(() => D.seriesObservations(def, null, { observedAt: at })), "DATASET_MISMATCH");
  assert.equal(reason(() => D.seriesObservations(def, series({ series: [{ date: "19/11/2026", metrics: {} }] }), { observedAt: at })), "SERIES_DATE_INVALID");
  assert.equal(reason(() => D.seriesObservations(def, series({ series: [{ date: "2026-11-18", metrics: {} }, { date: "2026-11-18", metrics: {} }] }), { observedAt: at })), "SERIES_DATE_DUPLICATE");
  assert.equal(reason(() => D.seriesObservations(def, series({ series: [{ date: "2026-11-18", metrics: { revenue: 1 } }] }), { observedAt: at })), "SERIES_METRIC_UNKNOWN");
  assert.deepEqual(D.seriesObservations(def, series({ series: [] }), { observedAt: at }), []);
  // Manifest: 8 Bridge datasets + HQ-local sync health, honest readiness and units.
  const manifest = D.manifestDatasets(["cfmeet.meetings_daily"]);
  assert.equal(manifest.length, 9);
  assert.equal(manifest.find((d) => d.dataset_id === "cfmeet.meetings_daily").readiness, "CERTIFIED_BY_PRODUCT");
  assert.deepEqual(manifest.find((d) => d.dataset_id === "cfmeet.meetings_daily").units.sort(), ["count", "minute"]);
  assert.ok(manifest.filter((d) => d.dataset_id !== "cfmeet.meetings_daily").every((d) => d.readiness === "NOT_CERTIFIED" && d.blockers.length === 1));
  assert.equal(manifest.find((d) => d.dataset_id === "cfmeet.sync_health").freshness_target_seconds, 3600);
  assert.equal(D.manifestFamilies(["cfmeet.meetings_daily"]).find((f) => f.dataset_id === "cfmeet.meetings_daily").status, "ACTIVE");
  assert.deepEqual(D.BRIDGE_DATASETS.length, 8);
  assert.equal(D.observation("m", 1, "COMPLETE", at).window_start, "2026-11-19T00:00:00.000Z");
});

test("event verification: multi-owner adapters, every field kind and every refusal reason", () => {
  const scope = { market: "NG-LAGOS", organization: "cfmeet-ng", zone: "lagos-island", tenant: "tenant-a" };
  assert.equal(ADAPTERS.size, 13);
  const abuse = X.abuseEvent({ sequence: 1, scope });
  assert.equal(verifyEvent(abuse, scope).ok, true);
  for (const source of ["messaging", "calling", "communications", "meeting-service"]) assert.equal(verifyEvent({ ...abuse, source_service: source }, scope).ok, true, source);
  const incident = X.incidentEvent({ sequence: 2, scope });
  assert.equal(verifyEvent(incident, scope).ok, true);
  assert.equal(verifyEvent({ ...incident, payload: { ...incident.payload, resolved_at: new Date().toISOString() } }, scope).ok, true, "TIME_NULLABLE with a value");
  const partner = X.partnerEvent({ sequence: 3, scope });
  assert.equal(verifyEvent(partner, scope).ok, true);
  assert.equal(verifyEvent({ ...partner, payload: { ...partner.payload, live: "yes" } }, scope).reason, "PAYLOAD_FIELD_INVALID", "BOOL");
  assert.equal(verifyEvent({ ...partner, payload: { ...partner.payload, support_tier: null } }, scope).ok, true, "OPAQUE_NULLABLE");
  const verification = X.verificationEvent({ sequence: 4, scope });
  assert.equal(verifyEvent(verification, scope).ok, true);
  const tomb = X.abuseEvent({ sequence: 5, scope, tombstone: true });
  assert.equal(verifyEvent(tomb, scope).ok, true);
  assert.deepEqual(verifyEvent(tomb, scope).payload, {});
  const reasons = [
    [{ ...abuse, payload: { ...abuse.payload, pad: "x".repeat(20000) } }, "EVENT_TOO_LARGE"],
    [[abuse], "EVENT_SHAPE_INVALID"],
    [{ ...abuse, event_id: "not-a-uuid" }, "EVENT_SHAPE_INVALID"],
    [{ ...abuse, tombstone: "no" }, "EVENT_SHAPE_INVALID"],
    [{ ...abuse, sequence: 0 }, "SEQUENCE_INVALID"],
    [{ ...abuse, entity_version: 1.5 }, "SEQUENCE_INVALID"],
    [{ ...abuse, event_type: "abuse.report.purged.v1" }, "EVENT_TYPE_UNKNOWN"],
    [{ ...abuse, source_service: "notifications" }, "SOURCE_MISMATCH"],
    [{ ...abuse, entity_type: "incident" }, "ENTITY_TYPE_MISMATCH"],
    [{ ...abuse, occurred_at: "yesterday" }, "TIMESTAMP_INVALID"],
    [{ ...abuse, payload: [] }, "EVENT_SHAPE_INVALID"],
    [{ ...abuse, payload: { ...abuse.payload, severity: undefined } }, "PAYLOAD_FIELD_MISSING"],
    [{ ...abuse, payload: { ...abuse.payload, severity: "EXTREME" } }, "PAYLOAD_FIELD_INVALID"],
    [{ ...abuse, payload: { ...abuse.payload, created_at: "not-a-time" } }, "PAYLOAD_FIELD_INVALID"],
    [{ ...abuse, payload: { ...abuse.payload, assignee: "bad value!" } }, "PAYLOAD_FIELD_INVALID"],
    [{ ...abuse, market: "NG-ABUJA" }, "SCOPE_MISMATCH"],
    [{ ...abuse, scope: { ...abuse.scope, tenant: "tenant-z" } }, "SCOPE_MISMATCH"],
  ];
  for (const [ev, reason] of reasons) assert.equal(verifyEvent(ev, scope).reason, reason, reason);
  // An owner that does not record a dimension ("") matches the partition.
  assert.equal(verifyEvent({ ...abuse, scope: { ...abuse.scope, zone: "" } }, scope).ok, true);
  assert.equal(verifyEvent({ ...abuse, payload: { ...abuse.payload, extra: 1 } }, scope).reason, "PAYLOAD_FIELD_UNKNOWN");
});

test("bridge client: the approval claim is checked locally before anything is sent", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  // Unroutable test configuration: every case below is refused before any connection.
  const client = createBridgeClient({ enabled: true, hostname: "bridge.invalid", port: 9, address: "127.0.0.1", serviceKid: "s", staffKid: "k", issuer: "i", audience: "a", serviceKey: randomBytes(32), staffPrivateKey: privateKey, clientCert: "", clientKey: "", serverCa: "" });
  const scope = { market: "GLOBAL", organization: "cfmeet", zone: "production", tenant: "tenant-a" };
  const staff = { sub: "staff-1", sessionId: "s1", authTime: Math.floor(Date.now() / 1000) - 5, acr: "urn:cosmicforge:acr:mfa", role: "cfmeet.support", ...scope };
  const body = { operation_id: randomUUID(), idempotency_key: "idem-0000000000000001", reason_code: "CUSTOMER_REQUEST", expected_version: 1, requested_at: new Date().toISOString(), params: {} };
  const now = Date.now();
  const claim = (over = {}) => ({ approval_id: randomUUID(), capability: "accounts.users.status.update", requester_ref: "staff-1", approver_ref: "staff-2", intent_digest: "a".repeat(64),
    decided_at: new Date(now - 60000).toISOString(), expires_at: new Date(now + 3600000).toISOString(), ...over });
  const call = (id, approval, pathParams = { user_id: "user-1" }) => client.call(id, { staff, query: { ...scope, purpose: "support-review" }, pathParams, body, approval });
  const refused = async (id, approval, reason, pathParams) => assert.rejects(call(id, approval, pathParams), (e) => e.category === "REQUEST_REFUSED" && e.reason === reason, reason);
  await refused("accounts.users.status.update", undefined, "APPROVAL_CLAIM_REQUIRED");
  await refused("accounts.users.status.update", { ...claim(), extra: 1 }, "APPROVAL_CLAIM_INVALID");
  await refused("accounts.users.status.update", claim({ intent_digest: "sha256:" + "a".repeat(64) }), "APPROVAL_CLAIM_INVALID");
  await refused("accounts.users.status.update", claim({ expires_at: "tomorrow" }), "APPROVAL_CLAIM_INVALID");
  await refused("accounts.users.status.update", claim({ capability: "accounts.users.role.update" }), "APPROVAL_CAPABILITY_MISMATCH");
  await refused("accounts.users.status.update", claim({ requester_ref: "staff-9" }), "APPROVAL_REQUESTER_MISMATCH");
  await refused("accounts.users.status.update", claim({ approver_ref: "staff-1" }), "APPROVAL_NOT_INDEPENDENT");
  await refused("accounts.users.status.update", claim({ approver_ref: "" }), "APPROVAL_NOT_INDEPENDENT");
  await refused("accounts.users.status.update", claim({ decided_at: new Date(now - 13 * 3600000).toISOString(), expires_at: new Date(now + 60000).toISOString() }), "APPROVAL_LIFETIME_INVALID");
  await refused("accounts.users.status.update", claim({ decided_at: new Date(now - 7200000).toISOString(), expires_at: new Date(now - 60000).toISOString() }), "APPROVAL_EXPIRED");
  await refused("accounts.users.status.update", claim({ expires_at: new Date(now - 120000).toISOString() }), "APPROVAL_LIFETIME_INVALID");
  // A claim on a capability without TWO_PERSON is refused too.
  await refused("accounts.review-requests.submit", claim({ capability: "accounts.review-requests.submit" }), "APPROVAL_CLAIM_NOT_ALLOWED", {});
  // Staff scope must equal the request scope; a missing staff context is refused.
  await assert.rejects(client.call("accounts.review-requests.submit", { staff: { ...staff, tenant: "tenant-b" }, query: { ...scope, purpose: "support-review" }, body }), (e) => e.reason === "STAFF_SCOPE_MUST_EQUAL_REQUEST_SCOPE");
  await assert.rejects(client.call("accounts.review-requests.submit", { staff: null, query: { ...scope, purpose: "support-review" }, body }), (e) => e.reason === "STAFF_CONTEXT_REQUIRED");
  await assert.rejects(client.call("accounts.users.list", { staff, query: { ...scope, purpose: "support-review", limit: 5 }, body: {} }), (e) => e.reason === "REQUEST_BODY_NOT_ALLOWED");
  await assert.rejects(client.call("accounts.review-requests.submit", { staff, query: { ...scope, purpose: "support-review" }, body: { ...body, extra: 1 } }), (e) => e.reason === "REQUEST_BODY_INVALID");
});

test("approval consumption refuses every unsafe binding (shared rule for the PostgreSQL and memory stores)", () => {
  const { consumeErrors } = require("../src/db/approvals");
  const now = Date.now();
  const row = { status: "APPROVED", expires_at: new Date(now + 60000).toISOString(), capability_id: "cfmeet.x", intent_digest: "sha256:" + "a".repeat(64), scope: { market: ["M"], organization: ["O"] },
    requested_by: "staff-1", decided_by: "staff-2", expected_version: 3, certification_id: "cert-1", source_policy_revision: "p-1" };
  const binding = { capabilityId: "cfmeet.x", intentDigest: row.intent_digest, scope: { organization: ["O"], market: ["M"] }, requestedBy: "staff-1", expectedVersion: 3, certificationId: "cert-1", sourcePolicyRevision: "p-1" };
  assert.equal(consumeErrors(row, binding, now), null, "scope key order does not matter");
  const cases = [
    [null, {}, "APPROVAL_NOT_FOUND"],
    [{ status: "CONSUMED" }, {}, "APPROVAL_ALREADY_CONSUMED"],
    [{ status: "REVOKED" }, {}, "APPROVAL_REVOKED"],
    [{ status: "PROPOSED" }, {}, "APPROVAL_NOT_APPROVED"],
    [{ expires_at: new Date(now - 1).toISOString() }, {}, "APPROVAL_EXPIRED"],
    [{}, { capabilityId: "cfmeet.y" }, "APPROVAL_BINDING_MISMATCH"],
    [{}, { intentDigest: "sha256:" + "b".repeat(64) }, "APPROVAL_BINDING_MISMATCH"],
    [{}, { scope: { market: ["M"], organization: ["O2"] } }, "APPROVAL_BINDING_MISMATCH"],
    [{}, { requestedBy: "staff-9" }, "APPROVAL_REQUESTER_MISMATCH"],
    [{ decided_by: "staff-1" }, {}, "APPROVAL_REQUESTER_MISMATCH"],
    [{}, { expectedVersion: 4 }, "APPROVAL_SOURCE_VERSION_CHANGED"],
    [{}, { certificationId: "cert-2" }, "APPROVAL_CERTIFICATION_CHANGED"],
    [{}, { sourcePolicyRevision: "p-2" }, "APPROVAL_POLICY_CHANGED"],
    [{ certification_id: null, source_policy_revision: null }, { certificationId: undefined, sourcePolicyRevision: undefined }, null],
    [{ expected_version: null }, { expectedVersion: 99 }, null],
  ];
  for (const [rowOver, bindOver, reason] of cases) {
    const r = rowOver === null ? null : { ...row, ...rowOver };
    assert.equal(consumeErrors(r, { ...binding, ...bindOver }, now), reason, JSON.stringify([rowOver, bindOver]));
  }
});

test("Bridge error codes: definite refusals fail a command, ambiguous 5xx after sending is UNKNOWN_OUTCOME", () => {
  const { fromResponse, protocolMapping } = require("../src/bridge/errors");
  const cmd = (status, code) => fromResponse(status, code, { mutating: true });
  const read = (status, code) => fromResponse(status, code, { mutating: false });
  // Nothing was done: FAILED, never UNKNOWN_OUTCOME.
  for (const code of ["BRIDGE_DISABLED", "BRIDGE_UNAVAILABLE", "CAPABILITY_DISABLED", "POLICY_UNAVAILABLE", "AUDIT_UNAVAILABLE"]) {
    assert.equal(cmd(503, code).unknownOutcome, false, code);
  }
  // Sent, no clear answer: settle by readback only.
  for (const [status, code] of [[502, "UNKNOWN_OUTCOME"], [500, "INTERNAL"], [503, "OWNER_UNAVAILABLE"], [503, "SOMETHING_NEW"]]) assert.equal(cmd(status, code).unknownOutcome, true, code);
  const reason = (e) => protocolMapping(e).reason;
  assert.equal(reason(cmd(422, "OWNER_REFUSED")), "OWNER_REFUSED");
  assert.equal(reason(cmd(409, "APPROVAL_REUSED")), "SOURCE_APPROVAL_UNUSABLE");
  assert.equal(reason(cmd(409, "IDEMPOTENCY_CONFLICT")), "SOURCE_IDEMPOTENCY_CONFLICT");
  assert.equal(reason(cmd(409, "REPLAY")), "BRIDGE_REPLAY_REJECTED");
  assert.equal(reason(read(404, "RESOURCE_NOT_FOUND")), "SOURCE_NOT_FOUND");
  assert.equal(reason(read(404, "CAPABILITY_NOT_FOUND")), "BRIDGE_CONTRACT_MISMATCH");
  assert.equal(reason(read(503, "OWNER_UNAVAILABLE")), "SOURCE_UNAVAILABLE");
  assert.equal(reason(read(503, "POLICY_UNAVAILABLE")), "SOURCE_POLICY_UNAVAILABLE");
  assert.equal(reason(read(400, "QUERY_INVALID")), "SOURCE_REJECTED_SCOPE_OR_QUERY");
  assert.equal(reason(read(401, "STAFF_ASSERTION_INVALID")), "BRIDGE_AUTHENTICATION_REJECTED");
  assert.equal(reason(read(403, "SCOPE_DENIED")), "SOURCE_FORBIDDEN");
  assert.equal(reason(read(429, "RATE_LIMITED")), "SOURCE_RATE_LIMITED");
});
