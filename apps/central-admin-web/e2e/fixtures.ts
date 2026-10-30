import { test as base, expect, type Page, type Request, type Route, type TestInfo } from "@playwright/test";

export const API_ORIGIN = "http://localhost:4999";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;
export interface MockReply {
  status?: number;
  body: Json;
}
export type MockHandler = (req: Request, url: URL, match: RegExpMatchArray) => MockReply | Promise<MockReply>;

export const ok = (data: Json, meta?: Record<string, unknown>): MockReply => ({
  status: 200,
  body: { success: true, data, ...(meta ? { meta } : {}) },
});
export const accepted = (data: Json): MockReply => ({ status: 202, body: { success: true, data } });
export const fail = (status: number, code: string, message: string, errors: unknown[] = []): MockReply => ({
  status,
  body: { success: false, code, message, errors },
});

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

export class MockApi {
  private handlers: Array<{ method: string; pattern: RegExp; handler: MockHandler }> = [];
  readonly calls: RecordedCall[] = [];
  readonly unmatched: string[] = [];
  readonly blockedExternal: string[] = [];

  /** Later registrations win, so a spec can override a default. */
  on(method: string, path: string | RegExp, handler: MockHandler | MockReply) {
    const pattern = typeof path === "string" ? new RegExp(`^${path.replace(/:[a-zA-Z]+/g, "([^/]+)")}$`) : path;
    const fn: MockHandler = typeof handler === "function" ? handler : () => handler;
    this.handlers.unshift({ method: method.toUpperCase(), pattern, handler: fn });
    return this;
  }

  callsTo(method: string, path: string | RegExp) {
    return this.calls.filter((c) => c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path)));
  }

  async install(page: Page) {
    await page.context().route("**/*", async (route: Route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin === API_ORIGIN) return this.dispatch(route, req, url);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return route.continue();
      if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
      // Never reach the internet (fonts, analytics, remote images, providers).
      this.blockedExternal.push(url.href);
      return route.abort("blockedbyclient");
    });
  }

  private async dispatch(route: Route, req: Request, url: URL) {
    const method = req.method();
    const headers = { "access-control-allow-origin": "http://localhost:" + (process.env.E2E_PORT || "3100"), "access-control-allow-credentials": "true" };
    if (method === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: { ...headers, "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE", "access-control-allow-headers": "Authorization,Content-Type,Idempotency-Key" },
      });
    }
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    this.calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers() });
    for (const h of this.handlers) {
      if (h.method !== method && h.method !== "*") continue;
      const match = url.pathname.match(h.pattern);
      if (!match) continue;
      const reply = await h.handler(req, url, match);
      return route.fulfill({ status: reply.status ?? 200, headers, contentType: "application/json", body: JSON.stringify(reply.body) });
    }
    this.unmatched.push(`${method} ${url.pathname}`);
    return route.fulfill({ status: 404, headers, contentType: "application/json", body: JSON.stringify({ success: false, code: "E2E_UNMOCKED", message: `Unmocked ${method} ${url.pathname}` }) });
  }
}

// ── Users ────────────────────────────────────────────────────────────────
export interface E2EUser {
  id: string;
  name: string;
  email: string;
  tier: string;
  department: string;
  isTeamLead: boolean;
}
export const ALICE: E2EUser = { id: "u-alice", name: "Alice Ade", email: "alice@cosmicforge.example", tier: "EMPLOYEE", department: "Operations", isTeamLead: false };
export const SUPER_USER: E2EUser = { id: "u-super", name: "Sam Super", email: "super@cosmicforge.example", tier: "SUPER", department: "Executive", isTeamLead: false };
export const REVIEWER: E2EUser = { id: "u-rev", name: "Rita Reviewer", email: "rita@cosmicforge.example", tier: "ADMIN", department: "Marketing", isTeamLead: true };

export async function signIn(page: Page, user: E2EUser) {
  const token = `e2e-token-${user.id}`;
  await page.context().addCookies([{ name: "accessToken", value: token, url: "http://localhost:" + (process.env.E2E_PORT || "3100") }]);
  await page.addInitScript(
    ([t, u]) => {
      window.localStorage.setItem("accessToken", t as string);
      window.localStorage.setItem("auth-storage", JSON.stringify({ state: { user: u, accessToken: t, mustChangePassword: false }, version: 0 }));
    },
    [token, user] as const,
  );
}

// ── Mail fixtures ────────────────────────────────────────────────────────
const ORG = { id: "org-cf", slug: "cosmicforge", name: "CosmicForge" };
const NOW = "2026-10-24T09:00:00.000Z";

export function mailbox(overrides: Record<string, unknown> = {}) {
  return {
    id: "mb-alice",
    name: "Alice Ade",
    type: "PERSONAL",
    purpose: "GENERAL",
    role: "OWNER",
    canSend: true,
    primaryAddress: "alice@cosmicforge.example",
    unreadCount: 1,
    status: "ACTIVE",
    organization: ORG,
    ...overrides,
  };
}
/** GET /support/mailboxes row (queue counts, not unread counts). */
export function supportMailboxSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "mb-support",
    name: "Support",
    role: "MEMBER",
    canSend: true,
    primaryAddress: "support@cosmicforge.example",
    signatureHtml: null,
    slaFirstResponseMinutes: 60,
    supportTicketLinkEnabled: true,
    openCount: 3,
    overdueCount: 1,
    organization: ORG,
    ...overrides,
  };
}

/** GET /api/hrm/accounts/me/grants (the signed-in user's own active grants). */
export function myGrants(tier: string, grants: { module: string; section: string; mode?: string }[] = []) {
  return { tier, grants: grants.map((grant) => ({ mode: "VIEW", expiresAt: null, ...grant })) };
}

export const SUPPORT_MAILBOX = mailbox({ id: "mb-support", name: "Support", type: "SHARED", purpose: "SUPPORT", role: "MEMBER", primaryAddress: "support@cosmicforge.example", unreadCount: 2 });

export function entitlements(overrides: Record<string, unknown> = {}) {
  return {
    mailEnabled: true,
    sendingEnabled: true,
    marketingEnabled: false,
    identityActive: true,
    mailboxes: [mailbox()],
    canManageDomains: false,
    canViewAdministration: false,
    canProvision: true,
    canApproveProvisioning: false,
    canManageSharedMembership: false,
    marketing: [],
    ...overrides,
  };
}

export function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: "th-1",
    mailboxId: "mb-alice",
    subject: "Quarterly figures",
    snippet: "Please find the numbers attached",
    folder: "INBOX",
    lastMessageAt: NOW,
    messageCount: 1,
    participants: [{ address: "partner@partner.example", name: "Pat Partner" }],
    isRead: false,
    isStarred: false,
    hasAttachments: false,
    labels: [],
    conversationStatus: null,
    assignedTo: null,
    slaDueAt: null,
    lastDeliveryStatus: null,
    revision: 1,
    lockedBy: null,
    lockExpiresAt: null,
    supportTicketRef: null,
    ...overrides,
  };
}

export function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    threadId: "th-1",
    mailboxId: "mb-alice",
    direction: "INBOUND",
    status: "RECEIVED",
    subject: "Quarterly figures",
    from: { address: "partner@partner.example", name: "Pat Partner" },
    replyTo: null,
    recipients: [{ address: "alice@cosmicforge.example", name: "Alice Ade", type: "TO", status: "RECEIVED" }],
    sentAt: null,
    receivedAt: NOW,
    createdAt: NOW,
    html: "<p>Please find the numbers attached.</p>",
    text: "Please find the numbers attached.",
    remoteImagesBlocked: 0,
    attachments: [],
    sentBy: null,
    deliveryEvents: [],
    quarantineReason: null,
    ...overrides,
  };
}

export function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: "dr-1",
    mailboxId: "mb-alice",
    mode: "NEW",
    threadId: null,
    inReplyToMessageId: null,
    senderAddressId: null,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    html: "",
    text: "",
    revision: 1,
    status: "ACTIVE",
    attachments: [],
    updatedAt: NOW,
    ...overrides,
  };
}

export const ALICE_IDENTITY = { addressId: "addr-alice", address: "alice@cosmicforge.example", displayName: "Alice Ade", kind: "PRIMARY" };

/** GET /me/preferences (spec 15): defaults, migration 36 applied. */
export function preferences(overrides: Record<string, unknown> = {}) {
  return { available: true, notificationsEnabled: true, defaultSenderAddressId: null, senderOptions: [], updatedAt: null, ...overrides };
}

/** Harmless defaults for the dashboard shell and an ordinary Mail user. */
export function defaultMocks(api: MockApi, user: E2EUser, ents: Record<string, unknown> = entitlements()) {
  const M = "/api/mail/v1";
  api
    .on("*", /^\/api\/(?!mail\/).*/, ok(null))
    .on("GET", /^\/api\/(profile|users\/me|auth\/me|admin\/me).*/, ok({ ...user, avatarUrl: null }))
    .on("POST", "/api/auth/refresh-token", fail(401, "UNAUTHORIZED", "expired"))
    .on("GET", "/api/hrm/accounts/me/grants", ok(myGrants(user.tier)))
    .on("GET", `${M}/me/entitlements`, ok(ents))
    .on("GET", `${M}/me/mailboxes`, ok((ents as { mailboxes: unknown[] }).mailboxes))
    .on("GET", `${M}/me/preferences`, ok(preferences()))
    .on("GET", `${M}/mailboxes/:id/threads`, ok([], { nextCursor: null }))
    .on("GET", `${M}/mailboxes/:id/labels`, ok([]))
    .on("GET", `${M}/mailboxes/:id/drafts`, ok([], { nextCursor: null }))
    .on("GET", `${M}/contacts/suggest`, ok([]));
  return api;
}

export const test = base.extend<{ api: MockApi }>({
  api: async ({ page }, provide, testInfo) => {
    const api = new MockApi();
    await api.install(page);
    await provide(api);
    if (api.unmatched.length) await testInfo.attach("unmocked-api-calls", { body: api.unmatched.join("\n") });
    if (api.blockedExternal.length) await testInfo.attach("blocked-external-requests", { body: api.blockedExternal.join("\n") });
  },
});

export { expect };

export async function noHorizontalScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.scrollingElement?.scrollWidth ?? 0,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, "no horizontal page scroll").toBeLessThanOrEqual(innerWidth + 1);
}

/** Save deterministic, synthetic UI evidence as a Playwright artifact. */
export async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}-${testInfo.project.name}.png`);
  // Capture the actual viewport: full-page stitching relocates sticky dashboard
  // navigation into the middle of long-page screenshots and misrepresents UX.
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(`${name}-${testInfo.project.name}`, { path, contentType: "image/png" });
}

/** Navigate and wait until the entitlement response has been delivered, so
 * "hidden" assertions cannot pass merely because data has not loaded yet. */
export async function gotoWithEntitlements(page: Page, path: string) {
  const loaded = page.waitForResponse((r) => r.url().endsWith("/api/mail/v1/me/entitlements"));
  await page.goto(path);
  await loaded;
  // One more frame for React Query to commit the result.
  await page.waitForTimeout(250);
}
