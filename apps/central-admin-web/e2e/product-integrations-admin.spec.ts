import { test, expect, signIn, defaultMocks, gotoWithEntitlements, SUPER_USER, ALICE, type MockReply, type MockApi } from "./fixtures";

// Product integration admin (IT > Product Integrations). The HQ gateway
// forwards /api/admin/product-integrations/* to PIC, which answers
// { success, data, correlation_id }. Every admin route needs a recent MFA:
// the gateway refuses with { success:false, code:"MFA_STEP_UP_REQUIRED" }.

const BASE = "/api/admin/product-integrations";
const ID = "3f6c2a1e-8b4d-4c2a-9f1e-2d3c4b5a6f70";
const CONTRACT = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const DATASET_ROW = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const NOW = "2026-11-20T09:00:00.000Z";

const pic = (data: unknown, status = 200): MockReply => ({ status, body: { success: true, data, correlation_id: "pic-ok" } });
const picError = (status: number, code: string, reason: string, detail?: string[]): MockReply => ({
  status,
  body: { success: false, error: { code, reason, ...(detail ? { detail } : {}) }, correlation_id: "pic-corr-1" },
});
const mfaRequired: MockReply = {
  status: 403,
  body: { success: false, code: "MFA_STEP_UP_REQUIRED", retryable: false, message: "Confirm with your authenticator app to continue", errors: [], correlationId: "hq-corr-1" },
};

function registration(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    product_id: "cfmeet",
    display_name: "CF Meet",
    service_instance_id: "cfmeet-admin-staging-1",
    environment: "staging",
    endpoint_ref: "cfmeet-staging",
    workload_identity: "cf://staging/cfmeet-admin",
    identity_fingerprint_ref: null,
    approved_signer_kid: "cfmeet-staging-2026-11",
    supported_protocol_major: 1,
    allowed_scope: { market: ["NG-LAG"], organization: ["cfmeet-staging"] },
    lifecycle_status: "CONTRACT_VALIDATED",
    revision: 4,
    current_contract_id: null,
    manifest_digest: "sha256:" + "a".repeat(64),
    manifest_revision: 3,
    manifest_expires_at: "2026-11-27T09:00:00.000Z",
    identity_verified_at: NOW,
    operations_enabled: false,
    requested_by: "u-requester",
    health_status: "REACHABLE",
    health_checked_at: NOW,
    sync_status: "NOT_STARTED",
    drift_status: "NONE",
    drift_detected_at: null,
    activated_at: null,
    activated_by: null,
    suspended_at: null,
    suspended_by: null,
    suspension_reason: null,
    revoked_at: null,
    revoked_by: null,
    revocation_reason: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function detail(reg = registration()) {
  return {
    registration: reg,
    contracts: [
      { id: CONTRACT, revision: 1, status: "VALIDATED", manifest_revision: 3, manifest_digest: "sha256:" + "a".repeat(64), catalog_digest: "sha256:" + "b".repeat(64), build_sha: "abcdef1", compatibility: { decision: "INITIAL", changes: [] }, validated_by: "u-validator", validated_at: NOW, certified_by: null, certified_at: null, certification_evidence_ref: null, activated_at: null },
    ],
    datasets: [
      { id: DATASET_ROW, dataset_id: "cfmeet.usage_daily", version: "1.0.0", privacy_class: "INTERNAL", approval_status: "PROPOSED", approved_by: null, approved_at: null, authorized_departments: ["cfmeet-operations"], scope_dimensions: ["market", "organization"] },
    ],
    subscriptions: [],
    history: [
      { id: 1, decision: "TRANSITION", from_status: null, to_status: "DRAFT", actor_id: "u-requester", reason_code: null, evidence_ref: null, expected_revision: null, resulting_revision: 1, contract_id: null, created_at: NOW },
      { id: 4, decision: "CONTRACT_VALIDATED", from_status: null, to_status: null, actor_id: "u-validator", reason_code: null, evidence_ref: null, expected_revision: null, resulting_revision: null, contract_id: CONTRACT, created_at: NOW },
    ],
  };
}

function monitoring(reg = registration()) {
  return {
    product_id: reg.product_id,
    environment: reg.environment,
    registry: { status: reg.lifecycle_status, revision: reg.revision, revoked: false, suspended: false, revocation_reason: null, suspension_reason: null },
    identity: { verified_at: NOW, manifest_revision: 3, manifest_expires_at: "2026-11-27T09:00:00.000Z", manifest_expired: false, manifest_expires_in_seconds: 604800 },
    connection: { health_status: "REACHABLE", checked_at: NOW },
    contract: null,
    drift: { status: "NONE", detected_at: null },
    datasets: [{ dataset_id: "cfmeet.usage_daily", version: "1.0.0", approval_status: "PROPOSED", privacy_class: "INTERNAL" }],
    subscriptions: [],
    cursors: [],
    sync: { status: "NOT_STARTED", failed_acks: 0, lease_failures: 0, failed_runs: 0, last_successful_run: null },
    quarantine: { open: 0, total: 0 },
    alerts_24h: [],
  };
}

/** Admin reads behind a server-side MFA window that opens after POST /api/auth/mfa/step-up. */
function adminMocks(api: MockApi, reg = registration(), { mfaFresh = false } = {}) {
  const state = { mfa: mfaFresh, reg };
  const guarded = (reply: () => MockReply) => () => (state.mfa ? reply() : mfaRequired);
  api
    .on("POST", "/api/auth/mfa/step-up", () => {
      state.mfa = true;
      return { status: 200, body: { success: true, data: { verifiedAt: NOW } } };
    })
    .on("GET", BASE, guarded(() => pic([state.reg])))
    .on("GET", `${BASE}/${ID}`, guarded(() => pic(detail(state.reg))))
    .on("GET", `${BASE}/${ID}/monitoring`, guarded(() => pic(monitoring(state.reg))));
  return state;
}

async function confirmMfa(page: import("@playwright/test").Page) {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Authentication code").fill("123456");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function openSection(page: import("@playwright/test").Page) {
  await gotoWithEntitlements(page, "/dashboard/it?section=product-integrations");
}

test.describe("product integration admin", () => {
  test("registry lists registrations after an MFA step-up, with lifecycle, contract and health", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    adminMocks(api);
    await openSection(page);

    await confirmMfa(page);
    expect(api.callsTo("POST", "/api/auth/mfa/step-up")[0].body).toEqual({ code: "123456" });

    const table = page.getByRole("table", { name: "Product integration registry" });
    const row = table.getByRole("row").filter({ hasText: "CF Meet" });
    await expect(row).toBeVisible();
    await expect(row.getByText("CONTRACT_VALIDATED")).toBeVisible();
    await expect(row.getByText("staging", { exact: true })).toBeVisible();
    await expect(row.getByText("None in force")).toBeVisible();
    await expect(row.getByText("manifest rev 3")).toBeVisible();
    await expect(row.getByText("REACHABLE")).toBeVisible();
    await expect(page.getByRole("button", { name: "Register product" })).toBeEnabled();
    // The list read was refused once, then repeated after the step-up.
    expect(api.callsTo("GET", BASE).length).toBeGreaterThanOrEqual(2);

    // Detail with monitoring.
    await row.getByRole("button", { name: "Open CF Meet" }).click();
    await expect(page.getByRole("heading", { name: "CF Meet", level: 2 })).toBeVisible();
    const monitoringCard = page.getByRole("region", { name: "Monitoring" });
    await expect(monitoringCard.getByText("revision 3, expires", { exact: false })).toBeVisible();
    await expect(page.getByRole("region", { name: "Datasets" }).getByText("cfmeet.usage_daily")).toBeVisible();
  });

  test("a lifecycle transition steps up MFA, names the exact transition and then succeeds", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    const state = adminMocks(api, registration(), { mfaFresh: true });
    let attempts = 0;
    api.on("POST", `${BASE}/${ID}/review-policy`, () => {
      attempts += 1;
      if (attempts === 1) return mfaRequired; // the gateway's 5-minute window has passed
      state.reg = registration({ lifecycle_status: "POLICY_REVIEWED", revision: 5 });
      return pic(state.reg);
    });
    await openSection(page);
    await page.getByRole("button", { name: "Open CF Meet" }).click();

    await page.getByRole("button", { name: "Review policy" }).click();
    const confirm = page.getByRole("dialog", { name: "Confirm review-policy" });
    await expect(confirm.getByText(`POST ${BASE}/${ID}/review-policy · CONTRACT_VALIDATED → POLICY_REVIEWED · expected revision 4`)).toBeVisible();
    await expect(confirm.getByText("Two-person rule: must be someone other than the requester.")).toBeVisible();
    await confirm.getByLabel("Evidence reference (optional)").fill("docs/product-admin/evidence/cfmeet-policy-review.json");
    await confirm.getByRole("button", { name: "Run review-policy" }).click();

    await confirmMfa(page);
    await expect(page.getByRole("status").filter({ hasText: "review-policy done: CF Meet is now POLICY_REVIEWED (revision 5)." })).toBeVisible();
    const posts = api.callsTo("POST", `${BASE}/${ID}/review-policy`);
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toEqual({ expected_revision: 4, evidence_ref: "docs/product-admin/evidence/cfmeet-policy-review.json" });
    expect(api.callsTo("POST", "/api/auth/mfa/step-up")).toHaveLength(1);
    await expect(page.getByText("cfmeet · staging · cfmeet-admin-staging-1 · revision 5")).toBeVisible();
  });

  test("refusals show the server's reason; a missing permission disables the control", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    adminMocks(api, registration(), { mfaFresh: true });
    api.on("POST", `${BASE}/${ID}/datasets/cfmeet.usage_daily/approve`, picError(409, "CONFLICT", "DATASET_NOT_CERTIFIED_BY_PRODUCT"));
    api.on("POST", `${BASE}/${ID}/reject`, picError(403, "FORBIDDEN", "MISSING_PLATFORM_GRANT"));
    await openSection(page);
    await page.getByRole("button", { name: "Open CF Meet" }).click();

    // A rule refusal: shown with its reason, nothing faked.
    await page.getByRole("button", { name: "Approve cfmeet.usage_daily" }).click();
    const approve = page.getByRole("dialog", { name: "Confirm dataset approval" });
    await approve.getByRole("button", { name: "Approve dataset" }).click();
    const alert = approve.getByRole("alert");
    await expect(alert.getByText("Refused: The product has not certified this dataset as ready.")).toBeVisible();
    await expect(alert.getByText("Reason: CONFLICT / DATASET_NOT_CERTIFIED_BY_PRODUCT · Ref: pic-corr-1")).toBeVisible();
    expect(api.callsTo("POST", `${BASE}/${ID}/datasets/cfmeet.usage_daily/approve`)[0].body).toEqual({ version: "1.0.0", decision: "APPROVE" });
    await approve.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("region", { name: "Datasets" }).getByText("PROPOSED", { exact: true })).toBeVisible();

    // A permission refusal: reason shown, then the control is disabled with an explanation.
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    const reject = page.getByRole("dialog", { name: "Confirm reject" });
    await reject.getByLabel("Reason code").fill("policy_violation");
    await expect(reject.getByLabel("Reason code")).toHaveValue("POLICY_VIOLATION");
    await reject.getByRole("button", { name: "Run reject" }).click();
    await expect(reject.getByText("Refused: You do not hold the platform permission for this action.")).toBeVisible();
    expect(api.callsTo("POST", `${BASE}/${ID}/reject`)[0].body).toEqual({ expected_revision: 4, reason_code: "POLICY_VIOLATION" });
    await reject.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Reject", exact: true })).toBeDisabled();
    await expect(page.getByText("Not permitted (MISSING_PLATFORM_GRANT): you do not hold integration.review.").first()).toBeVisible();
  });

  test("without the platform permission there is no registry and no controls", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    api.on("GET", BASE, picError(403, "FORBIDDEN", "MISSING_PLATFORM_GRANT"));
    await openSection(page);
    await expect(page.getByRole("alert").filter({ hasText: "Product integrations blocked" })).toBeVisible();
    await expect(page.getByText("Reason: FORBIDDEN / MISSING_PLATFORM_GRANT", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Register product" })).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Product integration registry" })).toHaveCount(0);
  });

  test("the requester cannot run their own review step or decide datasets", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    adminMocks(api, registration({ requested_by: SUPER_USER.id }), { mfaFresh: true });
    await openSection(page);
    await page.getByRole("button", { name: "Open CF Meet" }).click();
    await expect(page.getByRole("button", { name: "Review policy" })).toBeDisabled();
    await expect(page.getByText("Two-person rule: you requested this registration, so someone else must do this.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve cfmeet.usage_daily" })).toBeDisabled();
    // Operations can only be enabled for an ENABLED product.
    await expect(page.getByRole("button", { name: "Enable operations" })).toBeDisabled();
    expect(api.callsTo("POST", /\/api\/admin\/product-integrations\//)).toHaveLength(0);
  });

  test("employees without the IT section never reach the admin", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    await openSection(page);
    await expect(page.getByText("You do not have access to this section")).toBeVisible();
    expect(api.callsTo("GET", BASE)).toHaveLength(0);
  });
});
