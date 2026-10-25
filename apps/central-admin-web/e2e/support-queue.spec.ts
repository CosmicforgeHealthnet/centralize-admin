import { test, expect, signIn, defaultMocks, entitlements, gotoWithEntitlements, mailbox, thread, message, ok, fail, ALICE, SUPPORT_MAILBOX } from "./fixtures";

const M = "/api/mail/v1";
const ENTS = entitlements({ mailboxes: [mailbox(), SUPPORT_MAILBOX] });
const T1 = thread({ id: "sq-1", mailboxId: "mb-support", subject: "Cannot log in", conversationStatus: "OPEN", assignedTo: null, participants: [{ address: "patient@client.example", name: "Pat" }] });
const T2 = thread({ id: "sq-2", mailboxId: "mb-support", subject: "Refund request", conversationStatus: "OPEN", assignedTo: { id: ALICE.id, name: ALICE.name }, isRead: true });

test.describe("Shared Support mailbox", () => {
  test("members see the queue with status and assignment, and can work a conversation", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE, ENTS);
    api.on("GET", `${M}/mailboxes/mb-support/queue`, ok([T1, T2], { nextCursor: null }));
    api.on("GET", `${M}/mailboxes/mb-support`, ok({ ...SUPPORT_MAILBOX, senderIdentities: [{ addressId: "addr-support", address: "support@cosmicforge.example", displayName: "Support", kind: "SHARED" }], signatureHtml: null }));
    api.on("GET", `${M}/mailboxes/mb-support/members`, ok([
      { id: "mem-a", adminUserId: ALICE.id, name: ALICE.name, email: ALICE.email, role: "MEMBER", canSend: true, createdAt: "2026-10-01T00:00:00Z" },
      { id: "mem-c", adminUserId: "u-carol", name: "Carol Agent", email: "carol@cosmicforge.example", role: "MEMBER", canSend: true, createdAt: "2026-10-01T00:00:00Z" },
    ]));
    api.on("GET", `${M}/threads/sq-1`, ok(T1));
    api.on("GET", `${M}/threads/sq-1/messages`, ok([message({ id: "m-sq", threadId: "sq-1", mailboxId: "mb-support", subject: "Cannot log in", html: "<p>Help please</p>" })]));
    api.on("GET", `${M}/threads/sq-1/notes`, ok([{ id: "n-1", body: "Called back, waiting on reset", mentions: [], createdAt: "2026-10-24T08:00:00Z", author: { id: "u-carol", name: "Carol Agent" } }]));
    api.on("POST", `${M}/threads/sq-1/assign`, (req) => ok({ ...T1, assignedTo: { id: (req.postDataJSON() as { assigneeAdminUserId: string }).assigneeAdminUserId, name: "Carol Agent" }, revision: 2 }));

    await gotoWithEntitlements(page, "/dashboard/mail/mb-support?view=queue");
    const queue = page.getByRole("list", { name: "Support queue" });
    await expect(queue.getByText("Cannot log in")).toBeVisible();
    await expect(queue.getByText("Unassigned")).toBeVisible();
    await expect(queue.getByText("Assigned to me")).toBeVisible();

    await queue.getByText("Cannot log in").click();
    const panel = page.getByRole("region", { name: "Shared conversation" });
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel("Conversation status")).toHaveValue("OPEN");
    await expect(panel.getByText("Called back, waiting on reset")).toBeVisible();
    await panel.getByLabel("Assign conversation").selectOption("u-carol");
    await expect.poll(() => api.callsTo("POST", `${M}/threads/sq-1/assign`).length).toBe(1);
    expect(api.callsTo("POST", `${M}/threads/sq-1/assign`)[0].body).toEqual({ assigneeAdminUserId: "u-carol" });
  });

  test("a revoked member gets the access-denied state instead of the queue", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE, ENTS);
    api.on("GET", `${M}/mailboxes/mb-support/queue`, fail(403, "MAIL_FORBIDDEN", "Membership revoked"));
    await gotoWithEntitlements(page, "/dashboard/mail/mb-support?view=queue");
    await expect(page.getByText("You are not a member of this shared mailbox.")).toBeVisible();
    await expect(page.getByText("Cannot log in")).toHaveCount(0);
  });
});
