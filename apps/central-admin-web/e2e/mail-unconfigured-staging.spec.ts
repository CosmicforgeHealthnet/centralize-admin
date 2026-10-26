import { test, expect, signIn, defaultMocks, fail, SUPER_USER, ALICE } from "./fixtures";

const disabled = fail(503, "MAIL_DISABLED", "CosmicForge Mail is currently switched off for this environment.");

test.describe("Staging Mail workspace without an active Mail backend", () => {
  test.skip(process.env.NEXT_PUBLIC_STAGING_MAIL_NAV_ENABLED !== "true", "staging workspace flag is required");

  test("privileged reviewer sees an honest Mail workspace, not a fabricated mailbox", async ({ page, api, isMobile }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    api.on("GET", "/api/mail/v1/me/entitlements", disabled);

    await page.goto("/dashboard/mail");
    await expect(page.getByRole("heading", { name: "Mail", exact: true })).toBeVisible();
    await expect(page.getByText("Mailbox connection pending.", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Mailbox not connected" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Compose" })).toBeDisabled();
    if (!isMobile) await expect(page.getByText("No active mailbox")).toBeVisible();
    if (isMobile) {
      await page.getByRole("button", { name: "Open folders" }).click();
      const drawer = page.getByRole("dialog", { name: "Mail folders" });
      await expect(drawer.getByRole("button", { name: "Close folders" })).toBeFocused();
      await drawer.getByRole("button", { name: "Sent" }).click();
      await expect(page.getByRole("heading", { name: "Sent" })).toBeVisible();
    } else {
      await page.getByRole("button", { name: "Sent" }).click();
      await expect(page.getByRole("heading", { name: "Sent" })).toBeVisible();
    }
    expect(api.callsTo("POST", /\/api\/mail\/v1/)).toHaveLength(0);
    expect(api.callsTo("GET", /\/api\/mail\/v1\/(mailboxes|threads)\//)).toHaveLength(0);
  });

  test("nonprivileged employee never sees the staging admin-only shell", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", "/api/mail/v1/me/entitlements", disabled);

    await page.goto("/dashboard/mail");
    await expect(page.getByText("Mail is not enabled")).toBeVisible();
    await expect(page.getByText("Mailbox connection pending.")).toHaveCount(0);
    expect(api.callsTo("GET", /\/api\/mail\/v1\/(mailboxes|threads)\//)).toHaveLength(0);
  });
});
