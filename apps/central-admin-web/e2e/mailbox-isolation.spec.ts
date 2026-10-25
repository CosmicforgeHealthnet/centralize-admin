import { test, expect, signIn, defaultMocks, entitlements, gotoWithEntitlements, mailbox, thread, message, fail, ok, ALICE, SUPER_USER } from "./fixtures";

const M = "/api/mail/v1";

test.describe("Private mailbox isolation", () => {
  test("only entitled mailboxes are listed and another user's mailbox is refused without content", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [], signatureHtml: null }));
    api.on("GET", `${M}/mailboxes/mb-alice/threads`, ok([thread()], { nextCursor: null }));
    api.on("GET", `${M}/mailboxes/mb-bob/threads`, ok([thread({ id: "th-bob", subject: "Bob private salary" })], { nextCursor: null }));

    await gotoWithEntitlements(page, "/dashboard/mail/mb-alice");
    await expect(page.getByRole("list", { name: "Conversations" }).getByText("Quarterly figures")).toBeVisible();

    await gotoWithEntitlements(page, "/dashboard/mail/mb-bob");
    await expect(page.getByRole("alert").getByText("Mailbox not available")).toBeVisible();
    await expect(page.getByText("Bob private salary")).toHaveCount(0);
    expect(api.callsTo("GET", `${M}/mailboxes/mb-bob/threads`), "no request for a mailbox outside the entitlement list").toHaveLength(0);
  });

  test("a thread the server refuses (403) renders Access denied, never message content", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", `${M}/threads/th-foreign`, fail(403, "MAIL_FORBIDDEN", "You do not have access to this mailbox."));
    api.on("GET", `${M}/threads/th-foreign/messages`, fail(403, "MAIL_FORBIDDEN", "You do not have access to this mailbox."));
    await gotoWithEntitlements(page, "/dashboard/mail/mb-alice/thread/th-foreign");
    await expect(page.getByRole("heading", { name: "Access denied" }).first()).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
  });

  test("a thread that does not exist (404) renders Not found", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", `${M}/threads/th-missing`, fail(404, "MAIL_NOT_FOUND", "Not found"));
    api.on("GET", `${M}/threads/th-missing/messages`, fail(404, "MAIL_NOT_FOUND", "Not found"));
    await gotoWithEntitlements(page, "/dashboard/mail/mb-alice/thread/th-missing");
    await expect(page.getByRole("heading", { name: "Not found" }).first()).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
  });

  test("SUPER cannot open a staff mailbox by URL: no thread or message request is made", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER, entitlements({ mailboxes: [], canManageDomains: true, canProvision: true }));
    api.on("GET", `${M}/threads/th-1/messages`, ok([message()]));
    await gotoWithEntitlements(page, "/dashboard/mail/mb-alice/thread/th-1");
    await expect(page.getByText("Mailbox not available")).toBeVisible();
    await expect(page.getByText("Please find the numbers attached")).toHaveCount(0);
    expect(api.callsTo("GET", /\/api\/mail\/v1\/(threads|mailboxes)\//)).toHaveLength(0);
  });
});
