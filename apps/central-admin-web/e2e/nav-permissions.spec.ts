import { test, expect, signIn, defaultMocks, entitlements, gotoWithEntitlements, ALICE, SUPER_USER } from "./fixtures";

test.describe("Mail navigation is driven only by server entitlements", () => {
  test.skip(({ isMobile }) => !!isMobile, "sidebar nav is a desktop drawer; mobile covered in mobile.spec");

  test("Mail nav is shown for an employee with a mailbox", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    await gotoWithEntitlements(page, "/dashboard");
    await expect(page.locator('a[href="/dashboard/mail"]').first()).toBeVisible();
    expect(api.blockedExternal.filter((u) => !u.startsWith("https://fonts."))).toEqual([]);
  });

  test("Mail nav is hidden when Mail is disabled", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE, entitlements({ mailEnabled: false, mailboxes: [] }));
    await gotoWithEntitlements(page, "/dashboard");
    await expect(page.getByRole("navigation").first()).toBeVisible();
    await expect(page.locator('a[href="/dashboard/mail"]')).toHaveCount(0);
  });

  test("Mail nav is hidden for an employee with no mailbox and no admin capability", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE, entitlements({ mailboxes: [] }));
    await gotoWithEntitlements(page, "/dashboard");
    await expect(page.getByRole("navigation").first()).toBeVisible();
    await expect(page.locator('a[href="/dashboard/mail"]')).toHaveCount(0);
  });

  test("Mail nav is hidden when the entitlement call is refused", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", "/api/mail/v1/me/entitlements", { status: 503, body: { success: false, code: "MAIL_DISABLED", message: "Mail is disabled" } });
    await gotoWithEntitlements(page, "/dashboard");
    await expect(page.getByRole("navigation").first()).toBeVisible();
    await expect(page.locator('a[href="/dashboard/mail"]')).toHaveCount(0);
  });

  test("SUPER with no memberships gets no private mailbox content, even when allowed to administer domains", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER, entitlements({ mailboxes: [], canManageDomains: true }));
    await gotoWithEntitlements(page, "/dashboard/mail");
    await expect(page.getByRole("heading", { name: "No mailbox assigned" })).toBeVisible();
    await expect(page.locator('a[href="/dashboard/mail"]').first()).toBeVisible();
    // The SUPER account never receives private mailbox content.
    expect(api.callsTo("GET", /\/api\/mail\/v1\/mailboxes\/[^/]+\/threads/)).toHaveLength(0);
    expect(api.unmatched).toEqual([]);
  });
});
