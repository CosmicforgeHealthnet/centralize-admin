import { test, expect, signIn, defaultMocks, entitlements, gotoWithEntitlements, mailbox, thread, message, draft, ALICE_IDENTITY, preferences, SUPPORT_MAILBOX, ok, accepted, noHorizontalScroll, attachScreenshot, ALICE } from "./fixtures";

const M = "/api/mail/v1";
const MK = `${M}/marketing`;

test.describe("Section 16 visual acceptance — deterministic inbox fixtures", () => {
  test("inbox and open thread render at the active desktop or mobile viewport", async ({ page, api }, testInfo) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [ALICE_IDENTITY], signatureHtml: null }));
    api.on("GET", `${M}/me/preferences`, ok(preferences({ defaultSenderAddressId: ALICE_IDENTITY.addressId })));
    api.on("POST", `${M}/mailboxes/mb-alice/drafts`, ok(draft({ senderAddressId: ALICE_IDENTITY.addressId })));
    api.on("PATCH", `${M}/drafts/dr-1`, (req) => ok(draft({ ...(req.postDataJSON() as Record<string, unknown>), revision: 2, senderAddressId: ALICE_IDENTITY.addressId })));
    api.on("GET", `${M}/mailboxes/mb-alice/threads`, ok([
      thread({ id: "th-1", subject: "Quarterly figures", snippet: "Please find the numbers attached", hasAttachments: true }),
      thread({ id: "th-2", subject: "Project update", snippet: "A short status update", isRead: true, lastMessageAt: "2026-10-23T15:30:00.000Z" }),
    ], { nextCursor: null }));
    api.on("GET", `${M}/threads/th-1`, ok(thread({ subject: "Quarterly figures", hasAttachments: true, isRead: true })));
    api.on("GET", `${M}/threads/th-1/messages`, ok([message({ html: "<p>Please find the numbers attached. The Q4 forecast is ready for review.</p>" })]));

    await gotoWithEntitlements(page, "/dashboard/mail/mb-alice");
    await expect(page.getByRole("list", { name: "Conversations" }).getByText("Quarterly figures")).toBeVisible();
    await attachScreenshot(page, testInfo, "mail-inbox");

    if (testInfo.project.name.toLowerCase().includes("mobile")) {
      await page.getByRole("button", { name: "Open folders" }).click();
      const drawer = page.getByRole("dialog", { name: "Mail folders" });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole("button", { name: "Close folders" })).toBeFocused();
      await attachScreenshot(page, testInfo, "mail-folder-drawer-mobile");
      await page.keyboard.press("Shift+Tab");
      await expect(drawer.getByRole("link", { name: "Mailbox settings" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(drawer.getByRole("button", { name: "Close folders" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Open folders" })).toBeFocused();
    }

    await page.keyboard.press("j");
    await expect(page.getByRole("heading", { name: "Quarterly figures" })).toBeVisible();
    await expect(page.getByTitle("Message body: Quarterly figures")).toBeVisible();
    await attachScreenshot(page, testInfo, "mail-thread");

    await page.keyboard.press("r");
    await expect(page.getByRole("form", { name: "Compose message" })).toBeVisible();
    await expect(page.getByLabel("From", { exact: true })).toHaveValue(ALICE_IDENTITY.addressId);
    await attachScreenshot(page, testInfo, "mail-quick-compose");

    await gotoWithEntitlements(page, "/dashboard/mail/compose?mailboxId=mb-alice");
    await expect(page.getByRole("form", { name: "Compose message" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message body" })).toBeVisible();
    await attachScreenshot(page, testInfo, "mail-full-compose");
  });

  test("keyboard reply keeps attachment and queued-send state honest", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [ALICE_IDENTITY], signatureHtml: null }));
    api.on("GET", `${M}/me/preferences`, ok(preferences({ defaultSenderAddressId: ALICE_IDENTITY.addressId })));
    api.on("GET", `${M}/mailboxes/mb-alice/threads`, ok([thread({ id: "th-1", subject: "Quarterly figures", hasAttachments: true })], { nextCursor: null }));
    api.on("GET", `${M}/threads/th-1`, ok(thread({ id: "th-1", subject: "Quarterly figures", isRead: true })));
    api.on("GET", `${M}/threads/th-1/messages`, ok([message({ id: "msg-1", threadId: "th-1" })]));
    api.on("PATCH", `${M}/threads/th-1/state`, ok({}));
    api.on("POST", `${M}/mailboxes/mb-alice/drafts`, ok(draft({ mode: "REPLY", threadId: "th-1", inReplyToMessageId: "msg-1", senderAddressId: ALICE_IDENTITY.addressId, to: [{ address: "partner@partner.example", name: "Pat Partner" }], subject: "Re: Quarterly figures" })));
    api.on("PATCH", `${M}/drafts/dr-1`, (req) => ok(draft({ ...(req.postDataJSON() as Record<string, unknown>), revision: 2, senderAddressId: ALICE_IDENTITY.addressId })));
    api.on("POST", `${M}/drafts/dr-1/attachments`, ok({ id: "att-1", filename: "notes.txt", contentType: "text/plain", sizeBytes: 13, isInline: false, scanStatus: "CLEAN", downloadable: true }));
    api.on("POST", `${M}/drafts/dr-1/send`, accepted({ messageId: "msg-2", threadId: "th-1", status: "QUEUED" }));

    await gotoWithEntitlements(page, "/dashboard/mail/mb-alice");
    await page.keyboard.press("j");
    await expect(page.getByRole("heading", { name: "Quarterly figures" })).toBeVisible();
    await page.keyboard.press("r");
    const compose = page.getByRole("form", { name: "Compose message" });
    await expect(compose).toBeVisible();
    await expect(compose.getByRole("combobox", { name: "To" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(compose.getByLabel("Subject")).toBeFocused();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Re: Quarterly figures");
    for (let i = 0; i < 7; i++) await page.keyboard.press("Tab");
    const body = page.getByRole("textbox", { name: "Message body" });
    await expect(body).toBeFocused();
    await page.keyboard.type("I have reviewed the attached figures.");
    await expect(compose.getByRole("status").first()).toContainText(/saved/i);

    await page.keyboard.press("Tab");
    await expect(compose.getByRole("button", { name: /Send/ })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(compose.getByRole("button", { name: "Attach" })).toBeFocused();
    const chooserPromise = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("review notes\n") });
    await expect(compose.getByText("notes.txt")).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(compose.getByRole("button", { name: /Send/ })).toBeFocused();
    await page.keyboard.press("Control+Enter");
    await expect(page.getByText("Message queued for sending.", { exact: true })).toBeVisible();
    await expect(page.getByText(/It has not been delivered yet/)).toBeVisible();
    expect(api.callsTo("POST", `${M}/drafts/dr-1/attachments`)).toHaveLength(1);
    expect(api.callsTo("POST", `${M}/drafts/dr-1/send`)).toHaveLength(1);
  });

  test("compose reflows without horizontal overflow from 320px through desktop widths", async ({ page, api, isMobile }, testInfo) => {
    test.skip(!isMobile, "responsive width sweep runs in the mobile Chromium project");
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [ALICE_IDENTITY], signatureHtml: null }));
    api.on("GET", `${M}/me/preferences`, ok(preferences({ defaultSenderAddressId: ALICE_IDENTITY.addressId })));
    api.on("POST", `${M}/mailboxes/mb-alice/drafts`, ok(draft({ senderAddressId: ALICE_IDENTITY.addressId })));

    await gotoWithEntitlements(page, "/dashboard/mail/compose?mailboxId=mb-alice");
    await expect(page.getByRole("form", { name: "Compose message" })).toBeVisible();
    for (const width of [320, 375, 390, 768, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await noHorizontalScroll(page);
      if (width === 320) await attachScreenshot(page, testInfo, "mail-compose-320px");
    }
  });

  test("mail search and personal settings have clear, readable states", async ({ page, api }, testInfo) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [ALICE_IDENTITY], signatureHtml: "<p>Alice Ade</p>" }));
    api.on("GET", `${M}/mailboxes/mb-alice/rules`, ok([]));
    api.on("GET", `${M}/mailboxes/mb-alice/forwarding`, ok([]));
    api.on("GET", `${M}/provisioning/requests`, ok([]));
    api.on("GET", `${M}/mailboxes/mb-alice/search`, ok([thread()], { nextCursor: null }));

    await gotoWithEntitlements(page, "/dashboard/mail/mb-alice");
    await page.getByLabel("Search mail").fill("Quarterly");
    await page.getByRole("button", { name: "Advanced search" }).click();
    await page.getByLabel("from").fill("partner@partner.example");
    await page.getByRole("search", { name: "Search this mailbox" }).getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/q=Quarterly.*from=partner/);
    await expect(page.getByText("Search results", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove q filter" })).toBeVisible();
    await attachScreenshot(page, testInfo, "mail-search");

    await page.goto("/dashboard/mail/settings?mailboxId=mb-alice");
    await expect(page.getByRole("heading", { name: "Mail settings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Signature" })).toBeVisible();
    await attachScreenshot(page, testInfo, "mail-settings");
  });

  test("shared Support queue presents team ownership and service context", async ({ page, api }, testInfo) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE, entitlements({ mailboxes: [mailbox(), SUPPORT_MAILBOX] }));
    api.on("GET", `${M}/mailboxes/mb-support/queue`, ok([
      thread({ id: "sq-1", mailboxId: "mb-support", subject: "Cannot log in", conversationStatus: "OPEN", assignedTo: null }),
      thread({ id: "sq-2", mailboxId: "mb-support", subject: "Refund request", conversationStatus: "PENDING", assignedTo: { id: ALICE.id, name: ALICE.name }, isRead: true }),
    ], { nextCursor: null }));
    api.on("GET", `${M}/mailboxes/mb-support`, ok({ ...SUPPORT_MAILBOX, senderIdentities: [], signatureHtml: null }));

    await gotoWithEntitlements(page, "/dashboard/mail/mb-support?view=queue");
    await expect(page.getByRole("list", { name: "Support queue" }).getByText("Cannot log in")).toBeVisible();
    await expect(page.getByRole("list", { name: "Support queue" }).getByText("Unassigned")).toBeVisible();
    await attachScreenshot(page, testInfo, "mail-support-queue");
  });

  test("Mail empty and service-error states stay explicit", async ({ page, api }, testInfo) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [], signatureHtml: null }));
    api.on("GET", `${M}/mailboxes/mb-alice/threads`, ok([], { nextCursor: null }));
    await gotoWithEntitlements(page, "/dashboard/mail/mb-alice");
    await expect(page.getByText("No conversations here.")).toBeVisible();
    await attachScreenshot(page, testInfo, "mail-empty");

    await page.route("**/api/mail/v1/mailboxes/mb-alice/threads**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ success: false, code: "UNAVAILABLE", message: "Mail is temporarily unavailable." }) }));
    await page.reload();
    await expect(page.locator('section[role="alert"]')).toContainText(/unavailable|try again/i);
    await attachScreenshot(page, testInfo, "mail-service-error");
  });

  test("Email Marketing overview is brand-scoped and clearly reports disabled execution", async ({ page, api }, testInfo) => {
    await signIn(page, ALICE);
    const org = { id: "org-cf", organizationId: "org-cf", slug: "cosmicforge", name: "CosmicForge", canAuthor: true, canApprove: false };
    defaultMocks(api, ALICE, entitlements({ mailboxes: [], marketingEnabled: true, marketing: [org] }));
    api.on("GET", `${MK}/organizations`, ok([org]));
    api.on("GET", `${MK}/org-cf/campaigns`, ok([{ id: "cmp-1", status: "READY_FOR_REVIEW" }], { nextCursor: null }));
    api.on("GET", `${MK}/org-cf/audiences`, ok([{ id: "aud-1", name: "Product updates", contactCount: 128, topic: "updates" }], { nextCursor: null }));
    api.on("GET", `${MK}/org-cf/templates`, ok([{ id: "tpl-1", name: "Product email" }], { nextCursor: null }));
    api.on("GET", `${MK}/org-cf/reports/overview`, ok({ campaigns: { READY_FOR_REVIEW: 1 }, recipientsLast30Days: {}, activeSuppressions: {}, automations: { ACTIVE: 1 }, enrollments: { COMPLETED: 7 }, jobs: [], flags: { broadcastDispatchEnabled: false, automationEnabled: false, emergencyStop: false } }));
    await gotoWithEntitlements(page, "/dashboard/marketing/email-marketing");
    await expect(page.getByRole("heading", { name: "Email Marketing" })).toBeVisible();
    const sectionTabs = page.getByRole("navigation", { name: "Email marketing sections" });
    await expect(sectionTabs.getByRole("link", { name: "Settings" })).toBeVisible();
    expect(await sectionTabs.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    await expect(page.getByText("Broadcast dispatch is not enabled in this environment")).toBeVisible();
    await attachScreenshot(page, testInfo, "marketing-overview");
  });
});
