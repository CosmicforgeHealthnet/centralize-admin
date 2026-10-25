import { test, expect, signIn, defaultMocks, entitlements, gotoWithEntitlements, ok, noHorizontalScroll, ALICE, REVIEWER, type E2EUser, type MockApi } from "./fixtures";

// M7: broadcast scheduling, cancellation, reporting, brand pause and
// automation publishing. API fully mocked; nothing leaves the browser.

const MK = "/api/mail/v1/marketing";
const ORG = { id: "org-cf", slug: "cosmicforge", name: "CosmicForge" };
const PAGE = "/dashboard/marketing/email-marketing/campaigns/cmp-1";

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp-1", name: "November newsletter", status: "APPROVED", topic: "newsletter", senderAddressId: "addr-news", replyTo: null, subjectOverride: null,
    templateVersionId: null, audienceId: null, segmentId: null, frequencyCapHours: 72, legacyCampaignId: null, revision: 2,
    createdByAdminUserId: ALICE.id, submittedAt: "2026-10-24T08:00:00Z", approvedAt: "2026-10-24T09:00:00Z", approvedByAdminUserId: REVIEWER.id,
    createdAt: "2026-10-20T08:00:00Z", updatedAt: "2026-10-24T09:00:00Z", dispatchEnabled: true, ...overrides,
  };
}

function dispatch(overrides: Record<string, unknown> = {}) {
  return {
    id: "dsp-1", campaignId: "cmp-1", status: "SCHEDULED", scheduledFor: "2026-11-02T08:00:00.000Z", timeZone: "Africa/Lagos", localSendTime: "2026-11-02T09:00",
    provider: "resend", providerStatus: null, providerHandoffAt: null, recipientCount: 0, excludedCount: 0, cancelRequestedAt: null, pausedAt: null, lastErrorCode: null, completedAt: null, ...overrides,
  };
}

const settings = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG.id, confirmationSenderAddressId: null, defaultTimeZone: "Africa/Lagos", postalAddress: "CosmicForge Ltd, Lagos", dailyBroadcastCap: 1000, dailyAutomationCap: 500,
  maxBroadcastRecipients: 1000, hardMaxBroadcastRecipients: 1000, dispatchPaused: false, pausedReason: null, pausedAt: null,
  provider: { configured: true, credentialSource: "brand", credentialEnvName: "RESEND_MARKETING_API_KEY__COSMICFORGE" },
  flags: { broadcastDispatchEnabled: true, automationEnabled: true, confirmationEmailsEnabled: false, emergencyStop: false }, ...overrides,
});

function mocks(api: MockApi, user: E2EUser, rights: { canAuthor: boolean; canApprove: boolean }) {
  defaultMocks(api, user, entitlements({ mailboxes: [], marketingEnabled: true, marketing: [{ organizationId: ORG.id, slug: ORG.slug, name: ORG.name, ...rights }] }));
  api
    .on("GET", `${MK}/organizations`, ok([{ ...ORG, ...rights }]))
    .on("GET", `${MK}/org-cf/campaigns/cmp-1`, ok(campaign()))
    .on("GET", `${MK}/org-cf/campaigns/cmp-1/history`, ok({ approvals: [], snapshots: [], audit: [] }))
    .on("GET", `${MK}/org-cf/audiences`, ok([], { nextCursor: null }))
    .on("GET", `${MK}/org-cf/templates`, ok([], { nextCursor: null }))
    .on("GET", `${MK}/org-cf/sender-identities`, ok([{ addressId: "addr-news", address: "news@cosmicforge.example", kind: "SHARED", domainVerifiedForSending: true }]))
    .on("GET", `${MK}/org-cf/settings`, ok(settings()))
    .on("GET", `${MK}/org-cf/campaigns/cmp-1/dispatch`, ok({ dispatch: null, campaignStatus: "APPROVED", dispatchEnabled: true }))
    .on("GET", `${MK}/org-cf/campaigns/cmp-1/recipients`, ok([], { nextCursor: null }));
}

test.describe("M7 broadcasts", () => {
  test("an author schedules an approved campaign in the brand time zone", async ({ page, api }) => {
    await signIn(page, ALICE);
    mocks(api, ALICE, { canAuthor: true, canApprove: false });
    let scheduled = false;
    api.on("POST", `${MK}/org-cf/campaigns/cmp-1/schedule`, () => {
      scheduled = true;
      return { status: 201, body: { success: true, data: dispatch() } };
    });
    api.on("GET", `${MK}/org-cf/campaigns/cmp-1/dispatch`, () => ok(scheduled ? { dispatch: dispatch(), campaignStatus: "SCHEDULED", dispatchEnabled: true, counts: {} } : { dispatch: null, campaignStatus: "APPROVED", dispatchEnabled: true }));
    await gotoWithEntitlements(page, PAGE);
    await page.getByLabel("Send date").fill("2026-11-02");
    await page.getByLabel("Local time").fill("09:00");
    await expect(page.getByLabel("Time zone")).toHaveValue("Africa/Lagos");
    await page.getByRole("button", { name: "Schedule broadcast" }).click();
    await expect.poll(() => api.callsTo("POST", `${MK}/org-cf/campaigns/cmp-1/schedule`).length).toBe(1);
    expect(api.callsTo("POST", `${MK}/org-cf/campaigns/cmp-1/schedule`)[0].body).toEqual({ revision: 2, sendAt: "2026-11-02T09:00", timeZone: "Africa/Lagos" });
    await expect(page.getByText("Waiting for its send time. Nothing has been sent.")).toBeVisible();
  });

  test("cancelling while the provider sends warns that sent mail cannot be recalled", async ({ page, api }) => {
    await signIn(page, ALICE);
    mocks(api, ALICE, { canAuthor: true, canApprove: false });
    api.on("GET", `${MK}/org-cf/campaigns/cmp-1`, ok(campaign({ status: "SENDING" })));
    api.on("GET", `${MK}/org-cf/campaigns/cmp-1/dispatch`, ok({ dispatch: dispatch({ status: "SENDING", providerStatus: "QUEUED", providerHandoffAt: "2026-11-02T08:00:05Z", recipientCount: 2 }), campaignStatus: "SENDING", dispatchEnabled: true, counts: {} }));
    api.on("GET", `${MK}/org-cf/campaigns/cmp-1/report`, ok({
      dispatch: dispatch({ status: "SENDING" }), counts: { PROVIDER_ACCEPTED: 1, DELIVERED: 1, BOUNCED: 0, COMPLAINED: 0 },
      totals: { handedToProvider: 2, delivered: 1, awaitingDeliveryEvidence: 1, outcomeUnknown: 0, excluded: 1 },
      rates: { deliveredPercent: 50, bouncePercent: 0, complaintPercent: 0, openPercentIndicative: 50, clickPercentIndicative: 0 },
      engagement: { opened: 1, clicked: 0, note: "" }, exclusions: [{ reason: "FREQUENCY_CAP", count: 1 }], timeline: [],
    }));
    api.on("POST", `${MK}/org-cf/campaigns/cmp-1/cancel`, ok(dispatch({ status: "SENDING", cancelRequestedAt: "2026-11-02T08:01:00Z", note: "Emails already handed to the provider cannot be recalled; only unsent mail is stopped." })));
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByText("1 recipient(s) have no delivery evidence yet", { exact: false })).toBeVisible();
    await expect(page.getByText("(indicative only)", { exact: false })).toBeVisible();
    await expect(page.getByText("frequency cap 1", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Cancel broadcast" }).click();
    await expect(page.getByText("Emails already sent cannot be recalled", { exact: false })).toBeVisible();
    expect(api.callsTo("POST", `${MK}/org-cf/campaigns/cmp-1/cancel`), "nothing cancelled before confirming").toHaveLength(0);
    await page.getByRole("button", { name: "Confirm cancel" }).click();
    await expect.poll(() => api.callsTo("POST", `${MK}/org-cf/campaigns/cmp-1/cancel`).length).toBe(1);
  });

  test("unknown provider outcomes are never shown as delivered", async ({ page, api }) => {
    await signIn(page, ALICE);
    mocks(api, ALICE, { canAuthor: true, canApprove: false });
    api.on("GET", `${MK}/org-cf/campaigns/cmp-1/dispatch`, ok({ dispatch: dispatch({ status: "OUTCOME_UNKNOWN", lastErrorCode: "SEND_STATUS_UNKNOWN" }), campaignStatus: "OUTCOME_UNKNOWN", dispatchEnabled: true, counts: {} }));
    api.on("GET", `${MK}/org-cf/campaigns/cmp-1/report`, ok({ dispatch: dispatch({ status: "OUTCOME_UNKNOWN" }), counts: { OUTCOME_UNKNOWN: 3 }, totals: { handedToProvider: 0, delivered: 0, awaitingDeliveryEvidence: 0, outcomeUnknown: 3, excluded: 0 }, rates: { deliveredPercent: null, bouncePercent: null, complaintPercent: null, openPercentIndicative: null, clickPercentIndicative: null }, engagement: { opened: 0, clicked: 0, note: "" }, exclusions: [], timeline: [] }));
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByText("Do not resend without review", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel broadcast" })).toHaveCount(0);
  });

  test("resuming a paused brand needs a reviewer and a 2FA step-up", async ({ page, api }) => {
    await signIn(page, REVIEWER);
    mocks(api, REVIEWER, { canAuthor: false, canApprove: true });
    api.on("GET", `${MK}/org-cf/settings`, ok(settings({ dispatchPaused: true, pausedReason: "deliverability review" })));
    api.on("POST", "/api/mail/v1/security/step-up", ok({ stepUpId: "su-9", expiresAt: "2026-11-02T08:05:00Z" }));
    api.on("POST", `${MK}/org-cf/dispatch/resume`, ok(settings()));
    await gotoWithEntitlements(page, "/dashboard/marketing/email-marketing/settings");
    await expect(page.getByText("deliverability review", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Resume dispatch (requires 2FA code)" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm resuming brand dispatch" });
    await dialog.getByLabel("Authentication code").fill("654321");
    await dialog.getByRole("button", { name: "Verify" }).click();
    await expect.poll(() => api.callsTo("POST", `${MK}/org-cf/dispatch/resume`).length).toBe(1);
    expect(api.callsTo("POST", "/api/mail/v1/security/step-up")[0].body).toEqual({ code: "654321", purpose: "MARKETING_BROADCAST_OVERRIDE" });
    expect(api.callsTo("POST", `${MK}/org-cf/dispatch/resume`)[0].body).toEqual({ stepUpId: "su-9" });
  });

  test("authors see that only reviewers can resume a paused brand", async ({ page, api }) => {
    await signIn(page, ALICE);
    mocks(api, ALICE, { canAuthor: true, canApprove: false });
    api.on("GET", `${MK}/org-cf/settings`, ok(settings({ dispatchPaused: true, pausedReason: "incident" })));
    await gotoWithEntitlements(page, "/dashboard/marketing/email-marketing/settings");
    await expect(page.getByText("A brand reviewer must resume dispatch.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Resume dispatch/ })).toHaveCount(0);
    await expect(page.getByLabel("Postal address (required in every marketing email)")).toBeDisabled();
  });
});

test.describe("Campaign test sends", () => {
  test("an author sends a [TEST] copy to staff; refusals are explained", async ({ page, api }) => {
    await signIn(page, ALICE);
    mocks(api, ALICE, { canAuthor: true, canApprove: false });
    api.on("GET", `${MK}/org-cf/campaigns/cmp-1`, ok(campaign({ status: "DRAFT", templateVersionId: "tv-1", revision: 1 })));
    let attempt = 0;
    api.on("POST", `${MK}/org-cf/campaigns/cmp-1/test-send`, () => {
      attempt += 1;
      return attempt === 1
        ? { status: 400, body: { success: false, code: "MAIL_VALIDATION_FAILED", message: "Check your details.", errors: [{ field: "recipients", reason: "TEST_RECIPIENT_NOT_STAFF" }] } }
        : { status: 202, body: { success: true, data: { queued: true, duplicate: false, recipientCount: 1 } } };
    });
    await gotoWithEntitlements(page, PAGE);
    await page.getByLabel("Staff recipients (optional, comma-separated)").fill("customer@gmail.example");
    await page.getByRole("button", { name: "Send test" }).click();
    await expect(page.getByText("Test sends go to active staff addresses only")).toBeVisible();
    await page.getByLabel("Staff recipients (optional, comma-separated)").fill("");
    await page.getByRole("button", { name: "Send test" }).click();
    await expect(page.getByText("Test send queued for 1 staff address.")).toBeVisible();
    const calls = api.callsTo("POST", `${MK}/org-cf/campaigns/cmp-1/test-send`);
    expect(calls[0].body).toEqual({ recipients: ["customer@gmail.example"] });
    expect(calls[1].body).toEqual({});
  });

  test("approvers without author rights see no test-send control", async ({ page, api }) => {
    await signIn(page, REVIEWER);
    mocks(api, REVIEWER, { canAuthor: false, canApprove: true });
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByRole("heading", { name: "Preflight" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send test" })).toHaveCount(0);
  });
});

test.describe("M7 automation", () => {
  const automation = (overrides: Record<string, unknown> = {}) => ({
    id: "au-1", name: "Welcome", description: null, status: "DRAFT", triggerType: "CONSENT_GRANTED", activeVersionId: null, enrollmentLimit: 1, maxActiveEnrollments: 5000,
    frequencyCapHours: 24, executionEnabled: true, createdBy: ALICE.id, updatedAt: "2026-10-24T09:00:00Z", enrollments: {},
    versions: [{ id: "v-1", version: 1, status: "PENDING_REVIEW", definition: { topic: "newsletter", steps: [{ id: "s1", type: "send_email", templateVersionId: "tv-1", senderAddressId: "addr-news", next: null }] }, triggerConfig: { topic: "newsletter" }, definitionSha256: "a".repeat(64), createdBy: ALICE.id, submittedBy: ALICE.id, reviewedBy: null, reviewComment: null, publishedAt: null, createdAt: "2026-10-24T09:00:00Z" }],
    ...overrides,
  });
  const automationMocks = (api: MockApi, user: E2EUser, rights: { canAuthor: boolean; canApprove: boolean }) => {
    mocks(api, user, rights);
    api
      .on("GET", `${MK}/org-cf/automations`, ok([automation()]))
      .on("GET", `${MK}/org-cf/automations/au-1`, ok(automation()))
      .on("GET", `${MK}/org-cf/automations/au-1/enrollments`, ok([], { nextCursor: null }))
      .on("GET", `${MK}/org-cf/automation-events`, ok([{ eventType: "karryam.booking.completed", versions: [1], product: "karryam", fields: ["service"] }]));
  };

  test("a reviewer publishes the exact reviewed version with a 2FA step-up", async ({ page, api }) => {
    await signIn(page, REVIEWER);
    automationMocks(api, REVIEWER, { canAuthor: false, canApprove: true });
    api.on("POST", "/api/mail/v1/security/step-up", ok({ stepUpId: "su-7", expiresAt: "2026-11-02T08:05:00Z" }));
    api.on("POST", `${MK}/org-cf/automations/au-1/versions/v-1/approve`, ok(automation({ activeVersionId: "v-1" })));
    await gotoWithEntitlements(page, "/dashboard/marketing/email-marketing/automation");
    await page.getByRole("button", { name: /Welcome/ }).click();
    await page.getByRole("button", { name: "Publish (requires 2FA code)" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm publishing this automation" });
    await dialog.getByLabel("Authentication code").fill("111222");
    await dialog.getByRole("button", { name: "Verify" }).click();
    await expect.poll(() => api.callsTo("POST", `${MK}/org-cf/automations/au-1/versions/v-1/approve`).length).toBe(1);
    expect(api.callsTo("POST", "/api/mail/v1/security/step-up")[0].body).toEqual({ code: "111222", purpose: "MARKETING_AUTOMATION_PUBLISH" });
    expect(api.callsTo("POST", `${MK}/org-cf/automations/au-1/versions/v-1/approve`)[0].body).toEqual({ stepUpId: "su-7", definitionSha256: "a".repeat(64) });
  });

  test("the author of a version cannot publish it", async ({ page, api }) => {
    await signIn(page, ALICE);
    automationMocks(api, ALICE, { canAuthor: true, canApprove: true });
    await gotoWithEntitlements(page, "/dashboard/marketing/email-marketing/automation");
    await page.getByRole("button", { name: /Welcome/ }).click();
    await expect(page.getByText("You authored this version; a different reviewer must approve it.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Publish/ })).toHaveCount(0);
  });

  test("the broadcast panel fits a phone screen", async ({ page, api, isMobile }) => {
    test.skip(!isMobile, "mobile project only");
    await signIn(page, ALICE);
    mocks(api, ALICE, { canAuthor: true, canApprove: false });
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByRole("button", { name: "Send as soon as allowed" })).toBeVisible();
    await noHorizontalScroll(page);
  });
});
