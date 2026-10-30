import { test, expect, signIn, defaultMocks, entitlements, gotoWithEntitlements, ok, fail, noHorizontalScroll, ALICE, REVIEWER, SUPER_USER, type E2EUser, type MockApi } from "./fixtures";

// Final gaps 2/3: provider re-subscription queue, estimated campaign spend and
// provider quota, approved pricing. API fully mocked; nothing leaves the browser.

const MK = "/api/mail/v1/marketing";
const ADM = "/api/mail/v1/admin";
const ORG = { id: "org-cf", slug: "cosmicforge", name: "CosmicForge" };

function resubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "rs-1", organizationId: ORG.id, contactId: "ct-1", email: "ann@reader.example", topic: "newsletter", status: "PENDING_APPROVAL",
    evidence: { consentId: "cs-1", topic: "newsletter", source: "WEB_FORM", policyVersion: "2026-10", consentedAt: "2026-10-25T08:00:00Z", confirmedAt: "2026-10-25T08:05:00Z", doubleOptIn: true, providerState: { state: "UNSUBSCRIBED", reason: "USER_UNSUBSCRIBE", observedAt: "2026-10-01T08:00:00Z" } },
    requestedBy: null, approvedBy: null, attempts: 0, nextAttemptAt: null, lastError: null, providerResult: null, completedAt: null, createdAt: "2026-10-25T08:05:00Z", updatedAt: "2026-10-25T08:05:00Z",
    providerState: { state: "UNSUBSCRIBED", reason: "USER_UNSUBSCRIBE", provider: "resend", observedAt: "2026-10-01T08:00:00Z" }, operatorMessage: null, flags: { providerResubscribeEnabled: false },
    ...overrides,
  };
}

function marketingMocks(api: MockApi, user: E2EUser, rights: { canAuthor: boolean; canApprove: boolean }) {
  defaultMocks(api, user, entitlements({ mailboxes: [], marketingEnabled: true, marketing: [{ organizationId: ORG.id, slug: ORG.slug, name: ORG.name, ...rights }] }));
  api
    .on("GET", `${MK}/organizations`, ok([{ ...ORG, ...rights }]))
    .on("GET", `${MK}/org-cf/contacts`, ok([{ id: "ct-1", email: "ann@reader.example", firstName: "Ann", lastName: null, status: "UNSUBSCRIBED", source: "web_form", consents: [{ id: "cs-1", topic: "newsletter", status: "GRANTED", source: "WEB_FORM", policyVersion: "2026-10", doubleOptIn: true }], createdAt: "2026-10-01T08:00:00Z" }], { nextCursor: null }))
    .on("GET", `${MK}/org-cf/provider-states`, ok({ items: [{ contactId: "ct-1", state: "UNSUBSCRIBED", reason: "USER_UNSUBSCRIBE", provider: "resend", observedAt: "2026-10-01T08:00:00Z" }] }))
    .on("GET", `${MK}/org-cf/audiences`, ok([], { nextCursor: null }))
    .on("GET", `${MK}/org-cf/suppressions`, ok([], { nextCursor: null }));
}

test.describe("Final gap 2: provider re-subscription", () => {
  test("contacts show the provider state; an approver approves a request with a step-up and sees UNSUPPORTED guidance", async ({ page, api }) => {
    await signIn(page, REVIEWER);
    marketingMocks(api, REVIEWER, { canAuthor: false, canApprove: true });
    let approved = false;
    api.on("GET", `${MK}/org-cf/resubscriptions`, () => ok({ items: [approved ? resubscription({ status: "UNSUPPORTED", approvedBy: REVIEWER.id, lastError: "PROVIDER_RESUBSCRIBE_NOT_ENABLED", operatorMessage: "Automatic provider re-subscription is not enabled" }) : resubscription()], flags: { providerResubscribeEnabled: false } }));
    api.on("POST", "/api/mail/v1/security/step-up", ok({ stepUpId: "su-rs", expiresAt: "2026-10-25T09:05:00Z" }));
    api.on("POST", `${MK}/org-cf/resubscriptions/rs-1/approve`, () => {
      approved = true;
      return ok(resubscription({ status: "UNSUPPORTED", approvedBy: REVIEWER.id }));
    });
    await gotoWithEntitlements(page, "/dashboard/marketing/email-marketing/contacts");
    await expect(page.getByRole("columnheader", { name: "Provider" })).toBeVisible();
    await page.getByRole("tab", { name: "Re-subscriptions" }).click();
    const panel = page.getByTestId("resubscriptions-panel");
    await expect(panel.getByText("ann@reader.example")).toBeVisible();
    await expect(panel.getByText("Automatic provider re-subscription is turned off", { exact: false })).toBeVisible();
    await panel.getByRole("button", { name: "Approve" }).click();
    expect(api.callsTo("POST", `${MK}/org-cf/resubscriptions/rs-1/approve`), "nothing approved before the step-up").toHaveLength(0);
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Authentication code").fill("123456");
    await dialog.getByRole("button", { name: "Verify" }).click();
    await expect.poll(() => api.callsTo("POST", `${MK}/org-cf/resubscriptions/rs-1/approve`).length).toBe(1);
    expect(api.callsTo("POST", "/api/mail/v1/security/step-up")[0].body).toEqual({ code: "123456", purpose: "MARKETING_RESUBSCRIBE_APPROVE" });
    expect(api.callsTo("POST", `${MK}/org-cf/resubscriptions/rs-1/approve`)[0].body).toEqual({ stepUpId: "su-rs" });
    await expect(panel.getByRole("button", { name: "Confirm manually" })).toBeVisible();
    await noHorizontalScroll(page);
  });

  test("authors see the queue read-only; before the database update the panel says so", async ({ page, api }) => {
    await signIn(page, ALICE);
    marketingMocks(api, ALICE, { canAuthor: true, canApprove: false });
    api.on("GET", `${MK}/org-cf/provider-states`, fail(503, "MAIL_FEATURE_NOT_READY", "This Mail feature is not available yet."));
    api.on("GET", `${MK}/org-cf/resubscriptions`, fail(503, "MAIL_FEATURE_NOT_READY", "This Mail feature is not available yet."));
    await gotoWithEntitlements(page, "/dashboard/marketing/email-marketing/contacts");
    await expect(page.getByText("ann@reader.example")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Provider" })).toHaveCount(0);
    await page.getByRole("tab", { name: "Re-subscriptions" }).click();
    await expect(page.getByText("available after the latest Mail database update", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  });
});

test.describe("Final gap 3: spend estimates and provider quota", () => {
  test("campaign report labels spend as an estimate, never billed, and flags events still arriving", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE, entitlements({ mailboxes: [], marketingEnabled: true, marketing: [{ organizationId: ORG.id, slug: ORG.slug, name: ORG.name, canAuthor: true, canApprove: false }] }));
    const dispatch = { id: "dsp-1", campaignId: "cmp-1", status: "COMPLETED", scheduledFor: "2026-11-02T08:00:00.000Z", timeZone: "Africa/Lagos", provider: "resend", providerStatus: "SENT", providerHandoffAt: "2026-11-02T08:00:05Z", recipientCount: 2, excludedCount: 0, cancelRequestedAt: null, pausedAt: null, lastErrorCode: null, completedAt: "2026-11-02T08:10:00Z" };
    api
      .on("GET", `${MK}/organizations`, ok([{ ...ORG, canAuthor: true, canApprove: false }]))
      .on("GET", `${MK}/org-cf/campaigns/cmp-1`, ok({ id: "cmp-1", name: "November newsletter", status: "COMPLETE", topic: "newsletter", senderAddressId: "addr-news", replyTo: null, subjectOverride: null, templateVersionId: null, audienceId: null, segmentId: null, frequencyCapHours: 72, legacyCampaignId: null, revision: 2, createdByAdminUserId: ALICE.id, createdAt: "2026-10-20T08:00:00Z", updatedAt: "2026-10-24T09:00:00Z", dispatchEnabled: true }))
      .on("GET", `${MK}/org-cf/campaigns/cmp-1/history`, ok({ approvals: [], snapshots: [], audit: [] }))
      .on("GET", `${MK}/org-cf/audiences`, ok([], { nextCursor: null }))
      .on("GET", `${MK}/org-cf/templates`, ok([], { nextCursor: null }))
      .on("GET", `${MK}/org-cf/sender-identities`, ok([]))
      .on("GET", `${MK}/org-cf/settings`, ok({ organizationId: ORG.id, defaultTimeZone: "Africa/Lagos", dispatchPaused: false, provider: { configured: true, credentialSource: "brand" }, flags: { broadcastDispatchEnabled: true, automationEnabled: false, confirmationEmailsEnabled: false, emergencyStop: false } }))
      .on("GET", `${MK}/org-cf/campaigns/cmp-1/dispatch`, ok({ dispatch, campaignStatus: "COMPLETE", dispatchEnabled: true, counts: {} }))
      .on("GET", `${MK}/org-cf/campaigns/cmp-1/recipients`, ok([], { nextCursor: null }))
      .on("GET", `${MK}/org-cf/campaigns/cmp-1/report`, ok({
        dispatch, counts: { PROVIDER_ACCEPTED: 0, DELIVERED: 2 }, totals: { handedToProvider: 2, delivered: 2, awaitingDeliveryEvidence: 0, outcomeUnknown: 0, excluded: 0 },
        rates: { deliveredPercent: 100, bouncePercent: 0, complaintPercent: 0, openPercentIndicative: 0, clickPercentIndicative: 0 }, engagement: { opened: 0, clicked: 0, note: "" }, exclusions: [], timeline: [],
        denominators: { reportWindowEnd: "2026-11-02T10:00:00Z", eventsStillArriving: true, eventsSettleUntil: "2026-11-05T08:10:00Z", eventsSettleHours: 72 },
        spend: { status: "ESTIMATED", amount: "0.001800", currency: "USD", basis: "ACCEPTED_RECIPIENTS", basisCount: 2, pricingSource: "CONTRACT", pricingReference: "Resend Pro order form", pricingEffectiveFrom: "2026-01-01T00:00:00Z", unitCost: "0.000900", computedAt: "2026-11-02T08:10:00Z", label: "estimated (not billed)", reason: null, includedAllowanceNote: null, billed: null, billedStatus: "UNAVAILABLE", billedReason: "The provider exposes no billing or spend API; actual billed spend is not available." },
        providerQuota: { scope: "brand:cosmicforge", provider: "resend", status: "OBSERVED", dailyUsed: null, monthlyUsed: 412, dailyLimit: null, monthlyLimit: null, remaining: { daily: null, monthly: null }, remainingStatus: "UNKNOWN", observedAt: "2026-11-02T08:00:05Z", source: "RESPONSE_HEADER", exhausted: false },
      }));
    await gotoWithEntitlements(page, "/dashboard/marketing/email-marketing/campaigns/cmp-1");
    const spend = page.getByTestId("campaign-spend");
    await expect(spend.getByText("USD 0.001800")).toBeVisible();
    await expect(spend.getByText("(estimated (not billed))")).toBeVisible();
    await expect(page.getByText("Billed spend: not available.", { exact: false })).toBeVisible();
    await expect(page.getByTestId("events-still-arriving")).toBeVisible();
    await expect(page.getByTestId("campaign-quota")).toContainText("this month 412 (limit unknown)");
  });

  test("mail admins see provider quota and add pricing only with a step-up; validation errors are shown", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    api
      .on("GET", `${ADM}/ops/snapshot`, ok({ generatedAt: "2026-10-25T09:00:00Z", runtimeHalt: { staffMail: null, marketing: null }, queue: { byStatus: [], oldestDueSeconds: {}, active: 0, deadLetters24h: [] }, webhooks: { backlog: 0, oldestBacklogSeconds: 0, failed24h: 0 }, scanning: { backlog: 0, oldestBacklogSeconds: 0 }, delivery: { staff24h: {}, outcomeUnknown24h: 0 }, retention: {}, openAlerts: [] }))
      .on("GET", `${ADM}/ops/alerts`, ok([]))
      .on("GET", `${ADM}/usage`, ok({ days: 30, since: "2026-09-26T00:00:00Z", summary: [], limits: [], cost: { currency: null, source: null, note: "No prices configured." } }))
      .on("GET", `${ADM}/retention/capabilities`, ok({ executionEnabled: false, dryRunValidHours: 24, systemCategories: [] }))
      .on("GET", `${ADM}/retention-policies`, ok([]))
      .on("GET", `${ADM}/retention/runs`, ok([]))
      .on("GET", `${ADM}/provider-quota`, ok({ generatedAt: "2026-10-25T09:00:00Z", billing: { status: "UNAVAILABLE", reason: "Resend has no billing or spend API." }, items: [
        { scope: "account", provider: "resend", status: "OBSERVED", dailyUsed: 40, monthlyUsed: 900, dailyLimit: 100, monthlyLimit: 3000, remaining: { daily: 60, monthly: 2100 }, remainingStatus: "KNOWN", observedAt: "2026-10-25T08:59:00Z", source: "RESPONSE_HEADER", exhausted: false },
        { scope: "brand:karryam", provider: "resend", status: "UNKNOWN", dailyUsed: null, monthlyUsed: null, dailyLimit: null, monthlyLimit: null, remaining: { daily: null, monthly: null }, remainingStatus: "UNKNOWN", observedAt: null, source: null, exhausted: true, exhaustedKind: "DAILY", exhaustedUntil: "2026-10-26T00:00:00Z" },
      ] }))
      .on("GET", `${ADM}/pricing`, ok({ items: [], label: "estimated (not billed)" }))
      .on("POST", "/api/mail/v1/security/step-up", ok({ stepUpId: "su-price", expiresAt: "2026-10-25T09:05:00Z" }));
    let attempts = 0;
    api.on("POST", `${ADM}/pricing`, () => {
      attempts += 1;
      return attempts === 1
        ? fail(422, "MAIL_VALIDATION_FAILED", "Check the request and try again.", [{ code: "MAIL_VALIDATION_FAILED", field: "effectiveFrom", reason: "PRICING_PERIOD_OVERLAP" }])
        : { status: 201, body: { success: true, data: { id: "pr-1" } } };
    });
    await gotoWithEntitlements(page, "/dashboard/mail/operations");
    const quota = page.getByTestId("provider-quota-panel");
    await expect(quota.getByText("Company account")).toBeVisible();
    await expect(quota.getByText("60 today · 2100 this month")).toBeVisible();
    await expect(quota.getByText("Quota exhausted (daily)", { exact: false })).toBeVisible();
    await expect(quota.getByRole("cell", { name: "Unknown", exact: true })).toBeVisible();
    const pricing = page.getByTestId("provider-pricing-panel");
    await expect(pricing.getByText("No pricing yet", { exact: false })).toBeVisible();
    await pricing.getByLabel("Price per email").fill("0.0009");
    await pricing.getByLabel("Effective from").fill("2026-11-01T00:00");
    await pricing.getByLabel("Reference").fill("Resend Pro order form");
    await pricing.getByRole("button", { name: "Save pricing" }).click();
    expect(api.callsTo("POST", `${ADM}/pricing`), "nothing saved before the step-up").toHaveLength(0);
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Authentication code").fill("123456");
    await dialog.getByRole("button", { name: "Verify" }).click();
    await expect(pricing.getByText("effectiveFrom: pricing period overlap", { exact: false })).toBeVisible();
    await pricing.getByRole("button", { name: "Save pricing" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Authentication code").fill("654321");
    await dialog.getByRole("button", { name: "Verify" }).click();
    await expect(pricing.getByText("Pricing saved. Existing estimates are not changed.")).toBeVisible();
    const body = api.callsTo("POST", `${ADM}/pricing`)[1].body as Record<string, unknown>;
    expect(body).toMatchObject({ provider: "resend", currency: "USD", unitCost: "0.0009", source: "CONTRACT", reference: "Resend Pro order form", stepUpId: "su-price" });
    expect(api.callsTo("POST", "/api/mail/v1/security/step-up")[0].body).toEqual({ code: "123456", purpose: "MAIL_PRICING_CHANGE" });
  });
});
