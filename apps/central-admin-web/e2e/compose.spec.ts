import { test, expect, signIn, defaultMocks, gotoWithEntitlements, mailbox, draft, thread, message, ok, accepted, fail, ALICE, ALICE_IDENTITY, type MockApi } from "./fixtures";

const M = "/api/mail/v1";
const ALIAS = { addressId: "addr-team", address: "team@cosmicforge.example", displayName: "CosmicForge Team", kind: "ALIAS" };

function composeMocks(api: MockApi, identities = [ALICE_IDENTITY, ALIAS]) {
  defaultMocks(api, ALICE);
  let revision = 1;
  api.on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: identities, signatureHtml: null }));
  api.on("POST", `${M}/mailboxes/mb-alice/drafts`, ok(draft()));
  api.on("PATCH", `${M}/drafts/dr-1`, (req) => {
    const body = req.postDataJSON() as { revision: number } & Record<string, unknown>;
    if (body.revision !== revision) return fail(409, "MAIL_DRAFT_REVISION_CONFLICT", "Draft changed elsewhere", [{ currentRevision: revision }]);
    revision += 1;
    return ok(draft({ ...body, revision }));
  });
  return { bump: () => (revision += 1), current: () => revision };
}

async function openCompose(page: import("@playwright/test").Page) {
  await gotoWithEntitlements(page, "/dashboard/mail/compose?mailboxId=mb-alice");
  await expect(page.getByRole("form", { name: "Compose message" })).toBeVisible();
}

async function addRecipient(page: import("@playwright/test").Page, address: string) {
  const to = page.getByLabel("To", { exact: true });
  await to.fill(address);
  await to.press("Enter");
  await expect(page.getByRole("button", { name: `Remove ${address}` })).toBeVisible();
}

test.describe("Compose: server-authorized senders, autosave and honest send feedback", () => {
  test("From offers only the server-approved identities and a refused sender shows an error, not success", async ({ page, api }) => {
    await signIn(page, ALICE);
    composeMocks(api);
    api.on("POST", `${M}/drafts/dr-1/send`, fail(403, "MAIL_SENDER_NOT_AUTHORIZED", "You are not authorized to send from this address.", [{ reason: "SENDER_DOMAIN_NOT_ALLOWLISTED" }]));
    await openCompose(page);

    const from = page.getByLabel("From");
    await expect(from.locator("option")).toHaveText(["Alice Ade <alice@cosmicforge.example>", "CosmicForge Team <team@cosmicforge.example>"]);
    await from.selectOption("addr-team");
    await addRecipient(page, "partner@partner.example");
    await page.getByLabel("Subject").fill("Hello");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(page.getByRole("alert").filter({ hasText: "not authorized to send" })).toBeVisible();
    await expect(page.getByText("Message queued for sending.")).toHaveCount(0);
    const send = api.callsTo("POST", `${M}/drafts/dr-1/send`);
    expect(send).toHaveLength(1);
    expect(send[0].headers["idempotency-key"], "send carries an idempotency key").toBeTruthy();
    // The browser only ever submits an address id the server listed; never a free-form From.
    for (const call of api.callsTo("PATCH", `${M}/drafts/dr-1`)) {
      const body = call.body as Record<string, unknown>;
      expect(["addr-alice", "addr-team", null]).toContain(body.senderAddressId);
      expect(body).not.toHaveProperty("from");
    }
  });

  test("a mailbox without approved identities cannot send", async ({ page, api }) => {
    await signIn(page, ALICE);
    composeMocks(api, []);
    await openCompose(page);
    await expect(page.getByText("No approved sender identity for this mailbox.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  });

  test("autosave sends the current revision, and a revision conflict blocks sending until resolved", async ({ page, api }) => {
    await signIn(page, ALICE);
    const server = composeMocks(api);
    await openCompose(page);

    await page.getByLabel("Subject").fill("Budget v1");
    await expect(page.getByText("Draft saved")).toBeVisible({ timeout: 10_000 });
    const firstSaves = api.callsTo("PATCH", `${M}/drafts/dr-1`).map((c) => (c.body as { revision: number }).revision);
    expect(firstSaves[0]).toBe(1);
    expect(firstSaves).toEqual(firstSaves.map((_, i) => i + 1)); // monotonically follows the server revision

    // Someone else saves the draft in another tab.
    server.bump();
    api.on("GET", `${M}/drafts/dr-1`, () => ok(draft({ subject: "Budget (edited elsewhere)", revision: server.current() })));
    await page.getByLabel("Subject").fill("Budget v2");
    const conflict = page.getByRole("alert").filter({ hasText: "This draft was changed elsewhere" });
    await expect(conflict).toBeVisible({ timeout: 10_000 });
    await expect(conflict).toContainText(`revision ${server.current()}`);
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();

    await conflict.getByRole("button", { name: "Load latest" }).click();
    await expect(conflict).toHaveCount(0);
    await expect(page.getByLabel("Subject")).toHaveValue("Budget (edited elsewhere)");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  });

  test("a 202 send is shown as queued, never as delivered", async ({ page, api }) => {
    await signIn(page, ALICE);
    composeMocks(api);
    api.on("POST", `${M}/drafts/dr-1/send`, accepted({ messageId: "msg-out", threadId: "th-out", jobId: "job-1", status: "QUEUED" }));
    const out = message({ id: "msg-out", threadId: "th-out", direction: "OUTBOUND", status: "QUEUED", from: { address: ALICE_IDENTITY.address, name: "Alice Ade" }, recipients: [{ address: "partner@partner.example", name: null, type: "TO", status: "PENDING" }], html: "<p>Hi</p>", receivedAt: null, sentAt: null });
    api.on("GET", `${M}/threads/th-out`, ok(thread({ id: "th-out", subject: "Hello", lastDeliveryStatus: "QUEUED", isRead: true })));
    api.on("GET", `${M}/threads/th-out/messages`, ok([out]));
    api.on("GET", `${M}/messages/msg-out/status`, ok({ status: "QUEUED", recipients: out.recipients, deliveryEvents: [] }));
    await openCompose(page);

    await addRecipient(page, "partner@partner.example");
    await page.getByLabel("Subject").fill("Hello");
    await page.getByRole("textbox", { name: "Message body" }).fill("Hi");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(page).toHaveURL(/\/dashboard\/mail\/mb-alice\/thread\/th-out/);
    const reading = page.getByRole("region", { name: "Conversation" });
    await expect(reading.getByText("Queued", { exact: true }).first()).toBeVisible();
    await expect(reading.getByText("Delivered", { exact: true })).toHaveCount(0);
    const send = api.callsTo("POST", `${M}/drafts/dr-1/send`);
    expect(send).toHaveLength(1);
    expect((send[0].body as { revision: number }).revision).toBeGreaterThanOrEqual(1);
  });
});
