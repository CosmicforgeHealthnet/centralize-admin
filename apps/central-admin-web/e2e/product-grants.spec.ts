import { test, expect, signIn, defaultMocks, gotoWithEntitlements, noHorizontalScroll, SUPER_USER, type MockReply, type MockApi } from "./fixtures";

// Product grants manager (IT > Product Grants). Reads go to
// GET /api/products/{p}/grants[/{id}] (gateway: recent MFA; PIC:
// integration.grants.manage); writes to /api/admin/product-integration-grants.
// PIC answers { success, data, correlation_id } or { success:false, error }.

const ADMIN = "/api/admin/product-integrations";
const GRANTS_ADMIN = "/api/admin/product-integration-grants";
const REG_ID = "3f6c2a1e-8b4d-4c2a-9f1e-2d3c4b5a6f70";
const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
const G3 = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-11-20T09:00:00.000Z";
const CURSOR = "WyIyMDI2LTExLTIwVDA5OjAwOjAwLjAwMDAwMFoiLCIyMjIyIl0";

const pic = (data: unknown, status = 200): MockReply => ({ status, body: { success: true, data, correlation_id: "pic-ok" } });
const picError = (status: number, code: string, reason: string): MockReply => ({ status, body: { success: false, error: { code, reason }, correlation_id: "pic-corr-2" } });
const mfaRequired: MockReply = {
  status: 403,
  body: { success: false, code: "MFA_STEP_UP_REQUIRED", retryable: false, message: "Confirm with your authenticator app to continue", errors: [], correlationId: "hq-corr-2" },
};

function grant(id: string, overrides: Record<string, unknown> = {}) {
  return {
    grant_id: id,
    grant_kind: "PRODUCT",
    product_id: "cfmeet",
    staff_id: "u-viewer",
    role: "cfmeet.viewer",
    effect: "ALLOW",
    actions: ["product.view", "metric.read"],
    datasets: ["cfmeet.usage_daily"],
    scope: { market: ["NG-LAG"], organization: ["cfmeet-staging"] },
    not_before: null,
    expires_at: "2026-11-23T09:00:00.000Z",
    granted_by: "u-granter",
    created_at: NOW,
    revoked_at: null,
    revoked_by: null,
    revocation_reason: null,
    status: "ACTIVE",
    ...overrides,
  };
}

const REGISTRATION = { id: REG_ID, product_id: "cfmeet", display_name: "CF Meet", environment: "staging", lifecycle_status: "ENABLED", revision: 9, allowed_scope: { market: ["NG-LAG"], organization: ["cfmeet-staging"] } };

function mocks(api: MockApi, { mfaFresh = false } = {}) {
  const state = { mfa: mfaFresh, revoked: false };
  const guarded = (reply: () => MockReply) => () => (state.mfa ? reply() : mfaRequired);
  api
    .on("POST", "/api/auth/mfa/step-up", () => {
      state.mfa = true;
      return { status: 200, body: { success: true, data: { verifiedAt: NOW } } };
    })
    .on("GET", ADMIN, guarded(() => pic([REGISTRATION])))
    .on("GET", `${ADMIN}/${REG_ID}`, guarded(() => pic({ registration: REGISTRATION, contracts: [], datasets: [{ id: "d1", dataset_id: "cfmeet.usage_daily", version: "1.0.0", privacy_class: "INTERNAL", approval_status: "APPROVED", approved_by: "u-rev", approved_at: NOW, authorized_departments: ["cfmeet-operations"], scope_dimensions: ["market", "organization"] }], subscriptions: [], history: [] })))
    .on("GET", "/api/products/cfmeet/grants", guarded(() => pic({ product_id: "cfmeet", grants: [grant(G1, { revoked_at: state.revoked ? NOW : null, status: state.revoked ? "REVOKED" : "ACTIVE" }), grant(G2, { staff_id: SUPER_USER.id, role: "cfmeet.support" })], limit: 25, next_cursor: CURSOR })))
    .on("GET", `/api/products/cfmeet/grants/${G1}`, guarded(() => pic(grant(G1, state.revoked ? { revoked_at: NOW, revoked_by: SUPER_USER.id, revocation_reason: "ACCESS_REVIEW", status: "REVOKED" } : {}))))
    .on("GET", `/api/products/cfmeet/grants/${G2}`, guarded(() => pic(grant(G2, { staff_id: SUPER_USER.id, role: "cfmeet.support" }))));
  // Second page (cursor) is registered last so it wins for cursor requests.
  api.on("GET", "/api/products/cfmeet/grants", (req, url) => {
    if (!state.mfa) return mfaRequired;
    if (url.searchParams.get("cursor") === CURSOR) return pic({ product_id: "cfmeet", grants: [grant(G3, { staff_id: "u-finance", role: "cfmeet.finance", effect: "DENY" })], limit: 25, next_cursor: null });
    return pic({ product_id: "cfmeet", grants: [grant(G1, { revoked_at: state.revoked ? NOW : null, status: state.revoked ? "REVOKED" : "ACTIVE" }), grant(G2, { staff_id: SUPER_USER.id, role: "cfmeet.support" })], limit: 25, next_cursor: CURSOR });
  });
  return state;
}

async function confirmMfa(page: import("@playwright/test").Page) {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Authentication code").fill("123456");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function openGrants(page: import("@playwright/test").Page) {
  await gotoWithEntitlements(page, "/dashboard/it?section=product-grants");
  await page.getByLabel("Product", { exact: true }).fill("cfmeet");
  await page.getByRole("button", { name: "Show grants" }).click();
}

test.describe("product grants manager", () => {
  test("lists a product's grants after an MFA step-up and pages with the cursor", async ({ page, api, isMobile }) => {
    test.skip(isMobile, "below-the-fold controls are not clickable in the mobile emulation of the dashboard shell; the mobile layout is covered below");
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    mocks(api);
    await gotoWithEntitlements(page, "/dashboard/it?section=product-grants");
    await confirmMfa(page); // the registry read for the product picker
    await page.getByRole("button", { name: "cfmeet", exact: true }).click(); // registered-product shortcut

    const table = page.getByRole("table", { name: "Product grants" });
    await expect(table.getByRole("row").filter({ hasText: "u-viewer" })).toContainText("cfmeet.viewer");
    await expect(table.getByRole("row").filter({ hasText: "u-viewer" })).toContainText("market: NG-LAG");
    const first = api.callsTo("GET", "/api/products/cfmeet/grants").at(-1)!;
    expect(first.query).toEqual({ limit: "25" });

    await page.getByRole("button", { name: "Load more grants" }).click();
    await expect(table.getByRole("row").filter({ hasText: "u-finance" })).toContainText("DENY");
    expect(api.callsTo("GET", "/api/products/cfmeet/grants").at(-1)!.query).toEqual({ limit: "25", cursor: CURSOR });
    await expect(page.getByRole("button", { name: "Load more grants" })).toHaveCount(0);

    // Detail.
    await page.getByRole("button", { name: `Open grant 11111111 for u-viewer` }).click();
    const detail = page.getByRole("region", { name: "Grant 11111111" });
    await expect(detail.getByText(G1)).toBeVisible();
    await expect(detail.getByText("cfmeet.usage_daily")).toBeVisible();
  });

  test("revoking a grant steps up MFA, then succeeds with the reason code", async ({ page, api, isMobile }) => {
    test.skip(isMobile, "below-the-fold controls are not clickable in the mobile emulation of the dashboard shell; the mobile layout is covered below");
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    const state = mocks(api, { mfaFresh: true });
    let attempts = 0;
    api.on("POST", `${GRANTS_ADMIN}/${G1}/revoke`, () => {
      attempts += 1;
      if (attempts === 1) return mfaRequired;
      state.revoked = true;
      return pic({ grant_id: G1, revoked: true });
    });
    await openGrants(page);
    await page.getByRole("button", { name: "Open grant 11111111 for u-viewer" }).click();
    await page.getByRole("button", { name: "Revoke grant" }).click();
    const confirm = page.getByRole("dialog", { name: "Confirm grant revoke" });
    await expect(confirm.getByText(`POST ${GRANTS_ADMIN}/${G1}/revoke · u-viewer on cfmeet`)).toBeVisible();
    await confirm.getByLabel("Reason code").fill("ACCESS_REVIEW");
    await confirm.getByRole("button", { name: "Revoke grant" }).click();
    await confirmMfa(page);

    await expect(page.getByRole("status").filter({ hasText: "Grant 11111111 revoked." })).toBeVisible();
    const posts = api.callsTo("POST", `${GRANTS_ADMIN}/${G1}/revoke`);
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toEqual({ reason_code: "ACCESS_REVIEW" });
    await expect(page.getByRole("region", { name: "Grant 11111111" }).getByText("ACCESS_REVIEW", { exact: false })).toBeVisible();
  });

  test("creating a grant sends exact scope only and shows the server's refusal", async ({ page, api, isMobile }) => {
    test.skip(isMobile, "below-the-fold controls are not clickable in the mobile emulation of the dashboard shell; the mobile layout is covered below");
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    mocks(api, { mfaFresh: true });
    api.on("POST", GRANTS_ADMIN, picError(403, "FORBIDDEN", "SCOPE_EXCEEDS_PRODUCT"));
    await openGrants(page);
    await page.getByRole("button", { name: "Create grant" }).click();
    const dialog = page.getByRole("dialog", { name: "Create grant for cfmeet" });
    await dialog.getByLabel("Staff id").fill("u-new");
    await dialog.getByLabel("Role (optional)").fill("cfmeet.viewer");
    await dialog.getByRole("checkbox", { name: /product\.view/ }).check();
    await dialog.getByRole("checkbox", { name: /dataset\.list/ }).check();
    const create = dialog.getByRole("button", { name: "Create grant" });

    // Wildcards are refused locally; market and organization are required for ALLOW.
    await dialog.getByLabel("Market (required)").fill("*");
    await dialog.getByLabel("Organization (required)").fill("cfmeet-staging");
    await expect(dialog.getByText('market: "*" is a wildcard; enter exact values')).toBeVisible();
    await expect(create).toBeDisabled();
    // Values outside the product's allowed scope are flagged before sending.
    await dialog.getByLabel("Market (required)").fill("NG-ABJ");
    await expect(dialog.getByText("market: NG-ABJ is outside the product's allowed scope")).toBeVisible();
    await expect(create).toBeDisabled();
    await dialog.getByLabel("Market (required)").fill("NG-LAG");
    await expect(create).toBeEnabled();
    await create.click();

    await expect(dialog.getByRole("alert").getByText("Refused: The scope goes beyond the product's allowed scope.")).toBeVisible();
    await expect(dialog.getByText("Reason: FORBIDDEN / SCOPE_EXCEEDS_PRODUCT · Ref: pic-corr-2")).toBeVisible();
    expect(api.callsTo("POST", GRANTS_ADMIN)[0].body).toEqual({
      grant_kind: "PRODUCT",
      product_id: "cfmeet",
      staff_id: "u-new",
      role: "cfmeet.viewer",
      effect: "ALLOW",
      actions: ["product.view", "dataset.list"],
      datasets: [],
      scope: { market: ["NG-LAG"], organization: ["cfmeet-staging"] },
    });
    // A rule refusal is not a missing permission: the create control stays available.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Create grant" })).toBeEnabled();
  });

  test("self-grant and self-revoke are blocked in the UI", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    mocks(api, { mfaFresh: true });
    await openGrants(page);
    await page.getByRole("button", { name: `Open grant 22222222 for ${SUPER_USER.id}` }).click();
    await expect(page.getByRole("button", { name: "Revoke grant" })).toBeDisabled();
    await expect(page.getByText("You cannot revoke a grant that applies to yourself (SELF_REVOKE_DENIED).")).toBeVisible();
    await page.getByRole("button", { name: "Create grant" }).click();
    const dialog = page.getByRole("dialog", { name: "Create grant for cfmeet" });
    await dialog.getByLabel("Staff id").fill(SUPER_USER.id);
    await expect(dialog.getByText("You cannot grant access to yourself (SELF_GRANT_DENIED).")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Create grant" })).toBeDisabled();
  });

  test("the grants list fits a phone screen", async ({ page, api, isMobile }) => {
    test.skip(!isMobile, "mobile project only");
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    mocks(api, { mfaFresh: true });
    await openGrants(page);
    await expect(page.getByRole("table", { name: "Product grants" }).getByRole("row").filter({ hasText: "u-viewer" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create grant" })).toBeVisible();
    await noHorizontalScroll(page);
  });

  test("without integration.grants.manage the grants and their controls are not shown", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    api
      .on("GET", ADMIN, picError(403, "FORBIDDEN", "MISSING_PLATFORM_GRANT"))
      .on("GET", "/api/products/cfmeet/grants", picError(403, "FORBIDDEN", "MISSING_PLATFORM_GRANT"));
    await openGrants(page);
    await expect(page.getByRole("alert").filter({ hasText: "Product grants blocked" })).toBeVisible();
    await expect(page.getByText("Reason: FORBIDDEN / MISSING_PLATFORM_GRANT", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create grant" })).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Product grants" })).toHaveCount(0);
    expect(api.callsTo("POST", /\/api\/admin\//)).toHaveLength(0);
  });
});
