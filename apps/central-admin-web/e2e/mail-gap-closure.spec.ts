import { test, expect, signIn, defaultMocks, entitlements, gotoWithEntitlements, mailbox, message, thread, noHorizontalScroll, ok, fail, ALICE, type E2EUser } from "./fixtures";

// Specification gap closure UI: filters, forwarding requests, sender
// authentication warnings, original headers, IT forwarding approvals and the
// public account setup page (no emailed passwords).

const M = "/api/mail/v1";
const NOW = "2026-10-24T09:00:00.000Z";
const MAIL_ADMIN: E2EUser = { id: "u-it", name: "Ife IT", email: "ife@cosmicforge.example", tier: "ADMIN", department: "IT", isTeamLead: false };

function rule(overrides: Record<string, unknown> = {}) {
  return { id: "rule-1", mailboxId: "mb-alice", name: "Invoices", enabled: true, priority: 10, conditions: { subjectContains: "invoice" }, actions: { folder: "ARCHIVE" }, createdAt: NOW, updatedAt: NOW, ...overrides };
}

test.describe("Mail filters and forwarding (settings)", () => {
  test("an owner creates, toggles, reorders and deletes filters with safe, fixed operators", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    let rules = [rule(), rule({ id: "rule-2", name: "Newsletters", priority: 20, conditions: { fromContains: "news" }, actions: { markRead: true } })];
    api
      .on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [], signatureHtml: null }))
      .on("GET", `${M}/mailboxes/:id/labels`, ok([{ id: "lab-1", name: "Finance", color: "#272EA7" }]))
      .on("GET", `${M}/mailboxes/mb-alice/forwarding`, ok([]))
      .on("GET", `${M}/provisioning/requests`, ok([]))
      .on("GET", `${M}/mailboxes/mb-alice/rules`, () => ok(rules))
      .on("POST", `${M}/mailboxes/mb-alice/rules`, (req) => {
        const created = rule({ id: "rule-3", ...(req.postDataJSON() as Record<string, unknown>), priority: 100 });
        rules = [...rules, created];
        return { status: 201, body: { success: true, data: created } };
      })
      .on("PATCH", `${M}/rules/:id`, (req, _url, match) => {
        rules = rules.map((r) => (r.id === match[1] ? { ...r, ...(req.postDataJSON() as Record<string, unknown>) } : r));
        return ok(rules.find((r) => r.id === match[1])!);
      })
      .on("POST", `${M}/mailboxes/mb-alice/rules/reorder`, (req) => {
        const ids = (req.postDataJSON() as { ruleIds: string[] }).ruleIds;
        rules = ids.map((id, index) => ({ ...rules.find((r) => r.id === id)!, priority: (index + 1) * 10 }));
        return ok(rules);
      })
      .on("DELETE", `${M}/rules/:id`, (_req, _url, match) => { rules = rules.filter((r) => r.id !== match[1]); return ok({ deleted: true }); });

    await gotoWithEntitlements(page, "/dashboard/mail/settings?mailboxId=mb-alice");
    const filters = page.getByRole("region", { name: "Filters" });
    await expect(filters.getByText('If subject contains "invoice", then move to archive.')).toBeVisible();

    await filters.getByLabel("Filter name").fill("Supplier");
    const create = filters.getByRole("button", { name: "Create filter" });
    await expect(create, "needs a condition and an action").toBeDisabled();
    await filters.getByLabel("From contains").fill("supplier.example");
    await filters.getByLabel("Apply label").selectOption("lab-1");
    await filters.getByLabel("Mark as read").check();
    await create.click();
    await expect.poll(() => api.callsTo("POST", `${M}/mailboxes/mb-alice/rules`).length).toBe(1);
    expect(api.callsTo("POST", `${M}/mailboxes/mb-alice/rules`)[0].body).toEqual({ name: "Supplier", conditions: { fromContains: "supplier.example" }, actions: { labelId: "lab-1", markRead: true } });

    await filters.getByRole("button", { name: "Move Newsletters up" }).click();
    await expect.poll(() => api.callsTo("POST", `${M}/mailboxes/mb-alice/rules/reorder`).length).toBe(1);
    expect(api.callsTo("POST", `${M}/mailboxes/mb-alice/rules/reorder`)[0].body).toEqual({ ruleIds: ["rule-2", "rule-1", "rule-3"] });

    await filters.getByLabel("Invoices enabled").uncheck();
    await expect.poll(() => api.callsTo("PATCH", `${M}/rules/rule-1`).length).toBe(1);
    expect(api.callsTo("PATCH", `${M}/rules/rule-1`)[0].body).toEqual({ enabled: false });

    page.once("dialog", (d) => void d.accept());
    await filters.getByRole("button", { name: "Delete Invoices" }).click();
    await expect.poll(() => api.callsTo("DELETE", `${M}/rules/rule-1`).length).toBe(1);
    await noHorizontalScroll(page);
  });

  test("forwarding is a request that needs approval; policy refusals are explained", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    let forwarding: Record<string, unknown>[] = [];
    api
      .on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [], signatureHtml: null }))
      .on("GET", `${M}/mailboxes/mb-alice/rules`, ok([]))
      .on("GET", `${M}/provisioning/requests`, ok([]))
      .on("GET", `${M}/mailboxes/mb-alice/forwarding`, () => ok(forwarding))
      .on("POST", `${M}/mailboxes/mb-alice/forwarding`, (req) => {
        const body = req.postDataJSON() as { targetAddress: string; reason: string };
        if (body.targetAddress.endsWith("@gmail.example")) return fail(422, "MAIL_FORWARDING_NOT_ALLOWED", "Forwarding to this address is not allowed by policy.", [{ code: "MAIL_FORWARDING_NOT_ALLOWED", reason: "EXTERNAL_DOMAIN_NOT_ALLOWED" }]);
        const created = { id: "fw-1", mailboxId: "mb-alice", targetAddress: body.targetAddress, targetKind: "EXTERNAL", status: "PENDING_APPROVAL", reason: body.reason, requestedBy: ALICE.id, requestedAt: NOW, decidedAt: null, decisionNote: null, disabledAt: null, disabledReason: null, lastForwardedAt: null, forwardedCount: 0 };
        forwarding = [created];
        return { status: 201, body: { success: true, data: created } };
      });
    await gotoWithEntitlements(page, "/dashboard/mail/settings?mailboxId=mb-alice");
    const section = page.getByRole("region", { name: "Forwarding" });
    await section.getByLabel("Forward to").fill("me@gmail.example");
    await section.getByLabel("Business reason").fill("Personal archive");
    await section.getByRole("button", { name: "Request forwarding" }).click();
    await expect(section.getByRole("status")).toHaveText("Forwarding to that domain is not allowed by company policy.");
    await section.getByLabel("Forward to").fill("assistant@partner.example");
    await section.getByRole("button", { name: "Request forwarding" }).click();
    await expect(section.getByText("Waiting for approval")).toBeVisible();
    await expect(section.getByRole("status")).toContainText("A mail administrator must approve it");
  });
});

test.describe("Reading mail", () => {
  test("an unverified sender gets a warning and original headers are shown on request", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api
      .on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [], signatureHtml: null }))
      .on("GET", `${M}/threads/th-1`, ok(thread({ isRead: true })))
      .on("GET", `${M}/threads/th-1/messages`, ok([message({ senderAuthentication: { verdict: "FAIL", reasons: ["DMARC_FAIL"], source: "provider" } })]))
      .on("GET", `${M}/messages/msg-1/original-headers`, ok({ available: true, headers: [{ name: "Received", value: "from mx.partner.example" }, { name: "Authentication-Results", value: "mx; dmarc=fail" }], rawMime: { status: "STORED", sizeBytes: 2048 } }));
    await gotoWithEntitlements(page, "/dashboard/mail/mb-alice/thread/th-1");
    await expect(page.getByRole("alert").filter({ hasText: "the sender could not be verified" })).toContainText("DMARC");
    await page.getByRole("button", { name: "Show original headers" }).click();
    await expect(page.getByText("from mx.partner.example")).toBeVisible();
    await expect(page.getByRole("button", { name: "Download original (.eml)" })).toBeVisible();
    expect(api.callsTo("GET", `${M}/messages/msg-1/original-headers`)).toHaveLength(1);
  });

  test("verified senders show no warning", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    api
      .on("GET", `${M}/mailboxes/mb-alice`, ok({ ...mailbox(), senderIdentities: [], signatureHtml: null }))
      .on("GET", `${M}/threads/th-1`, ok(thread({ isRead: true })))
      .on("GET", `${M}/threads/th-1/messages`, ok([message({ senderAuthentication: { verdict: "PASS", reasons: [], source: "provider" } })]));
    await gotoWithEntitlements(page, "/dashboard/mail/mb-alice/thread/th-1");
    await expect(page.frameLocator("iframe").first().getByText("Please find the numbers attached.")).toBeVisible();
    await expect(page.getByText("the sender could not be verified")).toHaveCount(0);
  });
});

test.describe("IT > Mail Administration > Forwarding & recovery", () => {
  test("external forwarding approval needs a step-up; internal does not", async ({ page, api }) => {
    await signIn(page, MAIL_ADMIN);
    defaultMocks(api, MAIL_ADMIN, entitlements({ mailboxes: [], canManageDomains: true, canViewAdministration: true }));
    api.on("GET", /^\/api\/(telemedicine|rtc|logistics|payments|audit-service|notifications-service)(\/.*)?$/, fail(503, "UNAVAILABLE", "Unavailable in E2E"));
    const base = { mailboxId: "mb-alice", requestedBy: ALICE.id, requestedAt: NOW, decidedAt: null, decisionNote: null, disabledAt: null, disabledReason: null, lastForwardedAt: null, forwardedCount: 0, status: "PENDING_APPROVAL", mailbox: { name: "Alice Ade", type: "PERSONAL" } };
    api
      .on("GET", `${M}/admin/domains`, ok([]))
      .on("GET", `${M}/admin/organizations`, ok([]))
      .on("GET", `${M}/admin/forwarding`, ok([{ ...base, id: "fw-ext", targetAddress: "assistant@partner.example", targetKind: "EXTERNAL", reason: "Travel" }, { ...base, id: "fw-int", targetAddress: "bob@cosmicforge.example", targetKind: "INTERNAL", reason: "Leave cover" }]))
      .on("GET", `${M}/admin/search-index`, ok({ enabled: true, unindexed: 3, oldestUnindexedAt: NOW, staleKeyVersion: 0, activeKeyVersion: "s1" }))
      .on("GET", `${M}/admin/jobs`, ok([{ id: "job-1", queue: "INBOUND", kind: "PROCESS_INBOUND", status: "DEAD_LETTER", attemptCount: 6, maxAttempts: 6, lastErrorCode: "PROVIDER_TIMEOUT", updatedAt: NOW }]))
      .on("POST", `${M}/admin/forwarding/:id/approve`, (_req, _url, match) => ok({ ...base, id: match[1], status: "ACTIVE", targetAddress: "x", targetKind: "INTERNAL", reason: "x" }))
      .on("POST", `${M}/security/step-up`, ok({ stepUpId: "su-fwd", expiresAt: "2026-10-25T09:05:00Z" }));
    await page.goto("/dashboard/it");
    await page.getByRole("button", { name: "Mail Administration" }).first().click();
    await page.getByRole("tab", { name: "Forwarding & recovery" }).click();
    const rows = page.getByRole("table", { name: "Forwarding requests" }).getByRole("row");
    await rows.filter({ hasText: "bob@cosmicforge.example" }).getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => api.callsTo("POST", `${M}/admin/forwarding/fw-int/approve`).length).toBe(1);
    expect(api.callsTo("POST", `${M}/security/step-up`)).toHaveLength(0);
    await rows.filter({ hasText: "assistant@partner.example" }).getByRole("button", { name: "Approve" }).click();
    expect(api.callsTo("POST", `${M}/admin/forwarding/fw-ext/approve`), "nothing sent before the step-up").toHaveLength(0);
    await page.getByRole("dialog").getByLabel("Authentication code").fill("123456");
    await page.getByRole("dialog").getByRole("button", { name: "Verify" }).click();
    await expect.poll(() => api.callsTo("POST", `${M}/admin/forwarding/fw-ext/approve`).length).toBe(1);
    expect(api.callsTo("POST", `${M}/admin/forwarding/fw-ext/approve`)[0].body).toEqual({ stepUpId: "su-fwd" });
    expect(api.callsTo("POST", `${M}/security/step-up`)[0].body).toEqual({ code: "123456", purpose: "MAIL_FORWARDING_APPROVE" });
    await expect(page.getByText("Messages waiting to be indexed:")).toContainText("3");
    await expect(page.getByRole("table", { name: "Dead-lettered jobs" }).getByRole("button", { name: "Retry" })).toBeVisible();
  });
});

test.describe("Account setup links (no emailed passwords)", () => {
  test("a valid link sets the password once and the secret leaves the address bar", async ({ page, api }) => {
    const token = "11111111-2222-4333-8444-555555555555.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
    api
      .on("POST", "/api/auth/account-setup/inspect", ok({ purpose: "ADMIN_INVITE", email: "n******@cosmicforge.example", name: "New Hire", expiresAt: "2026-10-26T09:00:00.000Z", loginUrl: null }))
      .on("POST", "/api/auth/account-setup/complete", ok({ purpose: "ADMIN_INVITE", loginUrl: null }));
    await page.goto(`/account-setup#token=${encodeURIComponent(token)}`);
    await expect(page.getByRole("heading", { name: "Accept your invitation" })).toBeVisible();
    expect(page.url()).not.toContain(token);
    expect(api.callsTo("POST", "/api/auth/account-setup/inspect")[0].body).toEqual({ token });
    await page.getByLabel("New password").fill("weak");
    await page.getByLabel("Confirm password").fill("weak");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Password must" })).toContainText("at least 8 characters");
    expect(api.callsTo("POST", "/api/auth/account-setup/complete")).toHaveLength(0);
    await page.getByLabel("New password").fill("Str0ng!Passw0rd");
    await page.getByLabel("Confirm password").fill("Str0ng!Passw0rd");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByRole("status")).toContainText("Your password is set.");
    expect(api.callsTo("POST", "/api/auth/account-setup/complete")[0].body).toEqual({ token, password: "Str0ng!Passw0rd" });
  });

  test("an expired or reused link explains what to do", async ({ page, api }) => {
    api.on("POST", "/api/auth/account-setup/inspect", fail(400, "ACCOUNT_SETUP_LINK_INVALID", "This link is invalid or has expired. Ask your administrator for a new one."));
    await page.goto("/account-setup#token=11111111-2222-4333-8444-555555555555.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ");
    await expect(page.getByRole("alert").filter({ hasText: "link" })).toContainText("Ask your administrator for a new one");
    await expect(page.getByRole("button", { name: "Set password" })).toHaveCount(0);
  });
});
