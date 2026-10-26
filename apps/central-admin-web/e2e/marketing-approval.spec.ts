import { test, expect, signIn, defaultMocks, entitlements, gotoWithEntitlements, attachScreenshot, ok, ALICE, REVIEWER, type E2EUser, type MockApi } from "./fixtures";

const MK = "/api/mail/v1/marketing";
const ORG = { id: "org-cf", slug: "cosmicforge", name: "CosmicForge" };

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp-1",
    name: "October newsletter",
    status: "READY_FOR_REVIEW",
    topic: "newsletter",
    senderAddressId: "addr-news",
    senderAddress: "news@cosmicforge.example",
    replyTo: null,
    subjectOverride: null,
    templateVersionId: null,
    audienceId: null,
    segmentId: null,
    frequencyCapHours: 72,
    legacyCampaignId: null,
    revision: 3,
    createdByAdminUserId: ALICE.id,
    submittedAt: "2026-10-24T08:00:00Z",
    approvedAt: null,
    approvedByAdminUserId: null,
    createdAt: "2026-10-20T08:00:00Z",
    updatedAt: "2026-10-24T08:00:00Z",
    ...overrides,
  };
}

function marketingMocks(api: MockApi, user: E2EUser, rights: { canAuthor: boolean; canApprove: boolean }) {
  defaultMocks(api, user, entitlements({ mailboxes: [], marketingEnabled: true, marketing: [{ organizationId: ORG.id, slug: ORG.slug, name: ORG.name, ...rights }] }));
  api
    .on("GET", `${MK}/organizations`, ok([{ ...ORG, ...rights }]))
    .on("GET", `${MK}/org-cf/campaigns/cmp-1`, ok(campaign()))
    .on("GET", `${MK}/org-cf/campaigns/cmp-1/history`, ok({ approvals: [], snapshots: [], audit: [] }))
    .on("GET", `${MK}/org-cf/audiences`, ok([], { nextCursor: null }))
    .on("GET", `${MK}/org-cf/templates`, ok([], { nextCursor: null }))
    .on("GET", `${MK}/org-cf/sender-identities`, ok([]))
    .on("GET", `${MK}/org-cf/campaigns/cmp-1/dispatch`, ok({ dispatch: null, campaignStatus: "READY_FOR_REVIEW", dispatchEnabled: false }))
    .on("GET", `${MK}/org-cf/campaigns/cmp-1/recipients`, ok([], { nextCursor: null }))
    .on("GET", `${MK}/org-cf/settings`, ok({ defaultTimeZone: "Africa/Lagos" }));
}

const PAGE = "/dashboard/marketing/email-marketing/campaigns/cmp-1";

test.describe("Marketing campaign approval is reviewer-scoped", () => {
  test("an author without approval rights sees no approve/reject controls", async ({ page, api }) => {
    await signIn(page, ALICE);
    marketingMocks(api, ALICE, { canAuthor: true, canApprove: false });
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByText("Awaiting review by an authorized brand reviewer.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Approve/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reject" })).toHaveCount(0);
  });

  test("a reviewer who authored the campaign cannot approve their own work", async ({ page, api }) => {
    await signIn(page, ALICE);
    marketingMocks(api, ALICE, { canAuthor: true, canApprove: true });
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByText("You authored this campaign; a different reviewer must approve it.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Approve/ })).toHaveCount(0);
  });

  test("a separate reviewer can approve only through a step-up 2FA code", async ({ page, api }, testInfo) => {
    await signIn(page, REVIEWER);
    marketingMocks(api, REVIEWER, { canAuthor: false, canApprove: true });
    api.on("POST", "/api/mail/v1/security/step-up", ok({ stepUpId: "su-1", expiresAt: "2026-10-24T09:05:00Z" }));
    api.on("POST", `${MK}/org-cf/campaigns/cmp-1/approve`, ok(campaign({ status: "APPROVED", approvedByAdminUserId: REVIEWER.id })));
    api.on("POST", `${MK}/org-cf/campaigns/cmp-1/preflight`, ok({ ok: true, checks: [], eligibleCount: 2, excludedCount: 0, contactSetSha256: "a".repeat(64) }));
    await gotoWithEntitlements(page, PAGE);

    await expect(page.getByRole("button", { name: "Reject" })).toBeDisabled(); // needs a reason
    // Approval binds the audience shown in preflight, so it needs a preflight first.
    await expect(page.getByRole("button", { name: "Approve (requires 2FA code)" })).toBeDisabled();
    await page.getByRole("button", { name: "Run preflight" }).click();
    await expect(page.getByText("All checks passed.")).toBeVisible();
    await attachScreenshot(page, testInfo, "marketing-campaign-preflight");
    await page.getByRole("button", { name: "Approve (requires 2FA code)" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm campaign approval" });
    await expect(dialog).toBeVisible();
    expect(api.callsTo("POST", `${MK}/org-cf/campaigns/cmp-1/approve`), "nothing approved before step-up").toHaveLength(0);
    await dialog.getByLabel("Authentication code").fill("123456");
    await dialog.getByRole("button", { name: "Verify" }).click();
    await expect.poll(() => api.callsTo("POST", `${MK}/org-cf/campaigns/cmp-1/approve`).length).toBe(1);
    expect(api.callsTo("POST", "/api/mail/v1/security/step-up")[0].body).toEqual({ code: "123456", purpose: "MARKETING_CAMPAIGN_APPROVAL" });
    expect(api.callsTo("POST", `${MK}/org-cf/campaigns/cmp-1/approve`)[0].body).toMatchObject({ revision: 3, stepUpId: "su-1", contactSetSha256: "a".repeat(64), eligibleCount: 2 });
    await expect(page.getByText("Dispatch is not enabled in this environment", { exact: false }).first()).toBeVisible();
  });
});
