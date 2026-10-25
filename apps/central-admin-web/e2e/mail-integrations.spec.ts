import { test, expect, signIn, defaultMocks, gotoWithEntitlements, ok, fail, noHorizontalScroll, SUPER_USER, ALICE } from "./fixtures";

// M8: HQ product-integration administration. API fully mocked.

const ADM = "/api/mail/v1/admin";
const PAGE = "/dashboard/mail/integrations";

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: "int-kg", product: "karryam", organization: { id: "org-kg", slug: "karryam", name: "Karryam" }, serviceName: "karryam-notification-service",
    status: "DISABLED", classification: "STANDARD", contractVersion: 1, allowedEventTypes: ["mail.delivery_status", "ops.alert"], allowedTriggerTypes: [],
    ownerApprovalReference: null, ownerApprovedBy: null, approvedAt: null, lastEventAt: null, lastErrorCode: null, lastErrorAt: null,
    credentialConfigured: true, createdAt: "2026-10-24T08:00:00Z", updatedAt: "2026-10-24T08:00:00Z", ...overrides,
  };
}

function mocks(api: Parameters<typeof defaultMocks>[0]) {
  defaultMocks(api, SUPER_USER);
  api
    .on("GET", `${ADM}/integrations`, ok([integration(), integration({ id: "int-hn", product: "healthnet", organization: { id: "org-hn", slug: "healthnet", name: "HealthNet" }, serviceName: "healthnet-ops", classification: "RESTRICTED_HEALTH", allowedEventTypes: ["ops.alert"] })]))
    .on("GET", `${ADM}/organizations`, ok([{ id: "org-kg", slug: "karryam", name: "Karryam" }]))
    .on("GET", `${ADM}/addresses`, ok([{ id: "addr-noreply", address: "noreply@karryam.example", kind: "SYSTEM", status: "ACTIVE", organizationId: "org-kg" }]))
    .on("GET", `${ADM}/integrations/:id/senders`, ok([]))
    .on("GET", `${ADM}/integrations/:id/events`, ok([{ id: "e1", eventId: null, eventType: "mail.delivery_status", eventVersion: 1, correlationId: null, status: "REJECTED", errorCode: "MAIL_INTEGRATION_FORBIDDEN_CONTENT", outcome: null, occurredAt: null, receivedAt: "2026-10-24T09:00:00Z" }]))
    .on("GET", `${ADM}/integrations/:id/health`, ok({ integration: integration(), events24h: [], rejections7d: [{ code: "MAIL_INTEGRATION_FORBIDDEN_CONTENT", count: 1 }], delivery24h: { DELIVERED: 4 }, delivery7d: { DELIVERED: 9, BOUNCED: 1 }, deliveryByCategory7d: [], warnings: ["NO_EVENTS_IN_24H"] }));
}

test.describe("M8 product integrations", () => {
  test("activation requires owner approval details and a step-up code", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    mocks(api);
    api.on("POST", "/api/mail/v1/security/step-up", ok({ stepUpId: "su-int", expiresAt: "2026-10-24T09:05:00Z" }));
    api.on("POST", `${ADM}/integrations/int-kg/activate`, ok(integration({ status: "ACTIVE", ownerApprovalReference: "KG-42", ownerApprovedBy: "Karryam owner" })));
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByText("Configured on server")).toBeVisible();
    await expect(page.getByText("No events received in the last 24 hours.")).toBeVisible();
    await expect(page.getByText("MAIL_INTEGRATION_FORBIDDEN_CONTENT").first()).toBeVisible();
    const activate = page.getByRole("button", { name: "Activate…" });
    await expect(activate).toBeDisabled();
    await page.getByLabel("Owner approval reference").fill("KG-42");
    await page.getByLabel("Approved by (product owner)").fill("Karryam owner");
    await activate.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Authentication code").fill("123456");
    await dialog.getByRole("button", { name: "Verify" }).click();
    await expect.poll(() => api.callsTo("POST", `${ADM}/integrations/int-kg/activate`).length).toBe(1);
    expect(api.callsTo("POST", "/api/mail/v1/security/step-up")[0].body).toEqual({ code: "123456", purpose: "MAIL_INTEGRATION_ACTIVATE" });
    expect(api.callsTo("POST", `${ADM}/integrations/int-kg/activate`)[0].body).toEqual({ ownerApprovalReference: "KG-42", ownerApprovedBy: "Karryam owner", stepUpId: "su-int" });
    await noHorizontalScroll(page);
  });

  test("HealthNet is shown as restricted and only offers operational alerts", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    mocks(api);
    await gotoWithEntitlements(page, PAGE);
    await page.getByRole("option", { name: /healthnet/ }).click();
    await expect(page.getByRole("heading", { name: /healthnet · HealthNet/ })).toBeVisible();
    await expect(page.getByLabel("Purpose")).toBeDisabled();
    await expect(page.getByLabel("Purpose")).toHaveValue("OPERATIONAL_ALERT");
    await page.getByRole("textbox", { name: "Product", exact: true }).fill("healthnet-labs");
    await expect(page.getByText("HealthNet integrations are restricted", { exact: false })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "mail.delivery_status" })).toBeDisabled();
  });

  test("staff without a grant see a clear forbidden state", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api.on("GET", `${ADM}/integrations`, fail(403, "MAIL_FORBIDDEN", "Mail administrator access required."));
    await gotoWithEntitlements(page, PAGE);
    await expect(page.getByText("Only mail administrators", { exact: false })).toBeVisible();
  });
});
