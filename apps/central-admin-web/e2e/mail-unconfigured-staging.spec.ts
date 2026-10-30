import { test, expect, signIn, defaultMocks, fail, SUPER_USER, ALICE } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";

const disabled = fail(503, "MAIL_DISABLED", "CosmicForge Mail is currently switched off for this environment.");

test.describe("Staging Mail workspace without an active Mail backend", () => {
  test.skip(process.env.NEXT_PUBLIC_STAGING_MAIL_NAV_ENABLED !== "true", "staging workspace flag is required");

  test("privileged reviewer sees an honest, responsive Mail workspace without fabricated mailbox data", async ({ page, api, isMobile }, testInfo) => {
    await signIn(page, SUPER_USER);
    const initialWidth = Number(process.env.MAIL_E2E_INITIAL_WIDTH);
    if (!isMobile && Number.isInteger(initialWidth) && initialWidth >= 320 && initialWidth <= 1920) {
      await page.setViewportSize({ width: initialWidth, height: 900 });
    }
    defaultMocks(api, SUPER_USER);
    api.on("GET", "/api/mail/v1/me/entitlements", disabled);

    await page.goto("/dashboard/mail");
    await expect(page.getByRole("heading", { name: "Mail", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your Mail workspace is being prepared" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Mailbox not connected" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Compose" })).toBeDisabled();
    await expect(page.getByRole("searchbox", { name: "Search conversations, unavailable until mailbox activation" })).toBeDisabled();
    if (!isMobile) await expect(page.getByRole("heading", { name: "A quieter space to read" })).toBeVisible();
    if (!isMobile) await expect(page.getByText("No active mailbox")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`mail-${isMobile ? "mobile" : "desktop"}-pending.png`), fullPage: !initialWidth });

    const axe = await new AxeBuilder({ page }).include('[aria-label="Mail workspace"]').analyze();
    expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);

    if (isMobile) {
      await page.getByRole("button", { name: "Open folders" }).click();
      let drawer = page.getByRole("dialog", { name: "Mail folders" });
      await expect(drawer.getByRole("button", { name: "Close folders" })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(drawer.getByRole("button", { name: "Trash" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Open folders" })).toBeFocused();
      await page.getByRole("button", { name: "Open folders" }).click();
      drawer = page.getByRole("dialog", { name: "Mail folders" });
      await expect(drawer.getByRole("button", { name: "Close folders" })).toBeFocused();
      await drawer.getByRole("button", { name: "Sent" }).click();
      await expect(page.getByRole("heading", { name: "Sent" })).toBeVisible();
    } else {
      await page.getByRole("button", { name: "Sent" }).click();
      await expect(page.getByRole("heading", { name: "Sent" })).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath(`mail-${isMobile ? "mobile" : "desktop"}-folder-selected.png`), fullPage: true });

    for (const width of [320, 375, 390, 768, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
      if (width >= 768 && width < 1116) await page.waitForTimeout(350); // Let the dashboard's width transition settle before layout checks.
      const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
      expect(dimensions.document, `horizontal overflow at ${width}px: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(dimensions.viewport);
      if (width >= 768 && width < 1116) {
        const layout = await page.evaluate(() => {
          const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect();
          const main = document.querySelector(".dashboard-main")?.getBoundingClientRect();
          return { sidebarWidth: sidebar?.width, sidebarRight: sidebar?.right, mainLeft: main?.left };
        });
        expect(layout.sidebarWidth, `tablet sidebar should use the compact width at ${width}px`).toBe(72);
        expect(layout.mainLeft, `main content should clear the tablet sidebar at ${width}px`).toBeGreaterThanOrEqual(layout.sidebarRight ?? Infinity);
      }
      if (!isMobile && (width === 768 || width === 1024)) {
        await page.screenshot({ path: testInfo.outputPath(`mail-tablet-${width}.png`), fullPage: false });
      }
      if (isMobile && width === 320) {
        await page.screenshot({ path: testInfo.outputPath("mail-mobile-320.png"), fullPage: true });
      }
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
