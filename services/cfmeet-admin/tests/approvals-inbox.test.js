"use strict";

// Functional suite: runs against HQ's interface-v1 target registry (see helpers/target-contract.js).
require("./helpers/target-contract");

// Approvals inbox (design section 10): cfmeet.governance.read over the local
// two-person approval records, end to end through Protocol 1.1 with
// request-bound delegations on the memory stores. Proves: "waiting for me"
// lists only approvals the caller could decide now, "my requests" lists the
// caller's own, detail is visible only to the requester or an eligible
// approver, scope and query denials fail closed, sealed paging, audit and
// sensitive-access records, and that no body value or forbidden field leaves.

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const F = require("./helpers/fixtures");
const { memoryAudit } = require("../src/audit");
const { memoryOperations } = require("../src/db/operations");
const { memoryAccessLog } = require("../src/db/access-log");
const { memoryApprovals } = require("../src/db/approvals");
const { FORBIDDEN_FIELD } = require("../src/modules/reads");
const { approverIneligibility, decidableBy } = require("../src/operations/service");
const { itemOf, parseQuery } = require("../src/modules/approvals-inbox");

const BASE = F.contracts.BASE_PATH;
const READ = "cfmeet.governance.read";
const CAP = "cfmeet.accounts.review-requests.submit";
const SCOPE = Object.freeze({ market: "NG-LAGOS", organization: "cfmeet-ng", zone: "lagos-island", tenant: "tenant-a" });
const scopeArrays = { market: [SCOPE.market], organization: [SCOPE.organization], zone: [SCOPE.zone], tenant: [SCOPE.tenant] };
const ITEM_KEYS = ["approval_id", "approver_ref", "capability", "created_at", "decided_at", "expired", "expires_at", "intent_digest", "intent_summary", "requester_ref", "risk", "status"];
const SUMMARY_KEYS = ["capability", "case_reference", "expected_version", "reason_code", "scope", "target"];
const digest = (c) => "sha256:" + c.repeat(64);

async function inbox(t, { config: over = {}, deps = {} } = {}) {
  const m = F.material();
  const config = Object.freeze({ ...F.loadConfig(F.enabledEnv(m)), cursorKey: randomBytes(32), ...over });
  const audit = deps.audit || memoryAudit();
  const accessLog = deps.accessLog || memoryAccessLog();
  // The store's own clock moves one second per proposal so "newest first" is exact.
  let clock = Date.now();
  const approvals = deps.approvals || memoryApprovals({ now: () => (clock += 1000) });
  const app = await F.startApp(config, { audit, operations: memoryOperations(audit), accessLog, approvals });
  t.after(async () => { await app.close(); m.cleanup(); });
  const client = F.hqClient(app.target, m.hqKey);
  const service = F.clients.createServiceClient({ target: app.target, auth: { serviceId: F.SERVICE_ID, keyId: "pic-k1", key: m.hqKey } });
  const delegate = (uri, { method = "GET", body, action = "resource.read", scope = scopeArrays, ...claims } = {}) =>
    F.delegation(m, { method, uri, body, action, role: "cfmeet.capabilities.viewer", scope, ...claims });
  // GET through the protocol with a delegation bound to the exact request.
  const get = (path, query = {}, claims = {}) => {
    const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined));
    const qs = new URLSearchParams(clean).toString();
    const uri = BASE + "/resources/" + path + (qs ? "?" + qs : "");
    return service.request({ method: "GET", path: BASE + "/resources/" + path, query: qs ? clean : undefined, delegation: delegate(uri, claims) });
  };
  const local = async (capability_id, params, claims = {}, over2 = {}) => {
    const cmd = { command_id: randomUUID(), idempotency_key: "idem-" + randomUUID(), capability_id, target: { type: "user", id: "user-1", expected_version: 3 }, params, reason_code: "CUSTOMER_REQUEST", case_reference: "case-9", scope: scopeArrays, ...over2 };
    const res = await client.submitOperation(cmd, { delegation: delegate(BASE + "/operations", { method: "POST", body: cmd, action: "operation.submit", ...claims }) });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json.result.approval;
  };
  const propose = (claims = {}, over2 = {}) => local("cfmeet.governance.approval.propose", { capability_id: CAP, intent_digest: digest("a"), ttl_seconds: 600, expected_version: 3 }, claims, over2);
  const decide = (approvalId, sub, decision = "APPROVE") => local("cfmeet.governance.approval.decide", { approval_id: approvalId, decision }, { sub });
  const q = (extra = {}) => ({ market: SCOPE.market, organization: SCOPE.organization, purpose: "support-review", ...extra });
  return { m, config, app, audit, accessLog, approvals, get, propose, decide, q, setClock: (v) => { clock = v; } };
}

function keysDeep(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); keysDeep(v, out); }
  return out;
}

test("approvals inbox: waiting for me lists only what the caller may decide; my requests lists the caller's own, newest first", async (t) => {
  const h = await inbox(t);
  const a1 = await h.propose();
  const a2 = await h.propose({}, { target: { type: "meeting", id: "meeting-7", expected_version: null }, case_reference: null, reason_code: "ABUSE_REPORT" });
  const b1 = await h.propose({ sub: "staff-99" });

  const mine = await h.get(READ + "/approvals-mine", h.q());
  assert.equal(mine.status, 200, JSON.stringify(mine.json));
  const r = mine.json.result;
  assert.deepEqual([r.module, r.capability_id, r.collection_id, r.kind], ["governance", READ, "approvals-mine", "LIST"]);
  assert.deepEqual(r.scope, { market: SCOPE.market, organization: SCOPE.organization });
  assert.deepEqual(r.source, { kind: "LOCAL", owner: "cfmeet-admin", privacy: "INTERNAL", risk: "R1" });
  assert.deepEqual(r.data.items.map((i) => i.approval_id), [a2.approval_id, a1.approval_id], "newest first, only the caller's own");
  assert.equal(r.continuation, null);
  assert.equal(r.has_more, false);
  assert.equal(mine.json.coverage, "COMPLETE");
  const item = r.data.items[1];
  assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS);
  assert.deepEqual(Object.keys(item.intent_summary).sort(), SUMMARY_KEYS);
  assert.deepEqual(item, {
    approval_id: a1.approval_id, capability: CAP, status: "PROPOSED", risk: a1.risk, expired: false, requester_ref: "staff-17", approver_ref: null,
    intent_summary: { capability: CAP, target: { type: "user", id: "user-1" }, expected_version: 3, reason_code: "CUSTOMER_REQUEST", case_reference: "case-9", scope: scopeArrays },
    intent_digest: digest("a"), created_at: a1.requested_at, decided_at: null, expires_at: a1.expires_at,
  });
  assert.deepEqual(r.data.items[0].intent_summary.target, { type: "meeting", id: "meeting-7" });
  assert.equal(r.data.items[0].intent_summary.case_reference, null);
  assert.equal(r.data.items[0].intent_summary.expected_version, 3, "the bound expected version comes from the proposal params");
  // Nothing from any request body and no forbidden field name.
  assert.deepEqual(keysDeep(mine.json).filter((k) => FORBIDDEN_FIELD.test(k)), []);
  assert.equal(JSON.stringify(mine.json).includes("\"body\""), false);

  // The requester never sees their own approvals as waiting for them.
  const mePending = await h.get(READ + "/approvals-pending", h.q());
  assert.deepEqual(mePending.json.result.data.items.map((i) => i.approval_id), [b1.approval_id]);
  // A second staff member sees the others' proposals; a decision removes it.
  const other = (sub) => h.get(READ + "/approvals-pending", h.q(), { sub });
  assert.deepEqual((await other("staff-99")).json.result.data.items.map((i) => i.approval_id), [a2.approval_id, a1.approval_id]);
  await h.decide(a1.approval_id, "staff-99");
  assert.deepEqual((await other("staff-99")).json.result.data.items.map((i) => i.approval_id), [a2.approval_id]);
  const after = (await h.get(READ + "/approvals-mine", h.q())).json.result.data.items.find((i) => i.approval_id === a1.approval_id);
  assert.deepEqual([after.status, after.approver_ref, typeof after.decided_at], ["APPROVED", "staff-99", "string"]);
  // Rejected and revoked proposals leave "waiting for me" too.
  await h.decide(a2.approval_id, "staff-55", "REJECT");
  assert.deepEqual((await other("staff-99")).json.result.data.items, []);

  // Optional zone/tenant narrow the view; a zone no approval has gives nothing.
  assert.equal((await h.get(READ + "/approvals-mine", h.q({ zone: SCOPE.zone, tenant: SCOPE.tenant }))).json.result.data.items.length, 2);
  const narrow = await h.get(READ + "/approvals-mine", h.q({ zone: "ikeja" }), { scope: { ...scopeArrays, zone: [SCOPE.zone, "ikeja"] } });
  assert.deepEqual(narrow.json.result.data.items, []);

  // Audited like every other read: integration audit and sensitive-access record.
  const reads = h.audit.rows.filter((a) => a.action === "resource.read" && a.outcome === "READ_AUTHORIZED");
  assert.ok(reads.some((a) => a.metadata.module === "governance" && a.metadata.collection === "approvals-mine" && a.metadata.items === 2));
  assert.ok(h.accessLog.rows.some((a) => a.capabilityId === READ + ":approvals-pending" && a.outcome === "READ_AUTHORIZED" && a.purpose === "support-review" && a.scope.market === SCOPE.market));
});

test("waiting for me applies the decide path's second-person rule: whole scope, independence, open and unexpired", async (t) => {
  const h = await inbox(t);
  const open = await h.propose();
  // Expired proposal (the store's clock is moved into the past for it).
  h.setClock(Date.now() - 7200 * 1000);
  const old = await h.approvals.propose({ id: randomUUID(), capabilityId: CAP, intentDigest: digest("b"), scope: scopeArrays, requestedBy: "staff-17", ttlSeconds: 60, risk: "R2" });
  h.setClock(Date.now());
  // A high-risk proposal: with no Bridge enrollment the approver role cannot be verified.
  const high = await h.approvals.propose({ id: randomUUID(), capabilityId: "cfmeet.accounts.users.status.update", intentDigest: digest("c"), scope: scopeArrays, requestedBy: "staff-17", ttlSeconds: 600, risk: "R3" });
  // A proposal for a zone the approver does not hold.
  const foreign = await h.approvals.propose({ id: randomUUID(), capabilityId: CAP, intentDigest: digest("d"), scope: { ...scopeArrays, zone: ["ikeja"] }, requestedBy: "staff-17", ttlSeconds: 600, risk: "R2" });

  const pending = (claims) => h.get(READ + "/approvals-pending", h.q(), { sub: "staff-99", ...claims }).then((r) => r.json.result.data.items.map((i) => i.approval_id));
  const ids = await pending();
  assert.ok(ids.includes(open.approval_id));
  for (const hidden of [old, high, foreign]) assert.equal(ids.includes(hidden.approval_id), false, hidden.capability_id);
  // A delegation that does not name zones/tenants never means "every zone".
  assert.deepEqual(await pending({ scope: { market: [SCOPE.market], organization: [SCOPE.organization] } }), []);
  // The requester still sees every one of their requests, expired ones flagged.
  const mine = (await h.get(READ + "/approvals-mine", h.q(), { scope: { ...scopeArrays, zone: [SCOPE.zone, "ikeja"] } })).json.result.data.items;
  assert.equal(mine.find((i) => i.approval_id === old.approval_id).expired, true);
  assert.equal(mine.find((i) => i.approval_id === old.approval_id).status, "PROPOSED");
  assert.equal(mine.find((i) => i.approval_id === open.approval_id).expired, false);
  assert.equal(mine.find((i) => i.approval_id === high.approval_id).intent_summary.target, null, "store rows without a recorded target show none");
  // A requester whose scope no longer covers an approval does not see it.
  assert.equal((await h.get(READ + "/approvals-mine", h.q())).json.result.data.items.some((i) => i.approval_id === foreign.approval_id), false);
});

test("the second-person rule is the decide path's own: high risk needs a verifiable approved Bridge role", () => {
  const record = { approval_id: randomUUID(), status: "PROPOSED", risk: "R3", scope: { market: ["M"], organization: ["O"] }, requested_by: "a", expires_at: new Date(Date.now() + 60000).toISOString() };
  const nowS = Math.floor(Date.now() / 1000);
  const staff = (claims = {}) => ({ sub: "b", mfa_at: nowS - 10, role: "cfmeet.approver", scope: { market: ["M"], organization: ["O"] }, ...claims });
  const bridge = { enabled: true, roleMap: { "cfmeet.approver": "pricing.approver" }, market: "M", organization: "O", mfaMaxAgeSeconds: 300 };
  const config = { bridge };
  assert.equal(approverIneligibility(record, staff(), { config, nowS }), null);
  assert.equal(approverIneligibility(record, staff({ role: "cfmeet.viewer" }), { config, nowS }), "APPROVER_ROLE_NOT_APPROVED");
  assert.equal(approverIneligibility(record, staff(), { config: { bridge: { enabled: false } }, nowS }), "APPROVER_ROLE_NOT_VERIFIABLE");
  assert.equal(approverIneligibility(record, staff({ scope: { market: ["M"], organization: ["X"] } }), { config, nowS }), "APPROVER_SCOPE_INSUFFICIENT");
  // Revocation uses the scope rule only.
  assert.equal(approverIneligibility(record, staff({ role: "cfmeet.viewer" }), { config, nowS, decide: false }), null);
  const nowMs = Date.now();
  assert.equal(decidableBy(record, staff(), { config, nowMs }), true);
  assert.equal(decidableBy(record, staff({ sub: "a" }), { config, nowMs }), false, "never the requester");
  assert.equal(decidableBy({ ...record, status: "APPROVED" }, staff(), { config, nowMs }), false);
  assert.equal(decidableBy({ ...record, expires_at: new Date(nowMs - 1).toISOString() }, staff(), { config, nowMs }), false);
  // The fixed item view never carries a body or unbounded fields.
  const view = itemOf({ ...record, capability_id: "cfmeet.x", intent_digest: digest("e"), requested_at: new Date(nowMs).toISOString(), decided_by: null, decided_at: null, expected_version: null, target_type: "user", target_id: "u-1", request_reason_code: "R_X", case_reference: null, consumed_by: randomUUID(), certification_id: randomUUID() }, nowMs);
  assert.deepEqual(Object.keys(view).sort(), ITEM_KEYS);
  assert.equal(JSON.stringify(view).includes("consumed_by") || JSON.stringify(view).includes("certification"), false);
  assert.throws(() => parseQuery(new URLSearchParams("market=M&organization=O&purpose=support-review&market=N"), { list: true }), (e) => e.reason === "DUPLICATE_PARAMETER");
  assert.throws(() => parseQuery(new URLSearchParams("market=M&organization=O&purpose=support-review&zone=" + "z".repeat(2049)), { list: true }), (e) => e.reason === "PARAMETER_TOO_LONG");
  assert.throws(() => parseQuery(new URLSearchParams("market=M&organization=O&purpose=support-review&zone=a%20b"), { list: true }), (e) => e.reason === "SCOPE_INVALID");
  assert.throws(() => parseQuery(new URLSearchParams("market=M&organization=O&purpose=support-review&continuation=short"), { list: true }), (e) => e.reason === "CONTINUATION_INVALID");
});

test("detail is visible only to the requester or an eligible approver; anything else answers like an unknown ID", async (t) => {
  const h = await inbox(t);
  const a = await h.propose();
  const high = await h.approvals.propose({ id: randomUUID(), capabilityId: "cfmeet.accounts.users.status.update", intentDigest: digest("c"), scope: scopeArrays, requestedBy: "staff-17", ttlSeconds: 600, risk: "R3" });
  const detail = (id, claims = {}, query = h.q()) => h.get(READ + "/approvals/" + id, query, claims);

  const own = await detail(a.approval_id);
  assert.equal(own.status, 200, JSON.stringify(own.json));
  assert.equal(own.json.result.kind, "DETAIL");
  assert.equal(own.json.result.data.approval_id, a.approval_id);
  assert.deepEqual(Object.keys(own.json.result.data).sort(), ITEM_KEYS);
  assert.equal(own.json.result.continuation, null);
  const approver = await detail(a.approval_id, { sub: "staff-99" });
  assert.equal(approver.status, 200);
  // Still visible to an eligible approver after the decision (status shown).
  await h.decide(a.approval_id, "staff-99");
  assert.equal((await detail(a.approval_id, { sub: "staff-55" })).json.result.data.status, "APPROVED");

  const notFound = [
    await detail(randomUUID()),
    await detail("not-a-uuid"),
    await detail(a.approval_id, { sub: "staff-99", scope: { ...scopeArrays, zone: ["ikeja"] } }, h.q()),
    await detail(a.approval_id, { scope: { ...scopeArrays, zone: [SCOPE.zone, "ikeja"] } }, h.q({ zone: "ikeja" })),
    await detail(high.approval_id, { sub: "staff-99" }),
  ];
  for (const res of notFound) {
    assert.equal(res.status, 404, JSON.stringify(res.json));
    assert.deepEqual([res.json.error.code, res.json.error.reason], ["NOT_FOUND", "APPROVAL_NOT_FOUND"]);
    assert.equal(res.json.result, null);
  }
  assert.equal((await detail(high.approval_id)).status, 200, "the requester sees their own high-risk request");
  assert.ok(h.audit.rows.some((r) => r.outcome === "READ_NOT_FOUND" && r.metadata.collection === "approvals"));

  // Collection shapes are strict.
  assert.equal((await h.get(READ + "/approvals", h.q())).json.error.reason, "COLLECTION_REQUIRES_RESOURCE_ID");
  assert.equal((await h.get(READ + "/approvals-mine/" + a.approval_id, h.q())).json.error.reason, "COLLECTION_IS_NOT_A_DETAIL");
  assert.equal((await detail(a.approval_id, {}, h.q({ limit: "5" }))).json.error.reason, "UNKNOWN_OR_UNSUPPORTED_PARAMETER");
});

test("scope, delegation and query denials fail closed before any store read", async (t) => {
  let reads = 0;
  const store = memoryApprovals();
  const counted = { ...store, list: (f) => { reads += 1; return store.list(f); }, get: (id) => { reads += 1; return store.get(id); } };
  const h = await inbox(t, { deps: { approvals: counted } });
  const list = (query, claims) => h.get(READ + "/approvals-pending", query, claims).then((r) => [r.status, r.json.error && r.json.error.reason]);
  const nowS = Math.floor(Date.now() / 1000);
  const cases = [
    [h.q(), { action: "report.read" }, 403, "DELEGATION_ACTION_MISMATCH"],
    [h.q(), { action: "operation.read" }, 403, "DELEGATION_ACTION_MISMATCH"],
    [h.q({ market: "GH-ACCRA" }), {}, 403, "SCOPE_NOT_GRANTED"],
    [h.q({ organization: "other-org" }), {}, 403, "SCOPE_NOT_GRANTED"],
    [h.q({ zone: "ikeja" }), {}, 403, "ZONE_NOT_GRANTED"],
    [h.q({ tenant: "tenant-b" }), {}, 403, "TENANT_NOT_GRANTED"],
    [h.q({ zone: SCOPE.zone }), { scope: { market: [SCOPE.market], organization: [SCOPE.organization] } }, 403, "ZONE_NOT_GRANTED"],
    [h.q(), { mfa_at: nowS - 900 }, 403, "RECENT_MFA_REQUIRED"],
    [h.q(), { mfa_at: null }, 403, "RECENT_MFA_REQUIRED"],
    [{ organization: SCOPE.organization, purpose: "support-review" }, {}, 400, "SCOPE_MARKET_REQUIRED"],
    [{ market: SCOPE.market, purpose: "support-review" }, {}, 400, "SCOPE_ORGANIZATION_REQUIRED"],
    [h.q({ purpose: undefined }), {}, 400, "PURPOSE_REQUIRED"],
    [h.q({ purpose: "curiosity" }), {}, 400, "PURPOSE_NOT_ALLOWED"],
    [h.q({ q: "ada" }), {}, 400, "UNKNOWN_OR_UNSUPPORTED_PARAMETER"],
    [h.q({ parent: "user-1" }), {}, 400, "UNKNOWN_OR_UNSUPPORTED_PARAMETER"],
    [h.q({ start: new Date().toISOString() }), {}, 400, "UNKNOWN_OR_UNSUPPORTED_PARAMETER"],
    [h.q({ limit: "0" }), {}, 400, "LIMIT_OUT_OF_BOUNDS"],
    [h.q({ limit: "101" }), {}, 400, "LIMIT_OUT_OF_BOUNDS"],
  ];
  for (const [query, claims, status, reason] of cases) assert.deepEqual(await list(query, claims), [status, reason], reason + " " + JSON.stringify(query));
  assert.deepEqual([(await h.get(READ + "/approvals-later", h.q())).status, (await h.get(READ + "/approvals-later", h.q())).json.error.reason], [404, "UNKNOWN_COLLECTION"]);
  assert.equal(reads, 0, "nothing was read from the store");
});

test("no audit, no data; an unavailable store is reported, never an empty inbox", async (t) => {
  const h = await inbox(t, { deps: { accessLog: memoryAccessLog({ fail: true }) } });
  const res = await h.get(READ + "/approvals-mine", h.q());
  assert.deepEqual([res.status, res.json.error.reason, res.json.result], [503, "AUDIT_UNAVAILABLE", null]);

  const broken = { list: async () => { throw new Error("down"); }, get: async () => { throw new Error("down"); } };
  const b = await inbox(t, { deps: { approvals: broken } });
  for (const path of ["/approvals-pending", "/approvals-mine", "/approvals/" + randomUUID()]) {
    const r = await b.get(READ + path, b.q());
    assert.deepEqual([r.status, r.json.error.code, r.json.error.reason, r.json.error.retryable], [503, "UNAVAILABLE", "APPROVAL_STORE_UNAVAILABLE", true], path);
  }
  assert.ok(b.audit.rows.some((a) => a.outcome === "READ_FAILED"));

  // A row that would leak a forbidden field name is suppressed, never served.
  const leaky = memoryApprovals();
  const row = await leaky.propose({ id: randomUUID(), capabilityId: CAP, intentDigest: digest("f"), scope: { ...scopeArrays }, requestedBy: "staff-17", ttlSeconds: 600, risk: "R2" });
  leaky.rows.get(row.approval_id).scope.email = ["x"];
  const l = await inbox(t, { deps: { approvals: leaky } });
  const leak = await l.get(READ + "/approvals/" + row.approval_id, l.q(), { scope: { ...scopeArrays, email: ["x"] } });
  assert.deepEqual([leak.status, leak.json.error.reason], [502, "SENSITIVE_FIELD_SUPPRESSED"]);
  assert.ok(l.audit.rows.some((a) => a.outcome === "READ_SUPPRESSED_SENSITIVE"));
});

test("paging: sealed continuation bound to staff, collection, scope and filters; bounded scans; no duplicates or gaps", async (t) => {
  const h = await inbox(t);
  const seeded = [];
  for (let i = 0; i < 7; i += 1) seeded.push((await h.approvals.propose({ id: randomUUID(), capabilityId: CAP, intentDigest: digest("1"), scope: scopeArrays, requestedBy: "staff-17", ttlSeconds: 600, risk: "R2" })).approval_id);
  const newestFirst = [...seeded].reverse();
  const mine = (extra, claims) => h.get(READ + "/approvals-mine", h.q({ limit: "3", ...extra }), claims);
  const p1 = await mine();
  assert.equal(p1.json.result.data.items.length, 3);
  assert.equal(p1.json.result.has_more, true);
  assert.match(p1.json.result.continuation, /^[A-Za-z0-9_-]{16,2048}$/);
  assert.equal(p1.json.result.continuation.includes(newestFirst[2]), false, "the keyset never leaves sealed");
  const p2 = await mine({ continuation: p1.json.result.continuation });
  assert.equal(p2.status, 200, JSON.stringify(p2.json));
  assert.equal(p2.json.result.first_page_observed_at, p1.json.result.observed_at);
  const p3 = await mine({ continuation: p2.json.result.continuation });
  assert.equal(p3.json.result.continuation, null);
  assert.equal(p3.json.result.has_more, false);
  assert.deepEqual([...p1.json.result.data.items, ...p2.json.result.data.items, ...p3.json.result.data.items].map((i) => i.approval_id), newestFirst);

  const token = p1.json.result.continuation;
  const mismatch = [
    await mine({ continuation: token, limit: "4" }),
    await mine({ continuation: token }, { sub: "staff-99" }),
    await mine({ continuation: token, zone: SCOPE.zone }),
    await h.get(READ + "/approvals-pending", h.q({ limit: "3", continuation: token })),
  ];
  for (const r of mismatch) assert.equal(r.json.error.reason, "CONTINUATION_BINDING_MISMATCH");
  const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
  assert.equal((await mine({ continuation: tampered })).json.error.reason, "CONTINUATION_INVALID");

  // Waiting for me: approvals the caller may not decide are skipped; a page
  // stops after a bounded scan and continues from where it stopped.
  for (let i = 0; i < 2; i += 1) await h.approvals.propose({ id: randomUUID(), capabilityId: CAP, intentDigest: digest("2"), scope: scopeArrays, requestedBy: "staff-99", ttlSeconds: 600, risk: "R2" });
  for (let i = 0; i < 1050; i += 1) await h.approvals.propose({ id: randomUUID(), capabilityId: CAP, intentDigest: digest("3"), scope: { ...scopeArrays, zone: ["ikeja"] }, requestedBy: "staff-99", ttlSeconds: 600, risk: "R2" });
  const w1 = await h.get(READ + "/approvals-pending", h.q({ limit: "5" }));
  assert.equal(w1.status, 200, JSON.stringify(w1.json));
  assert.deepEqual(w1.json.result.data.items, [], "the first 1000 newest rows are out of the caller's scope");
  assert.equal(w1.json.result.has_more, true);
  const w2 = await h.get(READ + "/approvals-pending", h.q({ limit: "5", continuation: w1.json.result.continuation }));
  assert.equal(w2.json.result.data.items.length, 2);
  assert.equal(w2.json.result.continuation, null);
  // A full page that proves one more visible item offers a continuation at the last item.
  const w0 = await h.get(READ + "/approvals-pending", h.q({ limit: "1" }));
  assert.deepEqual([w0.json.result.data.items.length, w0.json.result.has_more], [0, true]);
  const w3 = await h.get(READ + "/approvals-pending", h.q({ limit: "1", continuation: w0.json.result.continuation }));
  assert.equal(w3.json.result.data.items.length, 1);
  assert.equal(w3.json.result.has_more, true);
  const w4 = await h.get(READ + "/approvals-pending", h.q({ limit: "1", continuation: w3.json.result.continuation }));
  assert.equal(w4.status, 200, JSON.stringify(w4.json));
  assert.equal(w4.json.result.data.items.length, 1);
  assert.notEqual(w4.json.result.data.items[0].approval_id, w3.json.result.data.items[0].approval_id);
});

test("without a continuation key a further page is reported as partial, never silently dropped", async (t) => {
  const h = await inbox(t, { config: { cursorKey: null } });
  for (let i = 0; i < 3; i += 1) await h.approvals.propose({ id: randomUUID(), capabilityId: CAP, intentDigest: digest("1"), scope: scopeArrays, requestedBy: "staff-17", ttlSeconds: 600, risk: "R2" });
  const res = await h.get(READ + "/approvals-mine", h.q({ limit: "2" }));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual([res.json.result.data.items.length, res.json.result.has_more, res.json.result.continuation, res.json.coverage, res.json.result.quality], [2, true, null, "PARTIAL", "PARTIAL_COVERAGE"]);
  assert.equal((await h.get(READ + "/approvals-mine", h.q({ continuation: "A".repeat(40) }))).json.error.reason, "CONTINUATION_INVALID");
});

test("capability discovery lists the governance module with its collections and local commands", async (t) => {
  const h = await inbox(t);
  const client = F.hqClient(h.app.target, h.m.hqKey);
  const caps = (await client.getCapabilities()).json.result;
  assert.equal(caps.capabilities.find((c) => c.id === READ).state, "READ_ONLY");
  const mod = caps.modules.find((x) => x.module === "governance");
  assert.equal(mod.read_capability_id, READ);
  assert.deepEqual(mod.collections.map((c) => [c.collection_id, c.detail]), [["approvals-pending", false], ["approvals-mine", false], ["approvals", true]]);
  assert.deepEqual(mod.commands, ["cfmeet.governance.approval.propose", "cfmeet.governance.approval.decide", "cfmeet.governance.approval.revoke"]);
  // Other module reads still go to the Bridge path (unenrolled here).
  const other = await h.get("cfmeet.accounts.read/accounts.users.list", h.q({ zone: SCOPE.zone, tenant: SCOPE.tenant }));
  assert.equal(other.json.error.code, "UNAVAILABLE");
});
