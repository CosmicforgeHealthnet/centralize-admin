import { test, expect, signIn, defaultMocks, entitlements, gotoWithEntitlements, ok, fail, SUPER_USER, type E2EUser, type MockApi } from "./fixtures";

// Final gaps 5/6: IT > Mail Administration > Quarantine and the Mail
// operations storage deletion queue. API fully mocked. The quarantine UI shows
// safe metadata only and never requests mailbox content.

const M = "/api/mail/v1";
const NOW = "2026-10-24T09:00:00.000Z";
const MAIL_ADMIN: E2EUser = { id: "u-it", name: "Ife IT", email: "ife@cosmicforge.example", tier: "ADMIN", department: "IT", isTeamLead: false };
const ORG = { id: "org-cf", name: "CosmicForge" };
const MAILBOX = { id: "mb-dave", name: "Dave Doe" };

const actions = (overrides: Record<string, unknown> = {}) => ({ available: true, canRelease: true, releaseBlockers: [], releaseNeedsStepUp: true, canDelete: true, ...overrides });
const SPOOF = {
  id: "msg-spoof", kind: "MESSAGE", source: "INBOUND", status: "QUARANTINED", mailbox: MAILBOX, organization: ORG, receivedAt: NOW, sizeBytes: 2048,
  sender: { domain: "cosmicforge.example", masked: "c***@cosmicforge.example", hash: "a1b2c3d4e5f6" }, reason: "INTERNAL_DOMAIN_SPOOF", reasonCategory: "AUTH_POLICY", authVerdict: "FAIL",
  attachmentCount: 1, attachments: [{ id: "att-pack", filename: "pack.txt", contentType: "text/plain", sizeBytes: 10, scanStatus: "CLEAN", scanDetail: null, reasonCategory: "POLICY", removed: false }],
  actions: actions(),
};
const INFECTED = {
  ...SPOOF, id: "msg-infected", sender: { domain: "partner.example", masked: "b***@partner.example", hash: "ffeeddccbbaa" }, reason: "MALICIOUS_ATTACHMENT", reasonCategory: "MALWARE", authVerdict: null,
  attachments: [{ id: "att-eicar", filename: "invoice.txt", contentType: "text/plain", sizeBytes: 68, scanStatus: "INFECTED", scanDetail: "Eicar-Signature", reasonCategory: "MALWARE", removed: false }],
  actions: actions({ canRelease: false, releaseBlockers: ["MALWARE_NEVER_RELEASABLE", "INFECTED_ATTACHMENT", "ATTACHMENT_NOT_CLEAN"] }),
};

async function openQuarantine(page: import("@playwright/test").Page, api: MockApi) {
  api.on("GET", /^\/api\/(telemedicine|rtc|logistics|payments|audit-service|notifications-service)(\/.*)?$/, fail(503, "UNAVAILABLE", "Unavailable in E2E"));
  await page.goto("/dashboard/it");
  await page.getByRole("button", { name: "Mail Administration" }).first().click();
  await expect(page.getByRole("heading", { name: "Mail Administration" })).toBeVisible();
  await page.getByRole("tab", { name: "Quarantine" }).click();
}

function adminMocks(api: MockApi, { canEdit = true, items = [SPOOF, INFECTED] }: { canEdit?: boolean; items?: Record<string, unknown>[] } = {}) {
  defaultMocks(api, MAIL_ADMIN, entitlements({ mailboxes: [], canManageDomains: canEdit, canViewAdministration: true }));
  api
    .on("GET", `${M}/admin/organizations`, ok([{ ...ORG, slug: "cosmicforge", kind: "BRAND" }]))
    .on("GET", `${M}/admin/domains`, ok([]))
    .on("GET", `${M}/admin/mailboxes`, ok([{ ...MAILBOX, type: "PERSONAL", status: "ACTIVE", addresses: [], memberCount: 1 }]))
    .on("GET", `${M}/admin/quarantine`, (_req, url) => {
      const category = url.searchParams.get("category");
      const filtered = category ? items.filter((item) => item.reasonCategory === category) : items;
      return ok(filtered, { nextCursor: null });
    })
    .on("GET", `${M}/admin/quarantine/messages/:id`, (_req, _url, match) => ok({ ...(items.find((item) => item.id === match[1]) ?? SPOOF), decisions: [] }));
}

test.describe("IT > Mail Administration > Quarantine", () => {
  test("lists safe metadata, filters, and releases an AUTH_POLICY message with a reason and 2FA", async ({ page, api }) => {
    await signIn(page, MAIL_ADMIN);
    adminMocks(api);
    api
      .on("POST", `${M}/security/step-up`, ok({ stepUpId: "su-release", expiresAt: NOW }))
      .on("POST", `${M}/admin/quarantine/messages/:id/release`, ok({ ...SPOOF, status: "RECEIVED", actions: actions({ canRelease: false, releaseBlockers: ["NOT_QUARANTINED"] }) }));
    await openQuarantine(page, api);

    await expect(page.getByRole("cell", { name: "c***@cosmicforge.example", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "b***@partner.example", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Sender authentication" }).first()).toBeVisible();
    await page.getByRole("combobox", { name: /^Reason/ }).selectOption("MALWARE");
    await expect(page.getByRole("cell", { name: "c***@cosmicforge.example", exact: true })).toHaveCount(0);
    expect(api.callsTo("GET", `${M}/admin/quarantine`).some((call) => call.query.category === "MALWARE")).toBe(true);
    await page.getByRole("combobox", { name: /^Reason/ }).selectOption("");

    await page.getByRole("button", { name: "Review message from c***@cosmicforge.example" }).click();
    const drawer = page.getByRole("dialog", { name: "Quarantined message" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("pack.txt")).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Release…" })).toBeDisabled();
    await drawer.getByLabel(/Reason \(recorded/).fill("Verified with the CEO by phone");
    await drawer.getByRole("button", { name: "Release…" }).click();
    const stepUp = page.getByRole("dialog", { name: /Release message/ });
    await stepUp.getByLabel("Authentication code").fill("123456");
    await stepUp.getByRole("button", { name: "Verify" }).click();
    await expect.poll(() => api.callsTo("POST", `${M}/admin/quarantine/messages/msg-spoof/release`).length).toBe(1);
    expect(api.callsTo("POST", `${M}/security/step-up`)[0].body).toEqual({ code: "123456", purpose: "MAIL_QUARANTINE_RELEASE" });
    expect(api.callsTo("POST", `${M}/admin/quarantine/messages/msg-spoof/release`)[0].body).toEqual({ reason: "Verified with the CEO by phone", stepUpId: "su-release" });
    await expect(page.getByText("Released to the original mailbox.")).toBeVisible();

    // Never any mailbox content: no thread/message reads, no downloads.
    expect(api.callsTo("GET", /\/api\/mail\/v1\/(mailboxes|threads|messages|attachments)\//)).toHaveLength(0);
    expect(api.unmatched.filter((call) => call.includes("/api/mail/"))).toEqual([]);
  });

  test("infected mail shows why it can never be released", async ({ page, api }) => {
    await signIn(page, MAIL_ADMIN);
    adminMocks(api);
    await openQuarantine(page, api);
    await page.getByRole("button", { name: "Review message from b***@partner.example" }).click();
    const drawer = page.getByRole("dialog", { name: "Quarantined message" });
    await expect(drawer.getByText("Malware is never released.")).toBeVisible();
    await drawer.getByLabel(/Reason \(recorded/).fill("Trying anyway");
    await expect(drawer.getByRole("button", { name: "Release…" })).toBeDisabled();
    await expect(drawer.getByRole("button", { name: "Delete…" })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  });

  test("legal hold refusal is explained", async ({ page, api }) => {
    await signIn(page, MAIL_ADMIN);
    adminMocks(api);
    api
      .on("POST", `${M}/security/step-up`, ok({ stepUpId: "su-delete", expiresAt: NOW }))
      .on("POST", `${M}/admin/quarantine/messages/:id/delete`, fail(409, "MAIL_LEGAL_HOLD", "Content is under legal hold.", [{ code: "MAIL_LEGAL_HOLD", reason: "LEGAL_HOLD" }]));
    await openQuarantine(page, api);
    await page.getByRole("button", { name: "Review message from b***@partner.example" }).click();
    const drawer = page.getByRole("dialog", { name: "Quarantined message" });
    await drawer.getByLabel(/Reason \(recorded/).fill("Malware removal");
    await drawer.getByRole("button", { name: "Delete…" }).click();
    await page.getByLabel("Authentication code").fill("654321");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(drawer.getByRole("alert")).toContainText("legal hold");
    expect(api.callsTo("POST", `${M}/security/step-up`)[0].body).toEqual({ code: "654321", purpose: "MAIL_QUARANTINE_DELETE" });
  });

  test("read-only administrators and pre-migration servers get no action controls", async ({ page, api }) => {
    await signIn(page, MAIL_ADMIN);
    adminMocks(api, { canEdit: false, items: [{ ...SPOOF, actions: actions({ available: false, canRelease: false, canDelete: false }) }] });
    await openQuarantine(page, api);
    await page.getByRole("button", { name: "Review message from c***@cosmicforge.example" }).click();
    const drawer = page.getByRole("dialog", { name: "Quarantined message" });
    await expect(drawer.getByText(/Read-only: quarantine actions become available/)).toBeVisible();
    await expect(drawer.getByRole("button", { name: /Release|Reject|Delete/ })).toHaveCount(0);
    await expect(drawer.getByText("No decisions recorded yet.")).toBeVisible();
  });

  test("an empty quarantine and a forbidden caller are shown as states, not errors", async ({ page, api }) => {
    await signIn(page, MAIL_ADMIN);
    adminMocks(api, { items: [] });
    await openQuarantine(page, api);
    await expect(page.getByText("Nothing is in quarantine for these filters.")).toBeVisible();
    api.on("GET", `${M}/admin/quarantine`, fail(403, "MAIL_FORBIDDEN", "You do not have access to this resource.", [{ code: "MAIL_FORBIDDEN", reason: "MAIL_SECTION_ADMIN_REQUIRED" }]));
    await page.getByRole("button", { name: "Attachments", exact: true }).click();
    await expect(page.getByText(/explicit Mail administration grant/)).toBeVisible();
  });
});

test.describe("Mail operations > storage deletion queue", () => {
  const DEAD = { id: "del-1", keyHash: "0123456789abcdef", purpose: "RETENTION", reason: "RETENTION_PURGE", status: "DEAD", attempts: 12, maxAttempts: 12, nextAttemptAt: NOW, lastError: "MAIL_STORAGE_UNAVAILABLE", createdAt: NOW, completedAt: null };
  test("dead deletions are requeued with a reason and 2FA", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    const ADM = `${M}/admin`;
    api
      .on("GET", `${ADM}/ops/snapshot`, ok({ generatedAt: NOW, runtimeHalt: { staffMail: null, marketing: null }, queue: { byStatus: [], oldestDueSeconds: {}, active: 0, deadLetters24h: [] }, webhooks: { backlog: 0, oldestBacklogSeconds: 0, failed24h: 0 }, scanning: { backlog: 0, oldestBacklogSeconds: 0 }, delivery: { staff24h: {}, outcomeUnknown24h: 0 }, retention: {}, openAlerts: [] }))
      .on("GET", `${ADM}/ops/alerts`, ok([]))
      .on("GET", `${ADM}/usage`, ok({ days: 30, since: NOW, summary: [], limits: [], cost: { currency: null, source: null, note: "Counts only." } }))
      .on("GET", `${ADM}/retention/capabilities`, ok({ executionEnabled: false, dryRunValidHours: 24, systemCategories: [] }))
      .on("GET", `${ADM}/retention-policies`, ok([]))
      .on("GET", `${ADM}/retention/runs`, ok([]))
      .on("GET", `${ADM}/storage-deletions`, ok({ counts: { PENDING: 0, RUNNING: 0, DONE: 4, DEAD: 1, CANCELLED: 0 }, due: 0, oldestDueSeconds: 0, items: [DEAD], nextCursor: null }))
      .on("POST", `${M}/security/step-up`, ok({ stepUpId: "su-requeue", expiresAt: NOW }))
      .on("POST", `${ADM}/storage-deletions/:id/requeue`, ok({ ...DEAD, status: "PENDING", attempts: 0 }));
    await gotoWithEntitlements(page, "/dashboard/mail/operations");
    await expect(page.getByRole("heading", { name: "Storage deletion queue" })).toBeVisible();
    await expect(page.getByText("#0123456789abcdef")).toBeVisible();
    const requeue = page.getByRole("button", { name: "Requeue deletion 0123456789abcdef" });
    await expect(requeue).toBeDisabled();
    await page.getByLabel(/Reason for requeue/).fill("Storage is healthy again");
    await requeue.click();
    await page.getByLabel("Authentication code").fill("111222");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect.poll(() => api.callsTo("POST", `${ADM}/storage-deletions/del-1/requeue`).length).toBe(1);
    expect(api.callsTo("POST", `${ADM}/storage-deletions/del-1/requeue`)[0].body).toEqual({ reason: "Storage is healthy again", stepUpId: "su-requeue" });
    expect(api.callsTo("POST", `${M}/security/step-up`)[0].body).toEqual({ code: "111222", purpose: "MAIL_STORAGE_DELETION_REQUEUE" });
    await expect(page.getByText("Deletion requeued.")).toBeVisible();
  });
});
