import { test, expect, signIn, defaultMocks, gotoWithEntitlements, mailbox, draft, preferences, noHorizontalScroll, ok, fail, ALICE, ALICE_IDENTITY } from "./fixtures";

// Personal Mail preferences (spec 15 "Profiles"): default sender and the
// new-mail notification toggle on the settings page; compose pre-selects the
// preferred sender when it belongs to the mailbox.

const M = "/api/mail/v1";
const TEAM = { addressId: "addr-team", address: "team@cosmicforge.example", displayName: "CosmicForge Team", kind: "ALIAS" };
const OPTIONS = [
  { ...ALICE_IDENTITY, mailboxId: "mb-alice", mailboxName: "Alice Ade" },
  { ...TEAM, mailboxId: "mb-alice", mailboxName: "Alice Ade" },
];

function settingsMocks(api: import("./fixtures").MockApi) {
  defaultMocks(api, ALICE);
  api
    .on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [ALICE_IDENTITY, TEAM], signatureHtml: null }))
    .on("GET", `${M}/mailboxes/mb-alice/rules`, ok([]))
    .on("GET", `${M}/mailboxes/mb-alice/forwarding`, ok([]))
    .on("GET", `${M}/provisioning/requests`, ok([]));
}

test.describe("Mail preferences", () => {
  test("a user picks a default sender and turns off new-mail notifications", async ({ page, api }) => {
    await signIn(page, ALICE);
    settingsMocks(api);
    let current = preferences({ senderOptions: OPTIONS });
    api
      .on("GET", `${M}/me/preferences`, () => ok(current))
      .on("PUT", `${M}/me/preferences`, (req) => {
        current = { ...current, ...(req.postDataJSON() as Record<string, unknown>) };
        return ok(current);
      });

    await gotoWithEntitlements(page, "/dashboard/mail/settings?mailboxId=mb-alice");
    const section = page.getByRole("region", { name: "Preferences" });
    const sender = section.getByLabel("Default sender");
    await expect(sender.locator("option")).toHaveText(["First address of each mailbox", "Alice Ade <alice@cosmicforge.example> (Alice Ade)", "CosmicForge Team <team@cosmicforge.example> (Alice Ade)"]);
    await sender.selectOption("addr-team");
    await expect.poll(() => api.callsTo("PUT", `${M}/me/preferences`).length).toBe(1);
    expect(api.callsTo("PUT", `${M}/me/preferences`)[0].body).toEqual({ defaultSenderAddressId: "addr-team" });
    await expect(section.getByRole("status").filter({ hasText: "Preferences saved." })).toBeVisible();

    const toggle = section.getByLabel("Notify me about new email");
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect.poll(() => api.callsTo("PUT", `${M}/me/preferences`).length).toBe(2);
    expect(api.callsTo("PUT", `${M}/me/preferences`)[1].body).toEqual({ notificationsEnabled: false });
    await expect(toggle).not.toBeChecked();
    await expect(section.getByText("Delivery failures and security notices are always sent.")).toBeVisible();
    await noHorizontalScroll(page);
  });

  test("before the migration the defaults are shown read-only; a refused sender is explained", async ({ page, api }) => {
    await signIn(page, ALICE);
    settingsMocks(api);
    api.on("GET", `${M}/me/preferences`, ok(preferences({ available: false, senderOptions: OPTIONS })));
    await gotoWithEntitlements(page, "/dashboard/mail/settings?mailboxId=mb-alice");
    const section = page.getByRole("region", { name: "Preferences" });
    await expect(section.getByText("Preferences are not available yet.")).toBeVisible();
    await expect(section.getByLabel("Default sender")).toBeDisabled();
    await expect(section.getByLabel("Notify me about new email")).toBeDisabled();
    await expect(section.getByLabel("Notify me about new email")).toBeChecked();

    api
      .on("GET", `${M}/me/preferences`, ok(preferences({ senderOptions: OPTIONS })))
      .on("PUT", `${M}/me/preferences`, fail(403, "MAIL_SENDER_NOT_AUTHORIZED", "You are not approved to send as this address."));
    await page.reload();
    await section.getByLabel("Default sender").selectOption("addr-team");
    await expect(section.getByRole("alert")).toHaveText("You are no longer approved to send as that address.");
  });

  test("compose pre-selects the preferred sender of this mailbox", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api
      .on("GET", `${M}/me/preferences`, ok(preferences({ defaultSenderAddressId: "addr-team", senderOptions: OPTIONS })))
      .on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [ALICE_IDENTITY, TEAM], signatureHtml: null }))
      .on("POST", `${M}/mailboxes/mb-alice/drafts`, ok(draft()))
      .on("PATCH", `${M}/drafts/dr-1`, (req) => ok(draft({ ...(req.postDataJSON() as Record<string, unknown>), revision: 2 })));
    await gotoWithEntitlements(page, "/dashboard/mail/compose?mailboxId=mb-alice");
    await expect(page.getByRole("form", { name: "Compose message" })).toBeVisible();
    await expect(page.getByLabel("From")).toHaveValue("addr-team");
  });
});
