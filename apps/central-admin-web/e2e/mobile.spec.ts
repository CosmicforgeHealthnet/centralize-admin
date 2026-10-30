import { test, expect, signIn, defaultMocks, gotoWithEntitlements, mailbox, thread, message, ok, noHorizontalScroll, ALICE } from "./fixtures";

const M = "/api/mail/v1";

test.describe("Mail on a phone-width viewport", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile project only");

  test("inbox and thread are usable at 390px without horizontal page scroll", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    const long = "A-very-long-unbroken-subject-line-that-should-never-force-the-page-wider-than-the-phone-screen";
    api.on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [], signatureHtml: null }));
    api.on("GET", `${M}/mailboxes/mb-alice/threads`, ok([thread({ subject: long }), thread({ id: "th-2", subject: "Second" })], { nextCursor: null }));
    api.on("GET", `${M}/threads/th-1`, ok(thread({ subject: long, isRead: true })));
    api.on("GET", `${M}/threads/th-1/messages`, ok([message({ subject: long, html: `<table width="900"><tr><td>${long}</td></tr></table>` })]));

    await gotoWithEntitlements(page, "/dashboard/mail/mb-alice");
    const list = page.getByRole("list", { name: "Conversations" });
    await expect(list.getByText("Second")).toBeVisible();
    await noHorizontalScroll(page);

    // Folder navigation is a drawer on mobile.
    await page.getByRole("button", { name: "Open folders" }).click();
    await expect(page.getByRole("button", { name: "Close folders" })).toBeVisible();
    await page.getByRole("button", { name: "Close folders" }).click();

    await list.locator("a[data-thread-link='th-1']").click();
    await expect(page).toHaveURL(/\/thread\/th-1/);
    await expect(page.getByRole("link", { name: "Back to list" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Conversation list" })).toBeHidden();
    await expect(page.locator("iframe").first()).toBeVisible();
    await noHorizontalScroll(page);

    await page.getByRole("link", { name: "Back to list" }).click();
    await expect(list.getByText("Second")).toBeVisible();
    await noHorizontalScroll(page);
  });
});
