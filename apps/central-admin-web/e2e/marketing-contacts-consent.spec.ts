import { test, expect, signIn, defaultMocks, entitlements, ok, noHorizontalScroll, SUPER_USER, type MockApi } from "./fixtures";
import type { Page } from "@playwright/test";
import type { ConsentOptions } from "../src/types/mail-marketing.types";
// The backend's own request schemas: every body the UI sends must satisfy them.
import openapi from "../../../services/central-admin-api/src/modules/mail/openapi/mail.openapi.js";

// Contacts & Consent: saving a contact is separate from marketing permission,
// staff never pick a consent source, documented consent needs a second
// approver, CSV import offers only the backend's channels. API mocked; the
// request bodies are checked against the backend OpenAPI request schemas.

const MK = "/api/mail/v1/marketing";
const ORG = { id: "org-cf", slug: "cosmicforge", name: "CosmicForge" };
const OPTIONS: ConsentOptions = { topics: ["newsletter", "offers"], policyVersions: ["2026-11", "2026-10"], currentPolicyVersion: "2026-11", policyVersionsConfigured: true, importOriginalChannels: ["WEB_FORM", "EVENT", "OTHER"], adminModes: ["REQUEST_CONFIRMATION", "DOCUMENTED"], approvalTtlHours: 168 };

type Schema = { type?: string | string[]; required?: string[]; properties?: Record<string, Schema>; enum?: unknown[]; maxLength?: number; format?: string };
/** Strict validation: unknown keys are errors too (the UI must not send extras). */
function violations(schema: Schema, value: unknown, path = "body"): string[] {
  const out: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  if (schema.type === "object" || schema.properties) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [...out, `${path}: expected object`];
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (record[key] === undefined) out.push(`${path}.${key}: required`);
    for (const [key, entry] of Object.entries(record)) {
      const child = schema.properties?.[key];
      if (!child) { if (schema.properties && Object.keys(schema.properties).length) out.push(`${path}.${key}: not in the API contract`); continue; }
      out.push(...violations(child, entry, `${path}.${key}`));
    }
  }
  if (schema.type === "string" && typeof value === "string" && schema.maxLength && value.length > schema.maxLength) out.push(`${path}: too long`);
  if (schema.type === "string" && value !== undefined && typeof value !== "string") out.push(`${path}: expected string`);
  return out;
}
const contract = (key: string, body: unknown) => violations((openapi.REQUEST_BODIES as unknown as Record<string, Schema>)[key], body);

function mocks(api: MockApi, { options = OPTIONS, canApprove = true } = {}) {
  defaultMocks(api, SUPER_USER, entitlements({ marketingEnabled: true, marketing: [{ organizationId: ORG.id, slug: ORG.slug, name: ORG.name, canAuthor: true, canApprove }] }));
  api
    .on("GET", /^\/api\/notifications\/unread-count/, ok({ unreadCount: 0 }))
    .on("GET", new RegExp(`^${MK}/.*`), ok([], { nextCursor: null }))
    .on("GET", `${MK}/organizations`, ok([{ organizationId: ORG.id, slug: ORG.slug, name: ORG.name, canAuthor: true, canApprove }]))
    .on("GET", `${MK}/org-cf/consent-options`, ok({ ...options } as Record<string, unknown>))
    .on("GET", `${MK}/org-cf/contacts`, ok([{ id: "ct-1", email: "saved@reader.example", firstName: null, lastName: null, status: "ACTIVE", source: "manual", consents: [], createdAt: "2026-11-05T08:00:00Z" }], { nextCursor: null }));
}

async function openTab(page: Page, tab: string) {
  await page.goto("/dashboard/marketing/email-marketing/contacts?org=org-cf", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: tab }).click();
}

const created = (permission: string, extra: Record<string, unknown> = {}) => ok({ id: "ct-new", email: "new@reader.example", firstName: null, lastName: null, status: "ACTIVE", source: "manual", consents: [], createdAt: "2026-11-05T09:00:00Z", marketingPermission: permission, consentApproval: null, confirmationToken: null, confirmationEmail: null, ...extra });

test.describe("Contacts & consent", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_USER);
  });

  test("Add contact: no consent-source choice; saving without permission is the default", async ({ page, api }) => {
    mocks(api);
    api.on("POST", `${MK}/org-cf/contacts`, created("NOT_REQUESTED"));
    await openTab(page, "Add contact");
    const form = page.getByRole("form", { name: "Add contact" });
    await expect(form.getByText("Consent source")).toHaveCount(0);
    for (const label of ["WEB FORM", "API", "EVENT"]) await expect(form.getByRole("option", { name: label })).toHaveCount(0);
    await expect(form.getByRole("radio", { name: /Save contact only/ })).toBeChecked();
    await expect(form.getByLabel("Privacy policy they agreed to")).toHaveCount(0);
    await expect(form.getByLabel("Where is the proof?")).toHaveCount(0);
    await form.getByLabel("Email", { exact: true }).fill("new@reader.example");
    await form.getByRole("button", { name: "Save contact" }).click();
    await expect(form.getByRole("status")).toContainText("Saved without marketing permission");
    const [call] = api.callsTo("POST", `${MK}/org-cf/contacts`);
    expect(call.body).toEqual({ email: "new@reader.example" });
    expect(contract("post /marketing/{orgId}/contacts", call.body)).toEqual([]);
  });

  test("Ask to confirm: sends mode only, configured choices, honest email status", async ({ page, api }) => {
    mocks(api);
    let queued = false;
    api.on("POST", `${MK}/org-cf/contacts`, () => created("PENDING_CONFIRMATION", { confirmationEmail: { queued, ...(queued ? {} : { reason: "CONFIRMATION_EMAILS_DISABLED" }) } }));
    await openTab(page, "Add contact");
    const form = page.getByRole("form", { name: "Add contact" });
    await form.getByRole("radio", { name: /Ask them to confirm by email/ }).check();
    await expect(form.getByLabel("Email list (topic)").locator("option")).toHaveText(["newsletter", "offers"]);
    await expect(form.getByLabel("Privacy policy they agreed to")).toHaveValue("2026-11");
    await form.getByLabel("Email list (topic)").selectOption("offers");
    await form.getByLabel("Email", { exact: true }).fill("new@reader.example");
    await form.getByRole("button", { name: "Save and send confirmation" }).click();
    await expect(form.getByRole("status")).toContainText("Confirmation emails are not enabled here, so no email was sent");
    const [call] = api.callsTo("POST", `${MK}/org-cf/contacts`);
    expect(call.body).toEqual({ email: "new@reader.example", consent: { mode: "REQUEST_CONFIRMATION", topic: "offers", policyVersion: "2026-11" } });
    expect(contract("post /marketing/{orgId}/contacts", call.body)).toEqual([]);
    queued = true;
    await form.getByLabel("Email", { exact: true }).fill("second@reader.example");
    await form.getByRole("radio", { name: /Ask them to confirm by email/ }).check();
    await form.getByRole("button", { name: "Save and send confirmation" }).click();
    await expect(form.getByRole("status")).toContainText("Confirmation email queued");
  });

  test("Documented consent requires proof and goes to a second approver", async ({ page, api }) => {
    mocks(api);
    api.on("POST", `${MK}/org-cf/contacts`, created("PENDING_APPROVAL", { consentApproval: { requestId: "req-1", status: "PENDING_APPROVAL", topic: "newsletter", expiresAt: "2026-11-12T09:00:00Z" } }));
    await openTab(page, "Add contact");
    const form = page.getByRole("form", { name: "Add contact" });
    await form.getByLabel("Email", { exact: true }).fill("new@reader.example");
    await form.getByRole("radio", { name: /They already agreed/ }).check();
    const submit = form.getByRole("button", { name: "Save and request approval" });
    await expect(submit).toBeDisabled();
    await form.getByLabel("Where is the proof?").fill("Signed form 117");
    await form.getByLabel("Notes for the approver (optional)").fill("Clinic sign-up desk");
    await submit.click();
    await expect(form.getByRole("status")).toContainText("Waiting for a second approver");
    const [call] = api.callsTo("POST", `${MK}/org-cf/contacts`);
    expect(call.body).toEqual({ email: "new@reader.example", consent: { mode: "DOCUMENTED", topic: "newsletter", policyVersion: "2026-11", evidence: { reference: "Signed form 117", note: "Clinic sign-up desk" } } });
    expect(contract("post /marketing/{orgId}/contacts", call.body)).toEqual([]);
  });

  test("No configured policy version: permission is blocked, saving still works", async ({ page, api }) => {
    mocks(api, { options: { ...OPTIONS, policyVersions: [], currentPolicyVersion: null, policyVersionsConfigured: false } });
    await openTab(page, "Add contact");
    const form = page.getByRole("form", { name: "Add contact" });
    await form.getByLabel("Email", { exact: true }).fill("new@reader.example");
    await form.getByRole("radio", { name: /Ask them to confirm by email/ }).check();
    await expect(form.getByRole("alert")).toContainText("No privacy-policy version is configured");
    await expect(form.getByRole("button", { name: "Save and send confirmation" })).toBeDisabled();
    await form.getByRole("radio", { name: /Save contact only/ }).check();
    await expect(form.getByRole("button", { name: "Save contact" })).toBeEnabled();
  });

  test("Request permission for a saved contact", async ({ page, api }) => {
    mocks(api);
    api.on("POST", `${MK}/org-cf/contacts/ct-1/consents`, ok({ topic: "newsletter", status: "PENDING_CONFIRMATION", consentApproval: null, confirmationEmail: { queued: true } }));
    await openTab(page, "Contacts");
    await page.getByRole("button", { name: "Request permission" }).click();
    const form = page.getByRole("form", { name: "Request permission for saved@reader.example" });
    await expect(form.getByRole("radio", { name: /Save contact only/ })).toHaveCount(0);
    await form.getByRole("button", { name: "Send confirmation" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Confirmation email queued" })).toBeVisible();
    const [call] = api.callsTo("POST", `${MK}/org-cf/contacts/ct-1/consents`);
    expect(contract("post /marketing/{orgId}/contacts/{contactId}/consents", call.body)).toEqual([]);
  });

  test("CSV import offers only the channels the backend accepts", async ({ page, api }) => {
    mocks(api);
    api.on("POST", `${MK}/org-cf/contacts/import`, ok({ mode: "preview", dryRun: true, fileSha256: "a".repeat(64), total: 1, created: 1, updated: 0, skipped: 0, rejected: 0, rows: [] }));
    await openTab(page, "CSV import");
    await expect(page.getByText("consent_evidence")).toHaveCount(0);
    await expect(page.getByText("consented_at")).toBeVisible();
    const channel = page.getByLabel("Where did they opt in?");
    await expect(channel.locator("option")).toHaveText(["Website sign-up form", "Event sign-up", "Other documented opt-in"]);
    await channel.selectOption("EVENT");
    await page.locator('input[type="file"]').setInputFiles({ name: "signups.csv", mimeType: "text/csv", buffer: Buffer.from("email\nnew@reader.example\n") });
    await page.getByLabel("Evidence reference").fill("event-sheet-17");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Preview import" }).click();
    await expect(page.getByText("Preview (nothing imported)")).toBeVisible();
    const [call] = api.callsTo("POST", `${MK}/org-cf/contacts/import`);
    const body = String(call.body);
    expect(body).toMatch(/name="originalChannel"\r\n\r\nEVENT\r\n/);
    expect(body).toMatch(/name="policyVersion"\r\n\r\n2026-11\r\n/);
    expect(body).not.toMatch(/name="source"/);
  });

  test("Approvals: requesters cannot decide; approvers approve with a confirmation", async ({ page, api }) => {
    mocks(api);
    const request = (id: string, requestedByMe: boolean) => ({ requestId: id, contactId: "ct-1", email: `${id}@reader.example`, topic: "newsletter", policyVersion: "2026-11", evidenceReference: "Signed form 117", evidenceNote: null, country: null, consentedAt: null, requestedAt: "2026-11-05T08:00:00Z", expiresAt: "2026-11-12T08:00:00Z", requestedByMe });
    api.on("GET", `${MK}/org-cf/consent-approvals`, ok([request("mine", true), request("theirs", false)]));
    api.on("POST", `${MK}/org-cf/consent-approvals/theirs/decision`, ok({ requestId: "theirs", decision: "APPROVE", topic: "newsletter", consentStatus: "GRANTED" }));
    await openTab(page, "Approvals");
    const mine = page.getByRole("listitem").filter({ hasText: "mine@reader.example" });
    await expect(mine.getByRole("button")).toHaveCount(0);
    await expect(mine).toContainText("You requested this");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("listitem").filter({ hasText: "theirs@reader.example" }).getByRole("button", { name: "Approve" }).click();
    await expect(page.getByRole("status").filter({ hasText: "permission is now active" })).toBeVisible();
    const [call] = api.callsTo("POST", `${MK}/org-cf/consent-approvals/theirs/decision`);
    expect(call.body).toEqual({ decision: "APPROVE" });
    expect(contract("post /marketing/{orgId}/consent-approvals/{requestId}/decision", call.body)).toEqual([]);
  });

  test("Mobile: short form, no technical fields by default, no horizontal scroll", async ({ page, api }, info) => {
    test.skip(info.project.name !== "mobile-chromium", "mobile layout check");
    mocks(api);
    await openTab(page, "Add contact");
    const form = page.getByRole("form", { name: "Add contact" });
    await noHorizontalScroll(page);
    await expect(form.locator("input:visible, select:visible, textarea:visible")).toHaveCount(6); // email, two names, three choices
    const height = await form.evaluate((node) => node.getBoundingClientRect().height);
    expect(height, "default Add contact form height on a 390px phone").toBeLessThan(760);
    await form.getByRole("radio", { name: /They already agreed/ }).check();
    await noHorizontalScroll(page);
  });
});
