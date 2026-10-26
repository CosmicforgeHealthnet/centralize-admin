import { test, expect, signIn, defaultMocks, entitlements, gotoWithEntitlements, mailbox, myGrants, ok, ALICE, SUPER_USER, REVIEWER, SUPPORT_MAILBOX } from "./fixtures";

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
    // canProvision is true for every active employee (self requests) and must not reveal Mail.
    defaultMocks(api, ALICE, entitlements({ mailboxes: [], canProvision: true }));
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

test.describe("Section navigation follows tier and section grants", () => {
  test.skip(({ isMobile }) => !!isMobile, "sidebar nav is a desktop drawer; mobile covered in mobile.spec");
  const link = (page: import("@playwright/test").Page, href: string) => page.locator(`a[href="${href}"]`);

  test("an employee without grants sees personal pages and Mail only", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    await gotoWithEntitlements(page, "/dashboard");
    await expect(link(page, "/dashboard/mail").first()).toBeVisible();
    await expect(link(page, "/dashboard/profile").first()).toBeVisible();
    for (const href of ["/dashboard/users", "/dashboard/hr", "/dashboard/finance", "/dashboard/it", "/dashboard/analytics", "/dashboard/healthnet"]) {
      await expect(link(page, href), href).toHaveCount(0);
    }
    expect(api.callsTo("GET", "/api/hrm/accounts/me/grants")).toHaveLength(1);
  });

  test("an employee sees exactly the sections they hold grants for", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", "/api/hrm/accounts/me/grants", ok(myGrants("EMPLOYEE", [{ module: "hrm", section: "leaves" }, { module: "finance", section: "reports" }])));
    await gotoWithEntitlements(page, "/dashboard");
    await expect(link(page, "/dashboard/hr").first()).toBeVisible();
    await expect(link(page, "/dashboard/finance").first()).toBeVisible();
    await expect(link(page, "/dashboard/marketing")).toHaveCount(0);
    await expect(link(page, "/dashboard/users")).toHaveCount(0);
  });

  test("a Support mailbox member without a support grant reaches Help through the email channel", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE, entitlements({ mailboxes: [mailbox(), SUPPORT_MAILBOX] }));
    await gotoWithEntitlements(page, "/dashboard");
    await expect(link(page, "/dashboard/help/email").first()).toBeVisible();
    await expect(link(page, "/dashboard/help")).toHaveCount(0);
  });

  test("an employee opening a section without a grant is told so", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    await gotoWithEntitlements(page, "/dashboard/finance");
    await expect(page.getByRole("heading", { name: "You do not have access to this section" })).toBeVisible();
  });

  for (const user of [SUPER_USER, REVIEWER]) {
    test(`${user.tier} keeps the full navigation without a grants lookup`, async ({ page, api }) => {
      await signIn(page, user);
      defaultMocks(api, user);
      await gotoWithEntitlements(page, "/dashboard");
      for (const href of ["/dashboard/users", "/dashboard/help", "/dashboard/hr", "/dashboard/it", "/dashboard/finance", "/dashboard/marketing", "/dashboard/analytics", "/dashboard/verification", "/dashboard/healthnet"]) {
        await expect(link(page, href).first(), href).toBeVisible();
      }
      expect(api.callsTo("GET", "/api/hrm/accounts/me/grants")).toHaveLength(0);
    });
  }
});
