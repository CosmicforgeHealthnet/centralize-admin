import { test, expect, signIn, defaultMocks, gotoWithEntitlements, noHorizontalScroll, SUPER_USER, ALICE, type MockApi } from "./fixtures";

// CF Meet section (/dashboard/cfmeet). Response shapes follow PIC
// (GET /api/products -> { success, data: { products } }) and the protocol
// envelope served by cfmeet-admin through the product gateway.

const SCOPE = { market: ["GLOBAL"], organization: ["cfmeet"], zone: ["production", "sandbox"], tenant: ["cfmeet-main"] };
const CFMEET = {
  product_id: "cfmeet",
  display_name: "CF Meet",
  available: true,
  reason: null,
  lifecycle_status: "ENABLED",
  contract_revision: 3,
  protocol: { major: 1, minor: 1 },
  effective_scope: SCOPE,
  role: "cfmeet.support",
  capability_states: { READ_ONLY: 4, BLOCKED_DEPENDENCY: 5, DISABLED: 1 },
  datasets: [{ dataset_id: "cfmeet.meetings_daily", title: "Meetings daily", granted: true }],
  navigation: { section: "products", key: "cfmeet", label: "CF Meet" },
};

type Quality = { as_of?: string | null; freshness?: string; coverage?: string };
const env = (result: unknown, q: Quality = {}) => ({
  contract_version: "1.1",
  product_id: "cfmeet",
  correlation_id: "corr-e2e-0001",
  as_of: q.as_of ?? null,
  freshness: q.freshness ?? "UNKNOWN",
  coverage: q.coverage ?? "UNKNOWN",
  result,
  error: null,
});
const envError = (code: string, reason: string, retryable = false) => ({
  contract_version: "1.1", product_id: "cfmeet", correlation_id: "corr-e2e-err", as_of: null, freshness: "UNKNOWN", coverage: "UNKNOWN", result: null, error: { code, reason, retryable },
});

const cap = (id: string, kind: string, state: string, blockers: { code: string; detail: string }[] = [], extra: Record<string, unknown> = {}) => ({
  id, version: "1.0.0", kind, state, risk: "R1", description: id, datasets: [], blockers, requires_recent_mfa: true, requires_independent_approval: false, request_schema: null, ...extra,
});
const map = (id: string, module: string, path: string, exposure: string, codes: string[] = [], kind = "READ") => ({
  bridge_capability_id: id, module, cfmeet_capability_id: kind === "READ" ? `cfmeet.${module}.read` : `cfmeet.${id}`, kind, owner: module, method: "GET",
  bridge_path: `/internal/cfmeet-admin/v1${path}`, permission: id, scope_dimensions: ["market", "organization", "zone", "tenant"], risk: "R1", privacy: "MINIMIZED_METADATA",
  source_state: exposure, exposure_state: exposure, blocker_codes: codes, source_version_required: false, idempotency_required: false,
});
const coll = (collection_id: string, detail: boolean, exposure_state: string) => ({ collection_id, detail, exposure_state, privacy: "MINIMIZED_METADATA", risk: "R1" });

const CAPABILITIES = {
  capabilities: [
    cap("cfmeet.accounts.read", "READ", "BLOCKED_DEPENDENCY", [{ code: "NO_READABLE_SOURCE_CAPABILITY", detail: "Every source collection of this module is blocked or disabled at the source" }]),
    cap("cfmeet.organizations.read", "READ", "READ_ONLY"),
    cap("cfmeet.finance.read", "READ", "BLOCKED_DEPENDENCY", [{ code: "NO_READABLE_SOURCE_CAPABILITY", detail: "Every source collection of this module is blocked or disabled at the source" }]),
    cap("cfmeet.report.finance_usage", "READ", "READ_ONLY", [], { description: "Usage by plan and currency" }),
    cap("cfmeet.report.estimated_charges", "READ", "BLOCKED_DEPENDENCY", [{ code: "SOURCE_BLOCKED_DEPENDENCY", detail: "Phase A6: finance estimates pending" }], { description: "Estimated charges" }),
    cap("cfmeet.report.plan_spread", "READ", "BLOCKED_DEPENDENCY", [{ code: "SOURCE_BLOCKED_DEPENDENCY", detail: "Phase A6: plan spread pending" }], { description: "Plan spread (Free / Pro / Business)" }),
    cap("cfmeet.organizations.organization.suspend", "COMMAND", "DISABLED", [
      { code: "SOURCE_DISABLED", detail: "Phase A4: organizations endpoint exists; bridge wiring pending" },
    ], { risk: "R3", requires_independent_approval: true, description: "POST /organizations/organizations/{organization_id}/suspend (organizations)" }),
  ],
  bridge_contract: { contract: "cfmeet-admin-bridge", contract_version: "1.2.0", source_commit: "568328cca32749e207a1fe0be7f664da6380202c" },
  bridge_live: { state: "READ_ONLY", observed_at: "2026-11-20T08:00:00Z" },
  modules: [
    { module: "accounts", title: "Accounts Administration", read_capability_id: "cfmeet.accounts.read", rules: ["No credentials, MFA secrets or raw contact details"], inventory_capabilities: 3,
      collections: [coll("accounts.users.search", false, "BLOCKED_DEPENDENCY"), coll("accounts.users.read", true, "BLOCKED_DEPENDENCY")], commands: [] },
    { module: "organizations", title: "Organizations Administration", read_capability_id: "cfmeet.organizations.read", rules: ["Strict organization boundaries"], inventory_capabilities: 5,
      collections: [coll("organizations.organizations.search", false, "READ_ONLY"), coll("organizations.organizations.read", true, "READ_ONLY"), coll("organizations.members.list", true, "READ_ONLY"), coll("organizations.global-audit.list", false, "READ_ONLY")],
      commands: ["cfmeet.organizations.organization.suspend"] },
    { module: "finance", title: "Finance Reporting", read_capability_id: "cfmeet.finance.read", rules: ["Minor units per currency; never combined"], inventory_capabilities: 1,
      collections: [coll("finance.usage.report", false, "BLOCKED_DEPENDENCY")], commands: [] },
  ],
  reports: [
    { report_id: "cfmeet.report.finance_usage", kind: "BRIDGE", grain: "WINDOW", units: ["count", "minor_currency"], definition: "Source-released usage cells; money in minor units per currency, never combined across currencies" },
    { report_id: "cfmeet.report.estimated_charges", kind: "BRIDGE", grain: "WINDOW", units: ["minor_currency"], definition: "Source-estimated charges in minor units per currency" },
    { report_id: "cfmeet.report.plan_spread", kind: "BRIDGE", grain: "WINDOW", units: ["count"], definition: "Current plan assignments per plan" },
  ],
  capability_map: [
    map("accounts.users.search", "accounts", "/accounts/users", "BLOCKED_DEPENDENCY", ["SOURCE_BLOCKED_DEPENDENCY"]),
    map("accounts.users.read", "accounts", "/accounts/users/{user_id}", "BLOCKED_DEPENDENCY", ["SOURCE_BLOCKED_DEPENDENCY"]),
    map("organizations.organizations.search", "organizations", "/organizations/organizations", "READ_ONLY"),
    map("organizations.organizations.read", "organizations", "/organizations/organizations/{organization_id}", "READ_ONLY"),
    map("organizations.members.list", "organizations", "/organizations/organizations/{organization_id}/members", "READ_ONLY"),
    map("organizations.global-audit.list", "organizations", "/organizations/audit", "READ_ONLY"),
    map("organizations.organization.suspend", "organizations", "/organizations/organizations/{organization_id}/suspend", "DISABLED", ["SOURCE_DISABLED"], "COMMAND"),
    map("finance.usage.report", "finance", "/finance/usage", "BLOCKED_DEPENDENCY", ["SOURCE_BLOCKED_DEPENDENCY"]),
  ],
};

const DATASETS = {
  contract_revision: 3,
  datasets: [{
    dataset_id: "cfmeet.meetings_daily", version: "1.0.0", privacy_class: "INTERNAL", semantic_grain: "DAY", currency: null, freshness_target_seconds: 86400,
    scope_dimensions: ["market", "organization", "zone", "tenant"],
    metrics: [
      { metric_id: "cfmeet.meetings_daily.meetings_started", version: "1.0.0", unit: "count", currency: null, grain: "DAY", aggregation: "COUNT", definition: "Meetings started per UTC day" },
      { metric_id: "cfmeet.meetings_daily.participants", version: "1.0.0", unit: "count", currency: null, grain: "DAY", aggregation: "COUNT", definition: "Participants joined per UTC day" },
    ],
    synchronization: { coverage: "COMPLETE", gap_status: "NO_GAP", last_source_observation_at: "2026-11-20T06:00:00Z" },
  }],
};

const OBSERVED_AT = "2026-11-20T06:00:00Z";
const org = (n: number) => ({
  organization_id: `0f6b1a2c-0000-4000-8000-00000000000${n}`, name: `Org ${n}`, slug: `org-${n}`, lifecycle_status: "ACTIVE", provisioning_state: "READY",
  member_count: 10 + n, created_at: "2026-10-01T09:00:00Z", updated_at: "2026-11-01T09:00:00Z", version: n,
});
const listRead = (items: unknown[], continuation: string | null, collection_id = "organizations.organizations.search") => ({
  module: "organizations", capability_id: "cfmeet.organizations.read", collection_id, kind: "LIST",
  scope: { market: "GLOBAL", organization: "cfmeet", zone: "production", tenant: "cfmeet-main" },
  filters: { purpose: "support-review", limit: 50, q: null, parent: null, start: null, end: null },
  quality: "LIVE", source_freshness: "LIVE", observed_at: OBSERVED_AT, first_page_observed_at: null, bridge_correlation_id: null,
  data: { items }, continuation,
});

function cfmeetMocks(api: MockApi, products: unknown[] = [CFMEET]) {
  api.on("GET", "/api/products", { body: { success: true, data: { products } } });
  api.on("GET", "/api/products/cfmeet/capabilities", { body: env(CAPABILITIES) });
  api.on("GET", "/api/products/cfmeet/datasets", { body: env(DATASETS) });
  api.on("GET", "/api/products/cfmeet/metrics/cfmeet.meetings_daily.meetings_started", {
    body: env({
      metric: { ...DATASETS.datasets[0].metrics[0], dataset_id: "cfmeet.meetings_daily" },
      scope: { market: "GLOBAL", organization: "cfmeet", zone: "production", tenant: "cfmeet-main" },
      observations: [{ window_start: "2026-11-19T00:00:00Z", window_end: "2026-11-20T00:00:00Z", grain: "DAY", unit: "count", currency: null, value: 1284, value_state: "OBSERVED",
        source_observed_at: OBSERVED_AT, freshness: "FRESH", coverage: "COMPLETE", source_entity_version: 4, projection_version: 1, contract_revision: 3 }],
    }, { as_of: OBSERVED_AT, freshness: "FRESH", coverage: "COMPLETE" }),
  });
  api.on("GET", "/api/products/cfmeet/metrics/cfmeet.meetings_daily.participants", { status: 503, body: envError("UNAVAILABLE", "NO_SOURCE_OBSERVATION") });
  api.on("GET", /^\/api\/products\/cfmeet\/resources\/cfmeet\.organizations\.read\/organizations\.organizations\.search$/, (req, url) => {
    const c = url.searchParams.get("continuation");
    return c === "page2-token-abcdefghij"
      ? { body: env(listRead([org(3)], null), { as_of: OBSERVED_AT, freshness: "FRESH", coverage: "COMPLETE" }) }
      : { body: env(listRead([org(1), org(2)], "page2-token-abcdefghij"), { as_of: OBSERVED_AT, freshness: "FRESH", coverage: "COMPLETE" }) };
  });
  api.on("GET", /^\/api\/products\/cfmeet\/resources\/cfmeet\.organizations\.read\/organizations\.organizations\.read\/([^/]+)$/, (_req, _url, m) => ({
    body: env({ ...listRead([], null, "organizations.organizations.read"), kind: "DETAIL", data: { ...org(1), organization_id: m[1], organization_type: "BUSINESS", industry: "HEALTH", country_code: "NG" } },
      { as_of: OBSERVED_AT, freshness: "FRESH", coverage: "COMPLETE" }),
  }));
  api.on("GET", /^\/api\/products\/cfmeet\/resources\/cfmeet\.organizations\.read\/organizations\.members\.list$/, {
    body: env(listRead([{ membership_id: "9a1b2c3d-0000-4000-8000-000000000001", user_id: "7c1d2e3f-0000-4000-8000-000000000001", role: "OWNER", status: "ACTIVE", joined_via: null,
      created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-01T09:00:00Z", removed_at: null, version: 1 }], null, "organizations.members.list"), { as_of: OBSERVED_AT, freshness: "FRESH", coverage: "COMPLETE" }),
  });
  api.on("GET", "/api/products/cfmeet/reports/cfmeet.report.finance_usage", {
    body: env({
      report_id: "finance_usage", title: "Usage by plan and currency", definition: "Source-released usage cells; money in minor units per currency, never combined across currencies",
      grain: "WINDOW", units: ["count", "minor_currency"], source: { kind: "BRIDGE", owner: "finance", bridge_capability_id: "finance.usage.report", contract_version: "1.2.0" },
      scope: { market: "GLOBAL", organization: "cfmeet", zone: "production", tenant: "cfmeet-main" }, filters: { purpose: "billing-review", start: "2026-11-19T06:00:00.000Z", end: "2026-11-20T06:00:00.000Z" },
      observed_at: OBSERVED_AT, quality: "LIVE", blockers: [],
      rows: [
        { key: "pro.minutes", unit: "count", currency: null, value: 5400, suppression: null },
        { key: "pro.revenue", unit: "minor_currency", currency: "NGN", value: 1250050, suppression: null },
        { key: "pro.revenue", unit: "minor_currency", currency: "USD", value: 4999, suppression: null },
      ],
      window: { start: "2026-11-19T06:00:00.000Z", end: "2026-11-20T06:00:00.000Z" },
    }, { as_of: OBSERVED_AT, freshness: "FRESH", coverage: "COMPLETE" }),
  });
  return api;
}

const sidebarLink = (page: import("@playwright/test").Page) => page.locator('a[href="/dashboard/cfmeet"]');

test.describe("CF Meet sidebar entry follows /api/products", () => {
  test.skip(({ isMobile }) => !!isMobile, "sidebar nav is a desktop drawer; mobile covered in mobile.spec");

  test("shown when CF Meet is available, for an employee without staff tier", async ({ page, api }) => {
    await signIn(page, ALICE);
    defaultMocks(api, ALICE);
    cfmeetMocks(api);
    await gotoWithEntitlements(page, "/dashboard");
    await expect(sidebarLink(page).first()).toBeVisible();
    await expect(sidebarLink(page).first()).toHaveText(/CF Meet/);
    // Existing items stay.
    await expect(page.locator('a[href="/dashboard/profile"]').first()).toBeVisible();
  });

  test("hidden when CF Meet is not available or not granted", async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    cfmeetMocks(api, [{ product_id: "cfmeet", available: false, reason: "NOT_ENABLED", navigation: null }]);
    await gotoWithEntitlements(page, "/dashboard");
    await expect.poll(() => api.callsTo("GET", "/api/products").length).toBeGreaterThan(0);
    await expect(page.locator('a[href="/dashboard/healthnet"]').first()).toBeVisible();
    await expect(sidebarLink(page)).toHaveCount(0);

    api.on("GET", "/api/products", { body: { success: true, data: { products: [] } } });
    await gotoWithEntitlements(page, "/dashboard");
    await expect(page.locator('a[href="/dashboard/healthnet"]').first()).toBeVisible();
    await expect(sidebarLink(page)).toHaveCount(0);
  });
});

test.describe("CF Meet section", () => {
  test.beforeEach(async ({ page, api }) => {
    await signIn(page, SUPER_USER);
    defaultMocks(api, SUPER_USER);
    cfmeetMocks(api);
  });

  test("overview shows metric cards with as-of, freshness and coverage; a missing figure is unavailable", async ({ page, api }) => {
    await page.goto("/dashboard/cfmeet");
    await expect(page.getByRole("heading", { name: "CF Meet · Overview" })).toBeVisible();
    const started = page.locator('[data-metric="cfmeet.meetings_daily.meetings_started"]');
    await expect(started).toContainText("1,284");
    await expect(started).toContainText("As of");
    await expect(started).toContainText("Fresh");
    await expect(started).toContainText("Complete coverage");
    expect(await started.locator("time").first().getAttribute("datetime")).toBe(OBSERVED_AT);
    const participants = page.locator('[data-metric="cfmeet.meetings_daily.participants"]');
    await expect(participants).toContainText("Unavailable");
    await expect(participants).toContainText("NO_SOURCE_OBSERVATION");
    await expect(participants).not.toContainText(/^0$/);
    // Metric reads carry one exact scope from effective_scope.
    const call = api.callsTo("GET", "/api/products/cfmeet/metrics/cfmeet.meetings_daily.meetings_started")[0];
    expect(call.query).toMatchObject({ market: "GLOBAL", organization: "cfmeet", zone: "production", tenant: "cfmeet-main", limit: "1" });
    // Module status is honest about blocked modules.
    await expect(page.getByRole("region", { name: "CF Meet modules" })).toContainText("Accounts Administration");
    await noHorizontalScroll(page);
  });

  test("sub-navigation switches pages through ?section= and lists page with continuation", async ({ page, api }) => {
    await page.goto("/dashboard/cfmeet");
    await page.getByRole("link", { name: "Organizations", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/cfmeet\?section=organizations$/);
    await expect(page.getByRole("heading", { name: "CF Meet · Organizations" })).toBeVisible();
    const list = page.getByRole("region", { name: "Organizations", exact: true });
    await expect(list.getByRole("cell", { name: "Org 1" })).toBeVisible();
    await expect(list.getByRole("cell", { name: "Org 2" })).toBeVisible();
    await expect(list).toContainText("Complete coverage");
    // Wide tables scroll inside their own box; the page itself never gets wider than the viewport.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const first = api.callsTo("GET", "/api/products/cfmeet/resources/cfmeet.organizations.read/organizations.organizations.search")[0];
    expect(first.query).toMatchObject({ market: "GLOBAL", organization: "cfmeet", zone: "production", tenant: "cfmeet-main", purpose: "support-review", limit: "50" });
    expect(first.query.continuation).toBeUndefined();

    await list.getByRole("button", { name: "Load more" }).click();
    await expect(list.getByRole("cell", { name: "Org 3" })).toBeVisible();
    await expect(list).toContainText("3 records loaded; end of list");
    await expect(list.getByRole("button", { name: "Load more" })).toHaveCount(0);
    const calls = api.callsTo("GET", "/api/products/cfmeet/resources/cfmeet.organizations.read/organizations.organizations.search");
    expect(calls.at(-1)?.query.continuation).toBe("page2-token-abcdefghij");

    // Detail drawer with a nested list read through `parent`.
    await list.getByRole("button", { name: "Open" }).first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText("Country code")).toBeVisible();
    await drawer.getByRole("tab", { name: "Members" }).click();
    await expect(drawer.getByRole("cell", { name: "OWNER" })).toBeVisible();
    const nested = api.callsTo("GET", "/api/products/cfmeet/resources/cfmeet.organizations.read/organizations.members.list")[0];
    expect(nested.query.parent).toBe(org(1).organization_id);
    await page.keyboard.press("Escape");

    // Commands are listed with their state and blocker, with no way to run them.
    const actions = page.locator("details", { hasText: "Actions (1)" });
    await actions.locator("summary").click();
    await expect(actions).toContainText("cfmeet.organizations.organization.suspend");
    await expect(actions).toContainText("SOURCE_DISABLED");
    await expect(actions).toContainText("Second approver required");
    await expect(actions.getByRole("button")).toHaveCount(0);
    expect(api.callsTo("POST", "/api/products/cfmeet/operations")).toHaveLength(0);

    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/cfmeet$/);
    await expect(page.getByRole("heading", { name: "CF Meet · Overview" })).toBeVisible();
  });

  test("a blocked collection shows its reason and is never requested", async ({ page, api }) => {
    await page.goto("/dashboard/cfmeet?section=users");
    await expect(page.getByRole("heading", { name: "CF Meet · Users" })).toBeVisible();
    const blocked = page.getByRole("status", { name: "Users blocked" });
    await expect(blocked).toContainText("Users is not available");
    await expect(blocked).toContainText("Blocked");
    await expect(blocked).toContainText("SOURCE_BLOCKED_DEPENDENCY");
    await expect(blocked).toContainText("Not released by CF Meet yet");
    await expect(page.getByText("NO_READABLE_SOURCE_CAPABILITY")).toBeVisible();
    expect(api.callsTo("GET", /\/api\/products\/cfmeet\/resources\//)).toHaveLength(0);
    await expect(page.getByText("No users")).toHaveCount(0);
  });

  test("finance reports show figures per currency with freshness, and blocked reports with their blockers", async ({ page, api }) => {
    await page.goto("/dashboard/cfmeet?section=finance");
    const usage = page.getByRole("article", { name: "Usage by plan and currency" });
    await expect(usage).toContainText("5,400");
    await expect(usage).toContainText("NGN (minor units)");
    await expect(usage).toContainText("USD (minor units)");
    await expect(usage).toContainText("Fresh");
    await expect(usage).toContainText("never added together");
    const call = api.callsTo("GET", "/api/products/cfmeet/reports/cfmeet.report.finance_usage")[0];
    expect(call.query).toMatchObject({ purpose: "billing-review", zone: "production", tenant: "cfmeet-main" });
    expect(Date.parse(call.query.end) - Date.parse(call.query.start)).toBeLessThanOrEqual(31 * 24 * 3600 * 1000);
    const charges = page.getByRole("status", { name: "Estimated charges blocked" });
    await expect(charges).toContainText("Phase A6: finance estimates pending");
    expect(api.callsTo("GET", "/api/products/cfmeet/reports/cfmeet.report.estimated_charges")).toHaveLength(0);
  });
});
