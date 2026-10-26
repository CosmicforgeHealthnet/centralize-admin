import AxeBuilder from "@axe-core/playwright";
import { test, expect, signIn, defaultMocks, entitlements, gotoWithEntitlements, attachScreenshot, mailbox, thread, ok, SUPER_USER, ALICE } from "./fixtures";

// M9: automated WCAG 2.1 A/AA checks (axe-core) on the main Mail and
// Marketing surfaces, with the API mocked. Serious/critical violations fail.
// Automated checks are not a full accessibility audit (manual keyboard and
// screen-reader review is still required; see docs).

const M = "/api/mail/v1";

async function audit(page: import("@playwright/test").Page, name: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `${name} has no serious/critical axe violations`).toEqual([]);
}

test.describe("Accessibility (axe)", () => {
  test("mailbox inbox", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [], signatureHtml: null }));
    api.on("GET", `${M}/mailboxes/mb-alice/threads`, ok([thread()], { nextCursor: null }));
    await gotoWithEntitlements(page, "/dashboard/mail/mb-alice");
    await expect(page.getByText("Quarterly figures")).toBeVisible();
    await audit(page, "inbox");
  });

  test("mail settings", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [], signatureHtml: null }));
    api.on("GET", `${M}/mailboxes/:id/members`, ok([]));
    api.on("GET", `${M}/provisioning/requests`, ok([]));
    await gotoWithEntitlements(page, "/dashboard/mail/settings");
    await expect(page.getByRole("heading", { name: "Mail settings" })).toBeVisible();
    await audit(page, "settings");
  });

  test("mail operations and product integrations", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER, entitlements());
    api.on("GET", `${M}/admin/ops/snapshot`, ok({ generatedAt: "2026-10-25T09:00:00Z", runtimeHalt: { staffMail: null, marketing: null }, queue: { byStatus: [], oldestDueSeconds: {}, active: 0, deadLetters24h: [] }, webhooks: { backlog: 0, oldestBacklogSeconds: 0, failed24h: 0 }, scanning: { backlog: 0, oldestBacklogSeconds: 0 }, delivery: { staff24h: {}, outcomeUnknown24h: 0 }, retention: {}, openAlerts: [] }));
    api.on("GET", `${M}/admin/ops/alerts`, ok([]));
    api.on("GET", `${M}/admin/usage`, ok({ days: 30, since: "2026-09-26T00:00:00Z", summary: [], limits: [], cost: { currency: null, source: null, note: "No prices configured." } }));
    api.on("GET", `${M}/admin/retention/capabilities`, ok({ executionEnabled: false, dryRunValidHours: 24, systemCategories: [] }));
    api.on("GET", `${M}/admin/retention-policies`, ok([]));
    api.on("GET", `${M}/admin/retention/runs`, ok([]));
    await gotoWithEntitlements(page, "/dashboard/mail/operations");
    await expect(page.getByRole("heading", { name: "Mail operations" })).toBeVisible();
    await expect(page.getByText("No open alerts.")).toBeVisible();
    await audit(page, "operations");
    api.on("GET", `${M}/admin/integrations`, ok([]));
    api.on("GET", `${M}/admin/organizations`, ok([]));
    await gotoWithEntitlements(page, "/dashboard/mail/integrations");
    await expect(page.getByText("No product integrations registered.")).toBeVisible();
    await audit(page, "integrations");
  });

  test("IT mail administration", async ({ page, api }, testInfo) => {
    const admin = { ...SUPER_USER, id: "u-it", tier: "ADMIN" };
    await signIn(page, admin);
    defaultMocks(api, admin, entitlements({ mailboxes: [], canManageDomains: true, canViewAdministration: true, canProvision: true }));
    api.on("GET", /^\/api\/(telemedicine|rtc|logistics|payments|audit-service|notifications-service)(\/.*)?$/, { status: 503, body: { success: false, code: "UNAVAILABLE", message: "Unavailable in E2E" } });
    api.on("GET", `${M}/admin/organizations`, ok([{ id: "org-cf", slug: "cosmicforge", name: "CosmicForge", kind: "BRAND" }]));
    api.on("GET", `${M}/admin/domains`, ok([{ id: "dom-1", organizationId: "org-cf", domain: "cosmicforge.example", status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "PENDING", providerDomainId: "d1", dnsRecords: [], lastCheckedAt: null, verifiedAt: null, organization: { id: "org-cf", slug: "cosmicforge", name: "CosmicForge" } }]));
    api.on("GET", `${M}/admin/audit-events`, ok([]));
    api.on("GET", `${M}/admin/webhook-events`, ok([]));
    api.on("GET", `${M}/admin/delivery-events`, ok([]));
    api.on("GET", `${M}/admin/jobs`, ok([]));
    await page.goto("/dashboard/it");
    await page.getByRole("button", { name: "Mail Administration" }).first().click();
    await expect(page.getByRole("cell", { name: "cosmicforge.example" })).toBeVisible();
    await attachScreenshot(page, testInfo, "it-mail-administration-domains");
    await audit(page, "IT mail administration (domains)");
    await page.getByRole("tab", { name: "Audit & events" }).click();
    await expect(page.getByRole("heading", { name: "Jobs and dead letters" })).toBeVisible();
    await attachScreenshot(page, testInfo, "it-mail-administration-audit");
    await audit(page, "IT mail administration (audit)");
  });
});
