import { test, expect, signIn, defaultMocks, gotoWithEntitlements, ok, SUPER_USER, noHorizontalScroll, type MockApi } from "./fixtures";
import { cfmeetCapabilities, cfmeetProduct, envelope, operationView, path, productsReply, referenceIntentDigest, type CapabilityOptions } from "./product-fixtures";

// Generalized Verification page: HealthNet stays the default (unchanged)
// page; a CF Meet tab lists cases, shows evidence hashes and history, and
// runs Claim directly and R4 decisions through propose -> approve -> run.

interface Sent {
  command_id: string;
  capability_id: string;
  target: { type: string; id: string; expected_version: number | null };
  params: Record<string, unknown> & { intent_digest?: string; body?: unknown };
  reason_code: string;
  case_reference: string | null;
  scope: Record<string, string[]>;
}

const APP_CASE = "cfmeet:APP_REVIEW:5b0f6c1e-2a8d-4c3e-9f7a-1d2e3f4a5b6c";
const GO_LIVE_CASE = "cfmeet:PARTNER_GO_LIVE:6c1a7d2f-3b9e-4d4f-8a8b-2e3f4a5b6c7d";
const CANCELLED_CASE = "cfmeet:PARTNER_GO_LIVE:7d2b8e3a-4c0f-4e5a-9b9c-3f4a5b6c7d8e";
const APPROVAL_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const READ = "/api/products/cfmeet/resources/cfmeet.verification.read";
const CHECKS = "/api/products/cfmeet/resources/cfmeet.governance.read";

function verificationCase(over: Record<string, unknown> = {}) {
  return {
    case_id: APP_CASE,
    product: "cfmeet",
    kind: "APP_REVIEW",
    subject_ref: "0f1e2d3c-4b5a-4968-8776-655443322110",
    state: "CLAIMED",
    version: 3,
    assignee_ref: "hq:u-super",
    submitted_at: "2026-11-20T10:00:00.000Z",
    updated_at: "2026-11-21T08:00:00.000Z",
    evidence: [{ kind: "APP_MANIFEST", ref: "0f1e2d3c-4b5a-4968-8776-655443322110:manifest", sha256: "b".repeat(64) }],
    approvals_required: 2,
    partner_tenant_id: "1e2d3c4b-5a69-4877-8665-544332211009",
    ...over,
  };
}
const appDetail = (over: Record<string, unknown> = {}) => ({ ...verificationCase(over), details: { app_version: 4, published_version: 3 } });
const goLive = (over: Record<string, unknown> = {}) => verificationCase({ case_id: GO_LIVE_CASE, kind: "PARTNER_GO_LIVE", state: "OPEN", version: 1, assignee_ref: null, evidence: [{ kind: "USE_CASE_SUMMARY", ref: "2e3d4c5b-6a79-4887-9665-544332211008:summary", sha256: "c".repeat(64) }], ...over });
const goLiveDetail = (over: Record<string, unknown> = {}) => ({ ...goLive(over), details: { requested_capabilities: ["MEETINGS_API", "RECORDINGS_API"], approved_capabilities: [] } });

const listOf = (items: unknown[], collection: string, extra: Record<string, unknown> = {}) =>
  envelope({ module: "verification", capability_id: "cfmeet.verification.read", collection_id: collection, kind: "LIST", data: { items, ...extra }, continuation: null });
const detailOf = (data: unknown) => envelope({ module: "verification", capability_id: "cfmeet.verification.read", collection_id: "verification.cases.read", kind: "DETAIL", data, continuation: null });

function healthnetMocks(api: MockApi) {
  api.on("GET", /^\/api\/verification\/all$/, ok({
    stats: { totalRequests: 7, approvalRate: "71%", pendingRequests: 2 },
    requests: [{ id: "vr-1", user: "Dr Ada Obi", role: "Doctors", verificationType: "License", licenseId: "MDCN-123", status: "Pending", submittedDate: "2026-11-20T10:00:00Z", riskIndicator: "Low" }],
    pagination: { currentPage: 1, totalPages: 1, totalItems: 1, itemsPerPage: 10 },
  }));
}

interface Setup {
  caps?: CapabilityOptions;
  detail?: Record<string, unknown>;
}

function setup(api: MockApi, o: Setup = {}) {
  defaultMocks(api, SUPER_USER);
  healthnetMocks(api);
  api.on("GET", "/api/products", productsReply([cfmeetProduct]));
  api.on("GET", "/api/products/cfmeet/capabilities", envelope(cfmeetCapabilities(o.caps)));
  api.on("GET", path(`${READ}/verification.cases.list`), listOf([verificationCase(), goLive()], "verification.cases.list"));
  api.on("GET", path(`${READ}/verification.cases.read/${APP_CASE}`), detailOf(o.detail ?? appDetail()));
  api.on("GET", path(`${READ}/verification.cases.read/${GO_LIVE_CASE}`), detailOf(goLiveDetail()));
  api.on("GET", path(`${READ}/verification.cases.read/${CANCELLED_CASE}`), detailOf(goLiveDetail({ case_id: CANCELLED_CASE, state: "CANCELLED", version: 2 })));
  api.on("GET", path(`${READ}/verification.case-history.list`), (_req, url) => listOf([
    { sequence: 1, from_state: null, to_state: "OPEN", actor_kind: "PARTNER", actor_ref: null, reason_code: null, occurred_at: "2026-11-20T10:00:00.000Z" },
    { sequence: 2, from_state: "OPEN", to_state: "CLAIMED", actor_kind: "STAFF", actor_ref: "hq:u-super", reason_code: "REVIEW_STARTED", occurred_at: "2026-11-21T08:00:00.000Z" },
  ], "verification.case-history.list", { case_id: url.searchParams.get("parent") }));
}

test("HealthNet stays the default verification page; CF Meet is an extra tab", async ({ page, api }) => {
  await signIn(page, SUPER_USER);
  setup(api);
  await gotoWithEntitlements(page, "/dashboard/verification");

  const tabs = page.getByRole("tablist", { name: "Verification product" });
  await expect(tabs.getByRole("tab", { name: "HealthNet" })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab", { name: "CF Meet" })).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("heading", { name: "Verification Statistics" })).toBeVisible();
  await expect(page.getByText("Dr Ada Obi").first()).toBeVisible();
  expect(api.callsTo("GET", "/api/verification/all").length).toBeGreaterThan(0);
  expect(api.callsTo("GET", /\/api\/products\/cfmeet\/resources\//)).toHaveLength(0);
  await noHorizontalScroll(page);
});

test("without a product verification capability the HealthNet page has no tab bar", async ({ page, api }) => {
  await signIn(page, SUPER_USER);
  setup(api);
  api.on("GET", "/api/products", productsReply([]));
  await gotoWithEntitlements(page, "/dashboard/verification");
  await expect(page.getByRole("heading", { name: "Verification Statistics" })).toBeVisible();
  await expect.poll(() => api.callsTo("GET", "/api/products").length).toBeGreaterThan(0);
  await expect(page.getByRole("tablist", { name: "Verification product" })).toHaveCount(0);
});

test("CF Meet tab: paged case list, client-side filters, detail with evidence and history", async ({ page, api }) => {
  await signIn(page, SUPER_USER);
  setup(api);
  await gotoWithEntitlements(page, "/dashboard/verification");
  await page.getByRole("tab", { name: "CF Meet" }).click();

  const cases = page.getByRole("region", { name: "Verification cases" });
  await expect(cases.getByRole("button", { name: APP_CASE })).toBeVisible();
  await expect(cases.getByRole("button", { name: GO_LIVE_CASE })).toBeVisible();
  await expect(cases.getByText("Fresh", { exact: true })).toBeVisible();
  const listCall = api.callsTo("GET", path(`${READ}/verification.cases.list`))[0];
  expect(listCall.query).toEqual({ market: "NG", organization: "cfmeet", zone: "production", tenant: "tenant-alpha", purpose: "verification-review", limit: "50" });
  await expect(page).toHaveURL(/product=cfmeet/);

  await cases.getByLabel("Filter by kind").selectOption("PARTNER_GO_LIVE");
  await expect(cases.getByRole("button", { name: APP_CASE })).toHaveCount(0);
  await expect(cases.getByRole("button", { name: GO_LIVE_CASE })).toBeVisible();
  expect(api.callsTo("GET", path(`${READ}/verification.cases.list`))).toHaveLength(1);
  await cases.getByLabel("Filter by kind").selectOption("");

  await cases.getByRole("button", { name: APP_CASE }).click();
  const detail = page.getByRole("region", { name: "Verification case" });
  await expect(detail.getByRole("heading", { name: "App review" })).toBeVisible();
  await expect(detail).toContainText("App version under review");
  const evidence = page.getByRole("region", { name: "Evidence" });
  await expect(evidence).toContainText("APP_MANIFEST");
  await expect(evidence).toContainText("sha256 " + "b".repeat(64));
  const history = page.getByRole("region", { name: "Case history" });
  await expect(history).toContainText("Created → Open");
  await expect(history).toContainText("Open → Claimed");
  await expect(history).toContainText("REVIEW_STARTED");
  await expect(history).toContainText("You");
  expect(api.callsTo("GET", path(`${READ}/verification.case-history.list`))[0].query).toMatchObject({ parent: APP_CASE, purpose: "verification-review", limit: "50" });
  await expect(page).toHaveURL(new RegExp(`case=${encodeURIComponent(APP_CASE)}`));
  await noHorizontalScroll(page);
});

test("blocked verification capability shows the blocked state and reads nothing", async ({ page, api }) => {
  await signIn(page, SUPER_USER);
  setup(api, { caps: { verification: "BLOCKED_DEPENDENCY", verificationBlockers: [{ code: "SOURCE_BLOCKED_DEPENDENCY", detail: "Phase A3: new developer-platform operator endpoint required" }], commands: "DISABLED" } });
  await gotoWithEntitlements(page, "/dashboard/verification?product=cfmeet");
  const blocked = page.getByRole("alert", { name: "CF Meet verification blocked" });
  await expect(blocked).toContainText("cfmeet.verification.read");
  await expect(blocked).toContainText("SOURCE_BLOCKED_DEPENDENCY");
  await expect(blocked).toContainText("State: BLOCKED_DEPENDENCY");
  expect(api.callsTo("GET", /\/api\/products\/cfmeet\/resources\//)).toHaveLength(0);
});

test("R4 decision: request approval, second person approves, requester runs the same command once", async ({ page, api }) => {
  await signIn(page, SUPER_USER);
  setup(api);
  let approvalStatus = "PROPOSED";
  const posts: Record<string, unknown>[] = [];
  api.on("POST", "/api/products/cfmeet/operations", (req) => {
    const body = req.postDataJSON() as Record<string, unknown> & { command_id: string; capability_id: string };
    posts.push(body);
    if (body.capability_id === "cfmeet.governance.approval.propose") {
      return envelope(operationView(body.command_id, body.capability_id, "SUCCEEDED", {
        source_status: "PROPOSED",
        evidence: { approval_id: APPROVAL_ID, status: "PROPOSED", expires_at: "2099-11-21T20:00:00.000Z" },
        approval: { approval_id: APPROVAL_ID, status: "PROPOSED", expires_at: "2099-11-21T20:00:00.000Z" },
      }));
    }
    return envelope(operationView(body.command_id, body.capability_id, "SUCCEEDED", { source_status: "APPROVED", source_version: 4, approval_ref: APPROVAL_ID, reason_code: "SOURCE_CONFIRMED" }));
  });
  api.on("GET", path(`${CHECKS}/approvals/${APPROVAL_ID}`), () => {
    const propose = posts[0] as { params: { intent_digest: string }; target: { type: string; id: string }; scope: unknown };
    return envelope({
      kind: "DETAIL",
      continuation: null,
      data: {
        approval_id: APPROVAL_ID, capability: "cfmeet.verification.app-review.approve", status: approvalStatus, risk: "R4", expired: false,
        requester_ref: "u-super", approver_ref: approvalStatus === "APPROVED" ? "u-rita" : null,
        intent_summary: { capability: "cfmeet.verification.app-review.approve", target: propose.target, expected_version: 3, reason_code: "REVIEW_PASSED", case_reference: APP_CASE, scope: propose.scope },
        intent_digest: propose.params.intent_digest, created_at: "2026-11-21T09:00:00.000Z", decided_at: approvalStatus === "APPROVED" ? "2026-11-21T09:10:00.000Z" : null, expires_at: "2099-11-21T20:00:00.000Z",
      },
    });
  });
  api.on("GET", /^\/api\/products\/cfmeet\/operations\/[0-9a-f-]+$/, (_req, url) => {
    const id = url.pathname.split("/").pop() as string;
    return envelope({ ...operationView(id, "cfmeet.verification.app-review.approve", "SUCCEEDED", { source_status: "APPROVED", source_version: 4, approval_ref: APPROVAL_ID }), readback: null });
  });
  api.on("GET", /^\/api\/products\/cfmeet\/operations\/[0-9a-f-]+\/audit$/, (_req, url) =>
    envelope({ operation_id: url.pathname.split("/")[5], records: [{ occurred_at: "2026-11-21T09:20:00.000Z", correlation_id: "corr-run", endpoint: "operationSubmit", method: "POST", service_id: "pic", staff_ref: "u-super", action: "operation.submit", outcome: "OPERATION_SUCCEEDED", reason_code: "SOURCE_CONFIRMED" }] }));

  await gotoWithEntitlements(page, `/dashboard/verification?product=cfmeet&case=${encodeURIComponent(APP_CASE)}`);
  const actions = page.getByRole("region", { name: "Actions" });
  await actions.getByRole("button", { name: /Approve app/ }).click();
  const form = actions.getByRole("form", { name: "Approve app" });
  await form.getByLabel("Note").fill("Manifest checked against policy");
  await form.getByRole("button", { name: "Request approval" }).click();

  // Proposed: waiting for someone else; nothing to run, nothing to decide here.
  const request = actions.getByRole("listitem", { name: "Request: Approve app" });
  await expect(request).toContainText("Waiting for a second staff member to decide.");
  await expect(actions.getByRole("button", { name: "Run approved action" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Submit decision|Approve$/ })).toHaveCount(0);
  await expect(actions.getByRole("button", { name: /Approve app/ })).toBeDisabled();

  const propose = posts[0] as unknown as Sent;
  expect(propose).toMatchObject({
    capability_id: "cfmeet.governance.approval.propose",
    target: { type: "cfmeet.verification_case", id: APP_CASE, expected_version: 3 },
    params: { capability_id: "cfmeet.verification.app-review.approve", expected_version: 3 },
    reason_code: "REVIEW_PASSED",
    case_reference: APP_CASE,
    scope: { market: ["NG"], organization: ["cfmeet"], zone: ["production"], tenant: ["tenant-alpha"] },
  });
  expect(propose.params.intent_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(Object.keys(propose.params).sort()).toEqual(["capability_id", "expected_version", "intent_digest"]);

  // A second staff member approves it elsewhere; the requester checks again.
  approvalStatus = "APPROVED";
  await request.getByRole("button", { name: "Check approval status" }).click();
  await expect(request).toContainText("Approved by u-rita.");
  await request.getByRole("button", { name: "Run approved action" }).click();
  await expect(request).toContainText("Done: the source confirmed the change.");
  await expect(request.getByRole("button", { name: "Run approved action" })).toHaveCount(0);

  expect(posts).toHaveLength(2);
  const run = posts[1] as unknown as Sent;
  expect(run).toMatchObject({
    capability_id: "cfmeet.verification.app-review.approve",
    target: { type: "cfmeet.verification_case", id: APP_CASE, expected_version: 3 },
    reason_code: "REVIEW_PASSED",
    case_reference: APP_CASE,
    scope: propose.scope,
  });
  expect(run.params).toEqual({
    body: { operation_id: run.command_id, expected_version: 3, reason_code: "REVIEW_PASSED", note: "Manifest checked against policy" },
    approval_ref: APPROVAL_ID,
  });
  // The approval binds exactly the command that ran (server's digest rule, staff = requester).
  expect(propose.params.intent_digest).toBe(referenceIntentDigest(run as Sent & { params: { body: unknown } }, "u-super"));

  await request.getByRole("button", { name: "View operation" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("Succeeded").first()).toBeVisible();
  await expect(drawer.getByText(APPROVAL_ID)).toBeVisible();
});

test("claim: a version conflict asks for a refresh; a cancelled case is withdrawn", async ({ page, api }) => {
  await signIn(page, SUPER_USER);
  setup(api);
  api.on("POST", "/api/products/cfmeet/operations", (req) => {
    const body = req.postDataJSON() as { command_id: string; capability_id: string };
    return envelope(operationView(body.command_id, body.capability_id, "FAILED", { reason_code: "SOURCE_VERSION_CONFLICT", source_status: null }));
  });
  await gotoWithEntitlements(page, `/dashboard/verification?product=cfmeet&case=${encodeURIComponent(GO_LIVE_CASE)}`);

  const actions = page.getByRole("region", { name: "Actions" });
  await expect(page.getByRole("region", { name: "Verification case" })).toContainText("MEETINGS_API, RECORDINGS_API");
  await actions.getByRole("button", { name: "Claim case" }).click();
  const form = actions.getByRole("form", { name: "Claim case" });
  await expect(form).toContainText("This is sent once for case version 1.");
  await form.getByRole("button", { name: "Claim case" }).click();
  await expect(actions.getByRole("alert")).toContainText("The case changed since you loaded it — refresh before acting again.");
  const claim = api.callsTo("POST", "/api/products/cfmeet/operations")[0].body as Sent;
  expect(claim).toMatchObject({ capability_id: "cfmeet.verification.case.claim", target: { id: GO_LIVE_CASE, expected_version: 1 } });
  expect(claim.params).toEqual({ body: { operation_id: claim.command_id, expected_version: 1, reason_code: "REVIEW_STARTED" } });
  const before = api.callsTo("GET", path(`${READ}/verification.cases.read/${GO_LIVE_CASE}`)).length;
  await actions.getByRole("button", { name: "Refresh case" }).click();
  await expect.poll(() => api.callsTo("GET", path(`${READ}/verification.cases.read/${GO_LIVE_CASE}`)).length).toBeGreaterThan(before);
  expect(api.callsTo("POST", "/api/products/cfmeet/operations")).toHaveLength(1);

  await page.goto(`/dashboard/verification?product=cfmeet&case=${encodeURIComponent(CANCELLED_CASE)}`);
  const detail = page.getByRole("region", { name: "Verification case" });
  await expect(detail.getByText("Withdrawn", { exact: true })).toBeVisible();
  await expect(detail.getByText("Withdrawn by the partner.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Actions" }).getByRole("button")).toHaveCount(0);
});
