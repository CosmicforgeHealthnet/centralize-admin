import { test, expect, signIn, defaultMocks, entitlements, ok, fail, ALICE, REVIEWER, type E2EUser } from "./fixtures";

// IT > Mail Administration and HR > Accounts mailbox requests (spec §15,
// §16.1, §24). Every capability comes from the server; the UI never shows
// message content, provider keys or secrets.

const M = "/api/mail/v1";
const NOW = "2026-10-24T09:00:00.000Z";
const MAIL_ADMIN: E2EUser = { id: "u-it", name: "Ife IT", email: "ife@cosmicforge.example", tier: "ADMIN", department: "IT", isTeamLead: false };
const HR_USER: E2EUser = { id: "u-hr", name: "Hana HR", email: "hana@cosmicforge.example", tier: "ADMIN", department: "HR", isTeamLead: false };

const ORG = { id: "org-cf", slug: "cosmicforge", name: "CosmicForge", kind: "BRAND" };
const DOMAIN = {
  id: "dom-1",
  organizationId: ORG.id,
  domain: "cosmicforge.example",
  status: "PENDING_VERIFICATION",
  sendingStatus: "PENDING",
  receivingStatus: "NOT_CONFIGURED",
  providerDomainId: "rs_dom_1",
  dnsRecords: [{ record: "DKIM", type: "TXT", name: "resend._domainkey", value: "p=MIGf...", status: "pending" }],
  lastCheckedAt: null,
  verifiedAt: null,
  organization: { id: ORG.id, slug: ORG.slug, name: ORG.name },
};
const REQUEST = {
  id: "pr-1",
  organizationId: ORG.id,
  type: "PERSONAL_MAILBOX",
  status: "PENDING",
  requestedByAdminUserId: HR_USER.id,
  subjectAdminUserId: "u-new",
  requestedAddress: "ada.okafor@cosmicforge.example",
  mailboxId: null,
  justification: "New starter",
  reviewedByAdminUserId: null,
  reviewedAt: null,
  reviewNote: null,
  createdAt: NOW,
};

async function openMailAdministration(page: import("@playwright/test").Page, api: import("./fixtures").MockApi) {
  // The IT overview loads non-Mail dashboards first; answer them with an error
  // (not null data) so the overview renders its own error states.
  api.on("GET", /^\/api\/(telemedicine|rtc|logistics|payments|audit-service|notifications-service)(\/.*)?$/, fail(503, "UNAVAILABLE", "Unavailable in E2E"));
  await page.goto("/dashboard/it");
  await page.getByRole("button", { name: "Mail Administration" }).first().click();
  await expect(page.getByRole("heading", { name: "Mail Administration" })).toBeVisible();
}

test.describe("IT > Mail Administration", () => {
  test("a mail administrator manages domains and approves provisioning without seeing mail content", async ({ page, api }) => {
    await signIn(page, MAIL_ADMIN);
    defaultMocks(api, MAIL_ADMIN, entitlements({ mailboxes: [], canManageDomains: true, canViewAdministration: true, canApproveProvisioning: true }));
    let verified = false;
    api
      .on("GET", `${M}/admin/organizations`, ok([ORG]))
      .on("GET", `${M}/admin/domains`, () => ok([verified ? { ...DOMAIN, status: "VERIFIED", sendingStatus: "VERIFIED", lastCheckedAt: NOW } : DOMAIN]))
      .on("POST", `${M}/admin/domains/:id/verify`, () => { verified = true; return ok({ ...DOMAIN, status: "VERIFIED" }); })
      .on("GET", `${M}/provisioning/requests`, ok([REQUEST]))
      .on("POST", `${M}/provisioning/requests/:id/approve`, ok({ ...REQUEST, status: "PROVISIONED" }))
      .on("GET", `${M}/admin/audit-events`, ok([{ id: "a1", actorAdminUserId: MAIL_ADMIN.id, action: "MAIL_DOMAIN_VERIFICATION_CHECKED", targetType: "domain", targetId: DOMAIN.id, mailboxId: null, organizationId: ORG.id, outcome: "SUCCESS", requestId: "r1", createdAt: NOW }]))
      .on("GET", `${M}/admin/webhook-events`, ok([{ id: "w1", provider: "resend", eventType: "email.delivered", status: "PROCESSED", signatureVerified: true, receivedAt: NOW, processedAt: NOW, lastError: null, lagSeconds: 2 }]))
      .on("GET", `${M}/admin/delivery-events`, ok([{ id: "d1", messageId: "m1", eventType: "DELIVERED", recipientDomain: "partner.example", occurredAt: NOW }]))
      .on("GET", `${M}/admin/jobs`, ok([]));

    await openMailAdministration(page, api);
    await expect(page.getByRole("cell", { name: "cosmicforge.example" })).toBeVisible();
    await page.getByRole("button", { name: "cosmicforge.example" }).click();
    await expect(page.getByText("resend._domainkey")).toBeVisible();
    await page.getByRole("button", { name: "Check DNS" }).click();
    await expect(page.getByText("verified").first()).toBeVisible();
    expect(api.callsTo("POST", `${M}/admin/domains/dom-1/verify`)).toHaveLength(1);

    await page.getByRole("tab", { name: "Provisioning" }).click();
    await expect(page.getByText("ada.okafor@cosmicforge.example")).toBeVisible();
    await page.getByLabel("Review note for ada.okafor@cosmicforge.example").fill("Welcome aboard");
    await page.getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => api.callsTo("POST", `${M}/provisioning/requests/pr-1/approve`).length).toBe(1);
    expect(api.callsTo("POST", `${M}/provisioning/requests/pr-1/approve`)[0].body).toEqual({ note: "Welcome aboard" });

    await page.getByRole("tab", { name: "Audit & events" }).click();
    await expect(page.getByText("MAIL_DOMAIN_VERIFICATION_CHECKED")).toBeVisible();
    await expect(page.getByRole("cell", { name: "partner.example" })).toBeVisible();

    // No private mailbox content is ever requested from the admin page.
    expect(api.callsTo("GET", /\/api\/mail\/v1\/(mailboxes|threads)\//)).toHaveLength(0);
    expect(api.unmatched.filter((call) => call.includes("/api/mail/"))).toEqual([]);
  });

  test("sole Super Admin directly provisions their personal mailbox without self-approval", async ({ page, api }) => {
    const SUPER: E2EUser = { ...MAIL_ADMIN, id: "u-super", name: "Super Owner", tier: "SUPER" };
    const VERIFIED = { ...DOMAIN, status: "VERIFIED", sendingStatus: "VERIFIED" };
    await signIn(page, SUPER);
    defaultMocks(api, SUPER, entitlements({ mailboxes: [], canManageDomains: true, canViewAdministration: true }));
    api
      .on("GET", `${M}/admin/organizations`, ok([ORG]))
      .on("GET", `${M}/admin/domains`, ok([VERIFIED]))
      .on("GET", `${M}/admin/mailboxes`, ok([]))
      .on("POST", `${M}/admin/mailboxes`, ok({ id: "mb-personal", organizationId: ORG.id, type: "PERSONAL", name: "Super Owner", status: "ACTIVE" }));

    await openMailAdministration(page, api);
    await page.getByRole("tab", { name: "Shared mailboxes" }).click();
    const form = page.locator("section[aria-labelledby=mail-personal-new-heading]");
    await expect(form.getByText("My account", { exact: true })).toBeVisible();
    await form.getByLabel("Brand").selectOption(ORG.id);
    await form.getByLabel("Personal email local part").fill("admin");
    await form.getByLabel("Personal email domain").selectOption(DOMAIN.id);
    await form.getByRole("button", { name: "Create personal mailbox" }).click();

    await expect.poll(() => api.callsTo("POST", `${M}/admin/mailboxes`).length).toBe(1);
    expect(api.callsTo("POST", `${M}/admin/mailboxes`)[0].body).toEqual({
      type: "PERSONAL", ownerAdminUserId: SUPER.id, organizationId: ORG.id,
      name: SUPER.name, purpose: "GENERAL",
      address: { domainId: DOMAIN.id, localPart: "admin", displayName: SUPER.name },
    });
    await expect(form.getByRole("link", { name: "Open your Mail inbox" })).toBeVisible();
    expect(api.callsTo("POST", `${M}/provisioning/requests`)).toHaveLength(0);
    expect(api.callsTo("GET", /\/api\/mail\/v1\/(threads|messages)\//)).toHaveLength(0);
  });

  test("Mail administrator directly assigns an employee personal mailbox without gaining its contents", async ({ page, api }) => {
    const STAFF = { id: "u-staff", name: "New Employee", email: "employee@cosmicforge.example", department: "Operations" };
    await signIn(page, MAIL_ADMIN);
    defaultMocks(api, MAIL_ADMIN, entitlements({ mailboxes: [], canManageDomains: true, canViewAdministration: true }));
    api
      .on("GET", `${M}/admin/organizations`, ok([ORG]))
      .on("GET", `${M}/admin/domains`, ok([{ ...DOMAIN, status: "VERIFIED" }]))
      .on("GET", `${M}/admin/mailboxes`, ok([]))
      .on("GET", `${M}/directory/staff`, ok([STAFF]))
      .on("POST", `${M}/admin/mailboxes`, ok({ id: "mb-staff", type: "PERSONAL" }));

    await openMailAdministration(page, api);
    await page.getByRole("tab", { name: "Shared mailboxes" }).click();
    const form = page.locator("section[aria-labelledby=mail-personal-new-heading]");
    await form.getByRole("radio", { name: "An employee" }).check();
    await form.getByRole("combobox", { name: "Search staff by name or email" }).fill("New Employee");
    await page.getByRole("option", { name: /New Employee/ }).click();
    await form.getByLabel("Brand").selectOption(ORG.id);
    await form.getByLabel("Personal email local part").fill("employee");
    await form.getByLabel("Personal email domain").selectOption(DOMAIN.id);
    await form.getByRole("button", { name: "Create personal mailbox" }).click();
    await expect.poll(() => api.callsTo("POST", `${M}/admin/mailboxes`).length).toBe(1);
    expect((api.callsTo("POST", `${M}/admin/mailboxes`)[0].body as Record<string, unknown>).ownerAdminUserId).toBe(STAFF.id);
    await expect(form.getByText("The employee can now sign in and open Mail.")).toBeVisible();
    expect(api.callsTo("GET", /\/api\/mail\/v1\/(threads|messages)\//)).toHaveLength(0);
  });

  test("Karryam onboarding: shared mailbox access with MFA approval, then send-as", async ({ page, api }) => {
    await signIn(page, MAIL_ADMIN);
    defaultMocks(api, MAIL_ADMIN, entitlements({ mailboxes: [], canManageDomains: true, canViewAdministration: true }));
    const KARRYAM = { id: "org-ky", slug: "karryam", name: "Karryam", kind: "BRAND" };
    const INFO = { id: "addr-info", address: "info@karryam.com", kind: "SHARED", status: "ACTIVE" };
    const BOX = { id: "mb-info", organizationId: KARRYAM.id, type: "SHARED", purpose: "GENERAL", name: "Karryam", status: "ACTIVE", owner: null, addresses: [INFO], memberCount: 0, createdAt: NOW };
    const SENDER = { id: "u-sender", name: "Sade Sender", email: "sade@karryam.example", department: "Operations" };
    const members: Array<Record<string, unknown>> = [];
    const grants: Array<Record<string, unknown>> = [];
    api
      .on("GET", `${M}/admin/organizations`, ok([KARRYAM]))
      .on("GET", `${M}/admin/domains`, ok([]))
      .on("GET", `${M}/admin/mailboxes`, () => ok([{ ...BOX, memberCount: members.length }]))
      .on("GET", `${M}/directory/staff`, ok([SENDER]))
      .on("GET", `${M}/mailboxes/:id/members`, () => ok(members))
      .on("POST", `${M}/security/step-up`, ok({ stepUpId: "su-member", expiresAt: "2026-10-24T09:05:00Z" }))
      .on("POST", `${M}/mailboxes/:id/members`, (req) => {
        const body = req.postDataJSON() as Record<string, unknown>;
        members.push({ id: "mem-1", adminUserId: body.adminUserId, name: SENDER.name, email: SENDER.email, role: body.role, canSend: body.canSend });
        return { status: 201, body: { success: true, data: members[0] } };
      })
      .on("GET", `${M}/admin/sender-grants`, () => ok(grants))
      .on("POST", `${M}/admin/sender-grants`, (req) => {
        const body = req.postDataJSON() as Record<string, unknown>;
        grants.push({ id: "g-1", mailbox: { id: body.mailboxId, name: BOX.name }, address: INFO, member: { id: body.adminUserId, name: SENDER.name, email: SENDER.email }, grantedBy: MAIL_ADMIN.id, expiresAt: null, createdAt: NOW });
        return { status: 201, body: { success: true, data: grants[0] } };
      });

    await openMailAdministration(page, api);

    // 1. Mailbox access: a different administrator grants membership; MFA first.
    await page.getByRole("tab", { name: "Mailbox access" }).click();
    await page.getByRole("combobox", { name: "Shared mailbox", exact: true }).selectOption({ label: "Karryam" });
    await page.getByRole("combobox", { name: "Search staff by name or email" }).fill("Sade");
    await page.getByRole("option", { name: /Sade Sender/ }).click();
    await page.getByRole("button", { name: "Grant access (requires MFA)" }).click();
    expect(api.callsTo("POST", `${M}/mailboxes/mb-info/members`), "nothing granted before MFA").toHaveLength(0);
    const dialog = page.getByRole("dialog", { name: "Approve shared mailbox access" });
    await dialog.getByLabel("Authentication code").fill("123456");
    await dialog.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Mailbox access granted" })).toBeVisible();
    expect(api.callsTo("POST", `${M}/security/step-up`)[0].body).toEqual({ code: "123456", purpose: "MAIL_MEMBERSHIP_GRANT" });
    expect(api.callsTo("POST", `${M}/mailboxes/mb-info/members`)[0].body).toEqual({ adminUserId: SENDER.id, role: "MEMBER", canSend: true, stepUpId: "su-member" });
    await expect(page.getByRole("cell", { name: "Sade Sender" })).toBeVisible();

    // 2. Send-as: the member may now send as info@karryam.com.
    await page.getByRole("tab", { name: "Send-as grants" }).click();
    await page.getByRole("combobox", { name: "Shared mailbox", exact: true }).selectOption({ label: "Karryam" });
    await page.getByRole("combobox", { name: "Sender address", exact: true }).selectOption({ label: "info@karryam.com" });
    await page.getByRole("combobox", { name: "Search staff by name or email" }).fill("Sade");
    await page.getByRole("option", { name: /Sade Sender/ }).click();
    await page.getByRole("button", { name: "Grant send-as permission" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Send-as permission granted." })).toBeVisible();
    await expect(page.getByRole("cell", { name: "info@karryam.com" })).toBeVisible();
    expect(api.callsTo("POST", `${M}/admin/sender-grants`)[0].body).toEqual({ mailboxId: "mb-info", addressId: "addr-info", adminUserId: SENDER.id });

    // No private mailbox content is requested by the administration flow.
    expect(api.callsTo("GET", /\/api\/mail\/v1\/(threads|messages)\//)).toHaveLength(0);
  });

  test("read-only administrators see data but no change controls", async ({ page, api }) => {
    await signIn(page, MAIL_ADMIN);
    defaultMocks(api, MAIL_ADMIN, entitlements({ mailboxes: [], canManageDomains: false, canViewAdministration: true }));
    api.on("GET", `${M}/admin/organizations`, ok([ORG])).on("GET", `${M}/admin/domains`, ok([DOMAIN]));
    await openMailAdministration(page, api);
    await expect(page.getByText("Read-only")).toBeVisible();
    await expect(page.getByRole("cell", { name: "cosmicforge.example" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check DNS" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Register domain" })).toHaveCount(0);
  });

  test("an ordinary employee gets an explanation and no admin API calls", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    // Employees without an IT grant are stopped by the dashboard section gate.
    await page.goto("/dashboard/it");
    await expect(page.getByRole("heading", { name: "You do not have access to this section" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mail Administration" })).toHaveCount(0);
    expect(api.callsTo("GET", /\/api\/mail\/v1\/admin\//)).toHaveLength(0);
  });

  test("Mail switched off or not yet migrated is explained, not shown as an error", async ({ page, api }) => {
    await signIn(page, MAIL_ADMIN);
    defaultMocks(api, MAIL_ADMIN);
    api.on("GET", `${M}/me/entitlements`, fail(503, "MAIL_SCHEMA_NOT_READY", "CosmicForge Mail is not ready: its database migrations have not been applied."));
    await openMailAdministration(page, api);
    await expect(page.getByRole("status").filter({ hasText: /not ready|unavailable|disabled|turned off/i }).first()).toBeVisible();
    expect(api.callsTo("GET", /\/api\/mail\/v1\/admin\//)).toHaveLength(0);
  });
});

test.describe("HR > Accounts mailbox request", () => {
  test.skip(({ isMobile }) => !!isMobile, "HR sub-navigation is covered on desktop");

  function hrMocks(api: import("./fixtures").MockApi, ents: Record<string, unknown>) {
    const account = { id: "u-new", employeeCode: "EMP-9", name: "Ada Okafor", email: "ada.personal@example.org", phone: null, personalPhone: null, employmentDate: NOW, position: "Analyst", jobTitle: null, designation: null, department: "FINANCE", location: null, headOfDepartment: null, employmentType: null, employmentCategory: null, tier: "EMPLOYEE", status: "PENDING", sectionGrants: [] };
    defaultMocks(api, HR_USER, entitlements({ mailboxes: [], canProvision: true, ...ents }));
    api
      .on("GET", "/api/hrm/accounts", ok({ accounts: [{ ...account, avatarUrl: null }], meta: { page: 1, limit: 20, total: 1, totalPages: 1 } }))
      .on("GET", "/api/hrm/accounts/u-new", ok(account))
      .on("GET", "/api/hrm/accounts/u-new/grants", ok([]));
  }

  async function openAccount(page: import("@playwright/test").Page) {
    await page.goto("/dashboard/hr");
    await page.getByRole("button", { name: "Accounts" }).first().click();
    await page.getByText("Ada Okafor").first().click();
    await expect(page.getByText("Account Classification")).toBeVisible();
  }

  test("HR requests a mailbox for a new employee; IT approves it later", async ({ page, api }) => {
    await signIn(page, HR_USER);
    hrMocks(api, {});
    let created = false;
    api
      .on("GET", `${M}/provisioning/requests`, () => ok(created ? [{ ...REQUEST, requestedByAdminUserId: HR_USER.id }] : []))
      .on("POST", `${M}/provisioning/requests`, () => { created = true; return { status: 201, body: { success: true, data: REQUEST } }; });
    await openAccount(page);
    await expect(page.getByRole("heading", { name: "Work email (CosmicForge Mail)" })).toBeVisible();
    await page.getByLabel("Requested address").fill("ada.okafor@cosmicforge.example");
    await page.getByLabel("Note for IT (optional)").fill("New starter");
    await page.getByRole("button", { name: "Request mailbox" }).click();
    await expect(page.getByText("Waiting for IT approval")).toBeVisible();
    const [call] = api.callsTo("POST", `${M}/provisioning/requests`);
    expect(call.body).toEqual({ type: "PERSONAL_MAILBOX", requestedAddress: "ada.okafor@cosmicforge.example", subjectAdminUserId: "u-new", justification: "New starter" });
    await expect(page.getByRole("button", { name: "Request mailbox" })).toHaveCount(0);
  });

  test("an unregistered domain is explained", async ({ page, api }) => {
    await signIn(page, HR_USER);
    hrMocks(api, {});
    api
      .on("GET", `${M}/provisioning/requests`, ok([]))
      .on("POST", `${M}/provisioning/requests`, fail(400, "MAIL_VALIDATION_FAILED", "Check your details.", [{ field: "requestedAddress", reason: "DOMAIN_NOT_REGISTERED" }]));
    await openAccount(page);
    await page.getByLabel("Requested address").fill("ada@unknown.example");
    await page.getByRole("button", { name: "Request mailbox" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "not registered with CosmicForge Mail" })).toBeVisible();
  });

  test("the card is absent when Mail is off", async ({ page, api }) => {
    await signIn(page, REVIEWER);
    hrMocks(api, { mailEnabled: false });
    await openAccount(page);
    await expect(page.getByRole("heading", { name: "Work email (CosmicForge Mail)" })).toHaveCount(0);
    expect(api.callsTo("GET", `${M}/provisioning/requests`)).toHaveLength(0);
  });
});
