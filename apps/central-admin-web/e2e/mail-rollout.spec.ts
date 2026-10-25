import AxeBuilder from "@axe-core/playwright";
import { test, expect, signIn, defaultMocks, gotoWithEntitlements, ok, noHorizontalScroll, SUPER_USER } from "./fixtures";

// M10: rollout controls. API fully mocked.

const ADM = "/api/mail/v1/admin";
const PAGE = "/dashboard/mail/rollout";
const cohort = { id: "co-1", key: "pilot-wave-1", name: "Pilot wave 1", description: null, members: [{ adminUserId: "u-alice", addedAt: "2026-10-24T08:00:00Z" }] };

function overview(overrides: Record<string, unknown> = {}) {
  return {
    environment: "staging", enforced: true,
    capabilities: ["STAFF_MAIL", "SUPPORT", "MARKETING_BROADCAST", "WORKER_OUTBOUND"], scopeTypes: ["ENVIRONMENT", "ORGANIZATION", "DOMAIN", "MAILBOX", "COHORT"],
    rules: [{ id: "r-1", environment: "staging", capability: "STAFF_MAIL", scopeType: "COHORT", scopeId: "co-1", effect: "ALLOW", reason: "Pilot wave 1", createdBy: "u-super", createdAt: "2026-10-24T08:00:00Z", revokedAt: null, revokedBy: null }],
    emergencyStops: [], environmentStops: { all: false, marketing: false }, cohorts: [cohort], ...overrides,
  };
}
const readiness = { environment: "staging", generatedAt: "2026-10-25T09:00:00Z", stages: [{ id: "S1_PILOT", label: "Stage 1: staff pilot cohort (one brand)", automatedReady: false, manualPending: 1, gates: [{ id: "enforced", label: "Rollout enforcement on", status: "PASS", detail: null }, { id: "no-critical", label: "No open critical alerts", status: "FAIL", detail: ["MAIL_STORAGE_UNHEALTHY"] }, { id: "dns", label: "DNS coexistence checklist complete", status: "MANUAL", detail: null }] }] };

function mocks(api: Parameters<typeof defaultMocks>[0], data = overview()) {
  defaultMocks(api, SUPER_USER);
  api.on("GET", `${ADM}/rollout`, ok(data)).on("GET", `${ADM}/rollout/readiness`, ok(readiness));
}

test.describe("M10 rollout controls", () => {
  test("an emergency stop is immediate; releasing it needs a step-up", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    mocks(api);
    const stop = { id: "st-1", environment: "staging", scope: "ALL", organizationId: null, reason: "Suspicious sending", activatedBy: "u-super", activatedAt: "2026-10-25T09:00:00Z", releasedAt: null, releasedBy: null };
    api.on("POST", `${ADM}/emergency-stops`, () => { api.on("GET", `${ADM}/rollout`, ok(overview({ emergencyStops: [stop] }))); return { status: 201, body: { success: true, data: stop } }; });
    api.on("POST", "/api/mail/v1/security/step-up", ok({ stepUpId: "su-rel", expiresAt: "2026-10-25T09:05:00Z" }));
    api.on("POST", `${ADM}/emergency-stops/st-1/release`, ok({ ...stop, releasedAt: "2026-10-25T09:10:00Z" }));
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByText("No stop is active.")).toBeVisible();
    await page.getByLabel("Reason").first().fill("Suspicious sending");
    await page.getByRole("button", { name: "Stop now" }).click();
    await expect.poll(() => api.callsTo("POST", `${ADM}/emergency-stops`).length).toBe(1);
    expect(api.callsTo("POST", "/api/mail/v1/security/step-up"), "activation needs no step-up").toHaveLength(0);
    await expect(page.getByRole("alert").filter({ hasText: "All sending stopped" })).toBeVisible();
    await page.getByRole("button", { name: "Release…" }).click();
    expect(api.callsTo("POST", `${ADM}/emergency-stops/st-1/release`)).toHaveLength(0);
    await page.getByRole("dialog").getByLabel("Authentication code").fill("123456");
    await page.getByRole("dialog").getByRole("button", { name: "Verify" }).click();
    await expect.poll(() => api.callsTo("POST", `${ADM}/emergency-stops/st-1/release`).length).toBe(1);
    expect(api.callsTo("POST", "/api/mail/v1/security/step-up")[0].body).toEqual({ code: "123456", purpose: "MAIL_EMERGENCY_STOP_RELEASE" });
  });

  test("ALLOW rules need a step-up; DENY rules apply immediately", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    mocks(api);
    api.on("POST", "/api/mail/v1/security/step-up", ok({ stepUpId: "su-rule", expiresAt: "2026-10-25T09:05:00Z" }));
    api.on("POST", `${ADM}/rollout/rules`, { status: 201, body: { success: true, data: {} } });
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByRole("cell", { name: "cohort pilot-wave-1" })).toBeVisible();
    const rules = page.getByRole("region", { name: /Rollout rules/ });
    const scope = rules.getByRole("combobox", { name: /^Scope/ });
    await rules.getByLabel("Capability").selectOption("WORKER_OUTBOUND");
    await expect(scope).toBeDisabled();
    const ruleReason = rules.getByLabel("Reason");
    await ruleReason.fill("Enable outbound worker for pilot");
    await page.getByRole("button", { name: "Allow… (needs 2FA)" }).click();
    expect(api.callsTo("POST", `${ADM}/rollout/rules`)).toHaveLength(0);
    await page.getByRole("dialog").getByLabel("Authentication code").fill("654321");
    await page.getByRole("dialog").getByRole("button", { name: "Verify" }).click();
    await expect.poll(() => api.callsTo("POST", `${ADM}/rollout/rules`).length).toBe(1);
    expect(api.callsTo("POST", `${ADM}/rollout/rules`)[0].body).toEqual({ capability: "WORKER_OUTBOUND", scopeType: "ENVIRONMENT", scopeId: null, effect: "ALLOW", reason: "Enable outbound worker for pilot", stepUpId: "su-rule" });
    expect(api.callsTo("POST", "/api/mail/v1/security/step-up")[0].body).toEqual({ code: "654321", purpose: "MAIL_ROLLOUT_CHANGE" });

    await rules.getByLabel("Effect").selectOption("DENY");
    await rules.getByLabel("Capability").selectOption("STAFF_MAIL");
    await scope.selectOption("MAILBOX");
    await rules.getByLabel("Scope ID").fill("mb-alice");
    await ruleReason.fill("Block a compromised mailbox");
    await page.getByRole("button", { name: "Deny now" }).click();
    await expect.poll(() => api.callsTo("POST", `${ADM}/rollout/rules`).length).toBe(2);
    expect(api.callsTo("POST", `${ADM}/rollout/rules`)[1].body).toEqual({ capability: "STAFF_MAIL", scopeType: "MAILBOX", scopeId: "mb-alice", effect: "DENY", reason: "Block a compromised mailbox" });
    expect(api.callsTo("POST", "/api/mail/v1/security/step-up"), "no extra step-up for DENY").toHaveLength(1);
  });

  test("readiness shows PASS / FAIL / MANUAL gates; offboarding a pilot member; page is accessible", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    mocks(api);
    api.on("DELETE", `${ADM}/rollout/cohorts/co-1/members/u-alice`, ok({ cohortId: "co-1", adminUserId: "u-alice", active: false }));
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByText("Stage 1: staff pilot cohort (one brand): blocked, 1 sign-off(s) to record")).toBeVisible();
    await expect(page.getByText("FAIL")).toBeVisible();
    await expect(page.getByText("MANUAL")).toBeVisible();
    await page.getByRole("button", { name: "Offboard u-alice from pilot-wave-1" }).click();
    await expect.poll(() => api.callsTo("DELETE", `${ADM}/rollout/cohorts/co-1/members/u-alice`).length).toBe(1);
    await noHorizontalScroll(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`)).toEqual([]);
  });
});
