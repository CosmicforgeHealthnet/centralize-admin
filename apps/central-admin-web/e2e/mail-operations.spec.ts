import { test, expect, signIn, defaultMocks, gotoWithEntitlements, ok, noHorizontalScroll, SUPER_USER } from "./fixtures";

// M9: Mail operations. API fully mocked; nothing leaves the browser.

const ADM = "/api/mail/v1/admin";
const PAGE = "/dashboard/mail/operations";

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  generatedAt: "2026-10-25T09:00:00Z", runtimeHalt: { staffMail: null, marketing: null },
  queue: { byStatus: [{ queue: "OUTBOUND", status: "PENDING", count: 3 }], oldestDueSeconds: { OUTBOUND: 1200 }, active: 3, deadLetters24h: [] },
  webhooks: { backlog: 0, oldestBacklogSeconds: 0, failed24h: 0 }, scanning: { backlog: 0, oldestBacklogSeconds: 0 },
  delivery: { staff24h: { DELIVERED: 40, BOUNCED: 1 }, outcomeUnknown24h: 0 }, retention: {}, openAlerts: [], ...overrides,
});
const alert = { id: "al-1", code: "MAIL_QUEUE_STALLED", severity: "warning", organizationId: null, detail: { queue: "OUTBOUND" }, occurrences: 3, firstSeenAt: "2026-10-25T08:40:00Z", lastSeenAt: "2026-10-25T09:00:00Z", acknowledgedAt: null, resolvedAt: null };
const dryRun = { id: "run-1", organizationId: "org-cf", policyId: "pol-1", category: "POLICY", action: "DELETE", mode: "DRY_RUN", status: "COMPLETED", cutoff: "2025-10-25T09:00:00Z", dryRunId: null, requestedBy: "u-super", counts: { candidates: 12, held: 2, skippedActive: 1 }, errorCode: null, startedAt: "2026-10-25T08:00:00Z", completedAt: "2026-10-25T08:01:00Z", createdAt: "2026-10-25T08:00:00Z" };

function mocks(api: Parameters<typeof defaultMocks>[0], { executionEnabled = false, halted = false } = {}) {
  defaultMocks(api, SUPER_USER);
  api
    .on("GET", `${ADM}/ops/snapshot`, ok(snapshot(halted ? { runtimeHalt: { staffMail: "MAIL_EMERGENCY_STOP", marketing: "MAIL_EMERGENCY_STOP" } } : {})))
    .on("GET", `${ADM}/ops/alerts`, ok([alert]))
    .on("GET", `${ADM}/usage`, ok({ days: 30, since: "2026-09-26T00:00:00Z", summary: [{ organizationId: "org-cf", organization: { id: "org-cf", name: "CosmicForge" }, purpose: "STAFF_MAIL", accepted: 120, rejected: 1, received: 300, providerRequests: 80, bytes: 1000, estimatedCost: null, daily: [] }], limits: [], cost: { currency: null, source: null, note: "No prices configured. Counts only; multiply by your contracted provider rates." } }))
    .on("GET", `${ADM}/retention/capabilities`, ok({ executionEnabled, dryRunValidHours: 24, systemCategories: [{ category: "WEBHOOK_PAYLOADS", action: "REDACT", retainDays: null }] }))
    .on("GET", `${ADM}/retention-policies`, ok([{ id: "pol-1", organizationId: "org-cf", mailboxId: null, name: "General 1y", retainDays: 365, action: "DELETE", enabled: true }]))
    .on("GET", `${ADM}/retention/runs`, ok([dryRun]));
}

test.describe("M9 Mail operations", () => {
  test("shows health, alerts and usage without inventing prices", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    mocks(api);
    api.on("POST", `${ADM}/ops/alerts/al-1/acknowledge`, ok({ ...alert, acknowledgedAt: "2026-10-25T09:01:00Z" }));
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByText("Active jobs")).toBeVisible();
    await expect(page.getByText("MAIL_QUEUE_STALLED")).toBeVisible();
    await expect(page.getByText("No prices configured", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Acknowledge MAIL_QUEUE_STALLED" }).click();
    await expect.poll(() => api.callsTo("POST", `${ADM}/ops/alerts/al-1/acknowledge`).length).toBe(1);
    await noHorizontalScroll(page);
  });

  test("retention execution is not offered when the server flag is off", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    mocks(api);
    api.on("POST", `${ADM}/retention/runs`, { status: 201, body: { success: true, data: { ...dryRun, id: "run-2", status: "QUEUED", counts: {} } } });
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByText("Execution is not enabled in this environment.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Execute/ })).toHaveCount(0);
    await expect(page.getByRole("option", { name: /WEBHOOK_PAYLOADS \(no period configured\)/ })).toHaveAttribute("disabled", "");
    await page.getByLabel("Policy or system category").selectOption("policy:pol-1");
    await page.getByRole("button", { name: "Start dry run" }).click();
    await expect.poll(() => api.callsTo("POST", `${ADM}/retention/runs`).length).toBe(1);
    expect(api.callsTo("POST", `${ADM}/retention/runs`)[0].body).toEqual({ policyId: "pol-1" });
  });

  test("executing a completed dry run needs a step-up code", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    mocks(api, { executionEnabled: true, halted: true });
    api.on("POST", "/api/mail/v1/security/step-up", ok({ stepUpId: "su-ret", expiresAt: "2026-10-25T09:05:00Z" }));
    api.on("POST", `${ADM}/retention/runs/run-1/execute`, { status: 201, body: { success: true, data: { ...dryRun, id: "run-3", mode: "EXECUTE", status: "QUEUED", dryRunId: "run-1" } } });
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByRole("alert").filter({ hasText: "Emergency stop active" })).toBeVisible();
    await page.getByRole("button", { name: "Execute… (permanent)" }).click();
    expect(api.callsTo("POST", `${ADM}/retention/runs/run-1/execute`)).toHaveLength(0);
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Authentication code").fill("123456");
    await dialog.getByRole("button", { name: "Verify" }).click();
    await expect.poll(() => api.callsTo("POST", `${ADM}/retention/runs/run-1/execute`).length).toBe(1);
    expect(api.callsTo("POST", "/api/mail/v1/security/step-up")[0].body).toEqual({ code: "123456", purpose: "MAIL_RETENTION_EXECUTE" });
    expect(api.callsTo("POST", `${ADM}/retention/runs/run-1/execute`)[0].body).toEqual({ stepUpId: "su-ret" });
  });
});
