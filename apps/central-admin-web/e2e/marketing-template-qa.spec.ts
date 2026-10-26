import { test, expect, signIn, defaultMocks, entitlements, gotoWithEntitlements, ok, ALICE, REVIEWER, type E2EUser, type MockApi } from "./fixtures";

// Final gaps 1 + 7: template classification badge + change control (step-up)
// and the template QA panel (desktop / mobile / dark / plain text previews and
// PASS / WARNING / BLOCKED / UNKNOWN checks). Mocked API, no network.

const MK = "/api/mail/v1/marketing";
const ORG = { id: "org-cf", slug: "cosmicforge", name: "CosmicForge" };
const PAGE = "/dashboard/marketing/email-marketing/templates/tpl-1";

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: "ver-1",
    version: 1,
    subject: "Your receipt",
    preheader: null,
    blocks: [{ type: "heading", text: "Receipt", level: 1 }, { type: "text", text: "Thanks {{first_name}}" }],
    brand: { name: "CosmicForge", primaryColor: "#272EA7" },
    variables: ["brand_name", "first_name", "unsubscribe_url"],
    contentSha256: "a".repeat(64),
    createdBy: ALICE.id,
    createdAt: "2026-10-24T08:00:00Z",
    classification: "MARKETING",
    approval: null,
    ...overrides,
  };
}

function templateDetail(overrides: Record<string, unknown> = {}) {
  return { id: "tpl-1", name: "Receipts", description: null, status: "ACTIVE", latestVersion: 1, legacyTemplateId: null, classification: "MARKETING", classificationAvailable: true, classificationReason: null, versions: [version()], createdAt: "2026-10-20T08:00:00Z", updatedAt: "2026-10-24T08:00:00Z", ...overrides };
}

const QA_REPORT = {
  versionId: "ver-1",
  version: 1,
  classification: "MARKETING",
  disclaimer: "Previews are rendered in a browser frame. They do not prove how the email renders in every email client (Outlook, Gmail, Apple Mail and mobile apps differ); the compatibility checks are static heuristics.",
  locale: "en-GB",
  sampleContact: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.invalid" },
  formatted: { date: "26 October 2026", number: "1,234,567.89", currency: "US$1,234.50" },
  brandTokens: { name: "CosmicForge", primaryColor: "#272EA7", applied: true },
  renders: {
    subject: "Your receipt",
    desktop: { width: 600, html: '<html lang="en-GB"><body><h1>Receipt desktop</h1></body></html>' },
    mobile: { width: 375, html: '<html lang="en-GB"><body><h1>Receipt mobile</h1></body></html>' },
    dark: { html: '<html lang="en-GB"><body><h1>Receipt dark</h1></body></html>', supportsDarkMode: false, simulated: true },
    plaintext: "RECEIPT\n\nThanks Ada\n\nUnsubscribe: https://example.invalid/unsubscribe-preview",
  },
  checks: [
    { id: "template_renders", ok: true, status: "PASS", detail: "3 variable(s)" },
    { id: "a11y_alt_text", ok: true, status: "WARNING", detail: "1 of 1 image(s) have no alt text" },
    { id: "links_safe", ok: false, status: "BLOCKED", detail: "LINK_SHORTENER: bit.ly" },
    { id: "link_tracking", ok: true, status: "UNKNOWN", detail: "Provider click tracking state is not known" },
  ],
  summary: { PASS: 1, WARNING: 1, BLOCKED: 1, UNKNOWN: 1 },
  compatibility: [],
  approval: null,
};

function mocks(api: MockApi, user: E2EUser, rights: { canAuthor: boolean; canApprove: boolean }, detail = templateDetail()) {
  defaultMocks(api, user, entitlements({ mailboxes: [], marketingEnabled: true, marketing: [{ organizationId: ORG.id, slug: ORG.slug, name: ORG.name, ...rights }] }));
  api
    .on("GET", `${MK}/organizations`, ok([{ ...ORG, ...rights }]))
    .on("GET", `${MK}/org-cf/templates`, ok([], { nextCursor: null }))
    .on("GET", `${MK}/org-cf/templates/tpl-1`, ok(detail))
    .on("POST", `${MK}/org-cf/templates/tpl-1/versions/ver-1/qa`, ok(QA_REPORT));
}

test.describe("Template classification and QA", () => {
  test("the classification badge shows the template class and each version's snapshot", async ({ page, api }) => {
    await signIn(page, ALICE);
    mocks(api, ALICE, { canAuthor: true, canApprove: false }, templateDetail({ classification: "TRANSACTIONAL", versions: [version({ classification: "TRANSACTIONAL", version: 2, id: "ver-2" }), version()] }));
    await gotoWithEntitlements(page, PAGE);
    const badges = page.getByTestId("template-classification-badge");
    await expect(badges.first()).toHaveAttribute("data-classification", "TRANSACTIONAL");
    await expect(page.getByText("Transactional", { exact: true }).first()).toBeVisible();
    // {{unsubscribe_url}} is marketing-only: not offered for transactional templates.
    await expect(page.getByRole("button", { name: "{{unsubscribe_url}}" })).toHaveCount(0);
    // Authors without approval rights cannot make a transactional change.
    await page.getByRole("button", { name: "Change classification" }).click();
    await page.getByLabel("Classification reason").fill("Back to marketing use");
    await expect(page.getByText("Only brand approvers can change a transactional classification.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply (requires 2FA)" })).toBeDisabled();
  });

  test("an approver changes the classification only through a 2FA step-up with a reason", async ({ page, api }) => {
    await signIn(page, REVIEWER);
    mocks(api, REVIEWER, { canAuthor: true, canApprove: true });
    api.on("POST", "/api/mail/v1/security/step-up", ok({ stepUpId: "su-1", expiresAt: "2026-10-24T09:05:00Z" }));
    api.on("PUT", `${MK}/org-cf/templates/tpl-1/classification`, ok({ templateId: "tpl-1", classification: "TRANSACTIONAL", changed: true, newVersion: { id: "ver-2", version: 2, contentSha256: "b".repeat(64), classification: "TRANSACTIONAL" } }));
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByTestId("template-classification-badge").first()).toHaveAttribute("data-classification", "MARKETING");
    await page.getByRole("button", { name: "Change classification" }).click();
    await page.getByLabel("New classification").selectOption("TRANSACTIONAL");
    const apply = page.getByRole("button", { name: "Apply (requires 2FA)" });
    await expect(apply).toBeDisabled(); // reason required
    await page.getByLabel("Classification reason").fill("Receipts are service mail");
    await apply.click();
    const dialog = page.getByRole("dialog", { name: "Confirm template classification change" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Authentication code").fill("123456");
    await dialog.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/Saved as new version v2/)).toBeVisible();
    const stepUps = api.callsTo("POST", "/api/mail/v1/security/step-up");
    expect((stepUps[0].body as { purpose: string }).purpose).toBe("MARKETING_TEMPLATE_CLASSIFY");
    const puts = api.callsTo("PUT", `${MK}/org-cf/templates/tpl-1/classification`);
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toMatchObject({ classification: "TRANSACTIONAL", reason: "Receipts are service mail", stepUpId: "su-1" });
  });

  test("the QA panel shows desktop, mobile, dark and plain-text previews with four check states", async ({ page, api }) => {
    await signIn(page, ALICE);
    mocks(api, ALICE, { canAuthor: true, canApprove: false });
    await gotoWithEntitlements(page, PAGE);
    await page.getByLabel("QA locale").fill("en-GB");
    await page.getByRole("button", { name: "Run QA on v1" }).click();
    const report = page.getByTestId("template-qa-report");
    await expect(report).toBeVisible();
    await expect(report.getByRole("note")).toContainText("do not prove");
    const checks = report.getByRole("list", { name: "QA checks" });
    for (const status of ["PASS", "WARNING", "BLOCKED", "UNKNOWN"]) await expect(checks.locator(`[data-status="${status}"]`)).toHaveCount(1);
    // Blocked checks are listed first.
    await expect(checks.locator("li").first()).toContainText("links_safe");
    await expect(page.frameLocator('iframe[title="QA preview (desktop)"]').getByText("Receipt desktop")).toBeVisible();
    await report.getByRole("tab", { name: "Mobile" }).click();
    await expect(page.frameLocator('iframe[title="QA preview (mobile)"]').getByText("Receipt mobile")).toBeVisible();
    await report.getByRole("tab", { name: "Dark mode" }).click();
    await expect(page.frameLocator('iframe[title="QA preview (dark)"]').getByText("Receipt dark")).toBeVisible();
    await expect(report.getByText(/Simulated forced dark mode/)).toBeVisible();
    await report.getByRole("tab", { name: "Plain text" }).click();
    await expect(report.getByText(/Thanks Ada/)).toBeVisible();
    const calls = api.callsTo("POST", `${MK}/org-cf/templates/tpl-1/versions/ver-1/qa`);
    expect(calls[0].body).toMatchObject({ locale: "en-GB" });
  });
});
