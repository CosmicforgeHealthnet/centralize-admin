import { test, expect, signIn, defaultMocks, entitlements, gotoWithEntitlements, ok, fail, REVIEWER, type E2EUser, type MockApi } from "./fixtures";

// Final gap 4: automation test mode (read-only) and replay / recovery with a
// dry run, explicit acknowledgement for unknown outcomes and MFA step-up.

const MK = "/api/mail/v1/marketing";
const ORG = { id: "org-cf", slug: "cosmicforge", name: "CosmicForge" };
const AUTO = "au-1";
const VERSION = {
  id: "ver-1", version: 1, status: "PUBLISHED", definitionSha256: "a".repeat(64), createdBy: "someone-else", submittedBy: null, reviewedBy: null, reviewComment: null, publishedAt: "2026-10-20T08:00:00Z", createdAt: "2026-10-20T08:00:00Z",
  triggerConfig: { eventType: "karryam.booking.completed", version: 1 },
  definition: { topic: "newsletter", entryStepId: "welcome", steps: [
    { id: "welcome", type: "send_email", templateVersionId: "tv-1", senderAddressId: "addr-news", next: "wait" },
    { id: "wait", type: "delay", minutes: 0, until: { localTime: "02:30", timezone: "recipient" }, next: null },
  ] },
};
const AUTOMATION = { id: AUTO, organizationId: ORG.id, name: "Booking thanks", description: null, status: "ACTIVE", triggerType: "PRODUCT_EVENT", activeVersionId: "ver-1", enrollmentLimit: 1, maxActiveEnrollments: 5000, frequencyCapHours: 24, executionEnabled: true, createdBy: "someone-else", updatedAt: "2026-10-20T08:00:00Z", versions: [VERSION], enrollments: { FAILED: 1 } };

const TEST_RESULT = {
  mode: "TEST", sideEffects: "NONE", simulatedNow: "2026-03-07T12:00:00.000Z",
  automation: { id: AUTO, name: "Booking thanks", status: "ACTIVE", triggerType: "PRODUCT_EVENT" },
  version: { id: "ver-1", version: 1, status: "PUBLISHED", definitionSha256: "a".repeat(64) },
  validation: { ok: true, errors: [] },
  contact: { kind: "SYNTHETIC", id: null, email: "test.reader@example.com", timeZone: "America/New_York", timeZoneSource: "RECIPIENT", timeZoneFallback: false, storedTimeZone: "America/New_York", brandDefaultTimeZone: "Africa/Lagos" },
  trigger: { type: "PRODUCT_EVENT", matches: true, reason: null, simulatedEvent: { droppedFields: ["cardNumber"] } },
  eligibility: { automationStatus: "ACTIVE", executionEnabled: true, contactStatus: "ACTIVE", consent: { topic: "newsletter", status: "GRANTED", ok: true, simulated: true }, suppression: { suppressed: false, reason: null, scope: null }, frequencyCap: { hours: 24, lastMarketingSendAt: null }, enrollmentCap: { limit: 1, priorEnrollments: 0, ok: true }, maxActiveEnrollments: { limit: 5000, active: 0, ok: true }, wouldEnroll: true, enrollmentBlockers: [], sendBlockers: [] },
  path: [
    { sequence: 0, stepId: "welcome", type: "send_email", at: "2026-03-07T12:00:00.000Z", localAt: "2026-03-07T07:00:00-05:00", action: "WOULD_SEND", holds: [], sendAt: "2026-03-07T12:00:00.000Z", localSendAt: "2026-03-07T07:00:00-05:00", template: { versionId: "tv-1", version: 1, templateName: "Thanks", classification: "MARKETING", classificationAvailable: true }, personalization: { subject: "Thanks Test", text: "Hello", variables: ["first_name"], missingVariables: [] } },
    { sequence: 1, stepId: "wait", type: "delay", at: "2026-03-07T12:00:00.000Z", localAt: "2026-03-07T07:00:00-05:00", minutes: 0, runAt: "2026-03-08T07:30:00.000Z", localRunAt: "2026-03-08T03:30:00-04:00", timeZone: "America/New_York", timeZoneSource: "RECIPIENT", timeZoneFallback: false, ambiguous: false, shiftedMinutes: 60, windowDeferred: false },
  ],
  expected: { outcome: "COMPLETED", reason: null, sends: 1, wouldEnroll: true, summary: "Would enroll and run 2 step(s) with 1 email(s), ending completed." },
};

const RECOVERY = {
  failedStepRuns: { items: [{ id: "run-1", enrollmentId: "enr-1", stepId: "welcome", stepType: "send_email", sequence: 0, status: "OUTCOME_UNKNOWN", errorCode: "PROVIDER_IDEMPOTENCY_CONFLICT", providerMessageId: null, firstAttemptAt: "2026-10-26T08:00:00Z", updatedAt: "2026-10-26T08:00:00Z", recipientEmail: "ada@reader.example" }], more: false },
  interruptedStepRuns: { items: [], more: false },
  failedEnrollments: { items: [], more: false },
  stalledEnrollments: { items: [], more: false },
  deadLetterJobs: { items: [], more: false },
  idempotencyWindowHours: 23,
};
const PLAN = { scope: "STEP_RUN", action: "RETRY_UNKNOWN_SEND", enrollmentId: "enr-1", versionId: "ver-1", version: 1, stepId: "welcome", stepRunId: "run-1", outboxJobId: null, idempotency: { key: "auto:enr-1:0", reused: true, firstAttemptAt: "2026-10-26T08:00:00Z", providerDeduplicatesUntil: "2026-10-27T07:00:00Z" }, requiresAcknowledgement: true, checks: { contactStatus: "ACTIVE", consent: { status: "GRANTED", ok: true }, suppressed: false, frequencyCapHoldsUntil: null }, refusal: null, steps: ["Reset step run run-1 to RUNNING, keeping idempotency key auto:enr-1:0 (provider deduplicates).", "Queue one AUTOMATION_STEP job for this step."] };
const replayRow = (mode: string, status: string) => ({ id: `rp-${mode}`, scope: "STEP_RUN", mode, status, reason: "Resolve unknown outcome", requestedBy: REVIEWER.id, enrollmentId: "enr-1", stepRunId: "run-1", outboxJobId: null, result: { plan: PLAN }, createdAt: "2026-10-26T09:00:00Z", executedAt: null });

function mocks(api: MockApi, user: E2EUser) {
  const rights = { canAuthor: true, canApprove: true };
  defaultMocks(api, user, entitlements({ mailboxes: [], marketingEnabled: true, marketing: [{ organizationId: ORG.id, slug: ORG.slug, name: ORG.name, ...rights }] }));
  api
    .on("GET", `${MK}/organizations`, ok([{ ...ORG, ...rights }]))
    .on("GET", `${MK}/org-cf/automations`, ok([AUTOMATION]))
    .on("GET", `${MK}/org-cf/automations/${AUTO}`, ok(AUTOMATION))
    .on("GET", `${MK}/org-cf/automations/${AUTO}/enrollments`, ok([], { nextCursor: null }))
    .on("GET", `${MK}/org-cf/automations/${AUTO}/recovery`, ok(RECOVERY))
    .on("GET", `${MK}/org-cf/automations/${AUTO}/replays`, ok({ items: [], more: false }))
    .on("GET", `${MK}/org-cf/templates`, ok([], { nextCursor: null }))
    .on("GET", `${MK}/org-cf/sender-identities`, ok([]))
    .on("GET", `${MK}/org-cf/audiences`, ok([], { nextCursor: null }))
    .on("GET", `${MK}/org-cf/automation-events`, ok([]))
    .on("GET", `${MK}/org-cf/contacts`, ok([], { nextCursor: null }));
}

const PAGE = "/dashboard/marketing/email-marketing/automation";

test.describe("Automation test mode and replay / recovery", () => {
  test("test mode shows the path with DST-correct local times and creates nothing", async ({ page, api }) => {
    await signIn(page, REVIEWER);
    mocks(api, REVIEWER);
    api.on("POST", `${MK}/org-cf/automations/${AUTO}/versions/ver-1/test`, ok(TEST_RESULT));
    await gotoWithEntitlements(page, PAGE);
    await page.getByRole("button", { name: /Booking thanks/ }).click();
    const panel = page.locator("section", { has: page.getByRole("heading", { name: "Test (nothing is sent)" }) });
    await panel.getByLabel("Time zone (IANA)").fill("America/New_York");
    await panel.getByRole("button", { name: "Run test" }).click();
    await expect(panel.getByText("Would enroll and run 2 step(s) with 1 email(s), ending completed.")).toBeVisible();
    await expect(panel.getByText("2026-03-08T03:30:00-04:00")).toBeVisible();
    await expect(panel.getByText(/shifted forward 60 min/)).toBeVisible();
    await expect(panel.getByText("Subject:")).toBeVisible();
    const body = api.callsTo("POST", `${MK}/org-cf/automations/${AUTO}/versions/ver-1/test`)[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ contact: { email: "test.reader@example.com", timezone: "America/New_York", consentStatus: "GRANTED" } });
    expect(api.callsTo("POST", `${MK}/org-cf/automations/${AUTO}/replays`)).toHaveLength(0);
  });

  test("replay: dry run, acknowledgement, step-up, then execution", async ({ page, api }) => {
    await signIn(page, REVIEWER);
    mocks(api, REVIEWER);
    api.on("POST", "/api/mail/v1/security/step-up", ok({ stepUpId: "su-1", expiresAt: "2026-10-26T09:05:00Z" }));
    api.on("POST", `${MK}/org-cf/automations/${AUTO}/replays`, (req) => {
      const body = req.postDataJSON() as Record<string, unknown>;
      if (body.mode === "DRY_RUN") return ok({ replay: replayRow("DRY_RUN", "PLANNED"), plan: PLAN, executable: true, requires: ["acknowledgeUnknownOutcome: true"] });
      if (!body.acknowledgeUnknownOutcome) return fail(409, "MAIL_INVALID_TRANSITION", "Not allowed", [{ code: "MAIL_INVALID_TRANSITION", reason: "UNKNOWN_OUTCOME_ACKNOWLEDGEMENT_REQUIRED" }]);
      return ok({ replay: replayRow("EXECUTE", "EXECUTED"), plan: PLAN, outcome: { action: "RETRY_UNKNOWN_SEND", jobId: "job-12345678", idempotencyKey: "auto:enr-1:0", idempotencyKeyReused: true } });
    });
    await gotoWithEntitlements(page, PAGE);
    await page.getByRole("button", { name: /Booking thanks/ }).click();
    const panel = page.locator("section", { has: page.getByRole("heading", { name: "Replay & recovery" }) });
    await panel.getByRole("button", { name: "Select" }).click();
    await panel.getByLabel("Reason (audited)").fill("Resolve unknown outcome");
    await panel.getByRole("button", { name: "Dry run" }).click();
    await expect(panel.getByTestId("au-replay-plan")).toContainText("retry unknown send");
    const executeButton = panel.getByRole("button", { name: "Execute (requires 2FA code)" });
    await expect(executeButton).toBeDisabled(); // needs the acknowledgement
    await panel.getByRole("checkbox").check();
    await executeButton.click();
    const dialog = page.getByRole("dialog", { name: "Confirm this replay" });
    await expect(dialog).toBeVisible();
    expect(api.callsTo("POST", `${MK}/org-cf/automations/${AUTO}/replays`).filter((c) => (c.body as Record<string, unknown>).mode === "EXECUTE"), "nothing executed before step-up").toHaveLength(0);
    await dialog.getByLabel("Authentication code").fill("123456");
    await dialog.getByRole("button", { name: "Verify" }).click();
    await expect(panel.getByTestId("au-replay-result")).toContainText("same idempotency key");
    expect(api.callsTo("POST", "/api/mail/v1/security/step-up")[0].body).toEqual({ code: "123456", purpose: "MARKETING_AUTOMATION_REPLAY" });
    const execute = api.callsTo("POST", `${MK}/org-cf/automations/${AUTO}/replays`).find((c) => (c.body as Record<string, unknown>).mode === "EXECUTE");
    expect(execute?.body).toMatchObject({ scope: "STEP_RUN", targetId: "run-1", stepUpId: "su-1", acknowledgeUnknownOutcome: true, reason: "Resolve unknown outcome" });
  });

  test("replay endpoints before migration 37 show an honest unavailable state", async ({ page, api }) => {
    await signIn(page, REVIEWER);
    mocks(api, REVIEWER);
    api.on("GET", `${MK}/org-cf/automations/${AUTO}/recovery`, fail(503, "MAIL_FEATURE_NOT_READY", "This Mail feature is not available yet: its database migration has not been applied."));
    await gotoWithEntitlements(page, PAGE);
    await page.getByRole("button", { name: /Booking thanks/ }).click();
    const panel = page.locator("section", { has: page.getByRole("heading", { name: "Replay & recovery" }) });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: "Select" })).toHaveCount(0);
  });
});
