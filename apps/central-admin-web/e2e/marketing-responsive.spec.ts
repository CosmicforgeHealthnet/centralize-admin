import { test, expect, signIn, defaultMocks, entitlements, ok, SUPER_USER, noHorizontalScroll, type MockApi } from "./fixtures";
import type { Page, Route, Request } from "@playwright/test";
import * as mi from "../src/lib/marketing-intelligence.mock";
import * as ai from "../src/lib/ai-marketing-intelligence.mock";
import * as ae from "../src/lib/advertising-execution.mock";
import * as so from "../src/lib/social-operations.mock";

const sections = ["overview", "campaigns", "content-manager", "email-template", "social-media", "banners-promotion", "performance-dashboard", "marketing-intelligence", "ai-marketing-intelligence", "social-operations", "advertising-execution"];
const nested: Record<string, string> = { "marketing-intelligence": "Marketing Intelligence views", "ai-marketing-intelligence": "AI Marketing Intelligence views", "social-operations": "Social Operations views", "advertising-execution": "Advertising Execution views" };
const org = { id: "org-cf", slug: "cosmicforge", name: "CosmicForge", canAuthor: true, canApprove: true };
const mkPath = (suffix: string) => `/api/mail/v1/marketing/${org.id}/${suffix}`;
const meta = { page: 1, limit: 20, total: 1, totalPages: 1 };
const now = "2026-11-04T09:00:00Z";
const row = { id: "review-1", title: "November community health awareness campaign", name: "Community health newsletter", type: "Email", status: "Draft", progress: 30, metrics: [], date: now, author: "Marketing team", updatedAt: now, performance: 15, eventCode: "WELCOME", event: "Welcome message", customerChannels: ["Email"], recipientChannels: ["Email"], validToDate: now, mediaType: "Image", description: "A longer description to check wrapping without squeezing other columns.", display: "Homepage", externalLink: "https://example.com/health", discountType: "Percentage", startDate: now, endDate: now, grossSales: "1,000", averageRate: "5%", grossRevenue: "100" };
function fixtures(api: MockApi) {
  defaultMocks(api, SUPER_USER, entitlements({ marketingEnabled: true, marketing: [{ ...org, organizationId: org.id }] }));
  api.on("GET", /^\/api\/notifications\/unread-count/, ok({unreadCount:0}));
  api.on("GET", /^\/api\/marketing\/(analytics|social)\//, {status:503,body:{message:"Analytics is unavailable in this isolated layout test"}});
  api.on("GET", /^\/api\/marketing\/(campaigns|content|contents|email-templates|banners|promotions)$/, { body: { data: [row], stats: { total: 1, active: 0, drafts: 1, completed: 0, totalPromotions: 1, engagementRate: "5%", revenue: "100" }, counts: { sent: 0, draft: 1 }, meta } });
  api.on("GET", /^\/api\/v1\/marketing\/intelligence\/.*/, (_req, url) => {
    const tail = url.pathname.split("/").pop()!;
    const values: Record<string, unknown> = { overview: ai.mockAMIOverview, connections: mi.mockMIConnections, performance: mi.mockMIPerformanceSingleCurrency, "provider-validation": ai.mockAMIProviderValidation.map((r,i)=>({...mi.mockMIProviderValidation[i],...r})), creatives: ai.mockAMICreatives, recommendations: ai.mockAMIRecommendations, alerts: ai.mockAMIAlerts, experiments: ai.mockAMIExperiments, "evaluation-runs": ai.mockAMIEvaluationRuns, settings: ai.mockAMISettings, "eligible-assignees": ai.mockAMIEligibleAssignees };
    return ok((values[tail] ?? []) as never);
  });
  api.on("GET", /^\/api\/v1\/marketing\/advertising-execution\/.*/, (_req, url) => {
    const tail = url.pathname.split("/").pop()!;
    const values: Record<string, unknown> = { overview: ae.mockAEOverview, capabilities: ae.mockAEProviderCapabilities, plans: ae.mockAEPlans, runs: ae.mockAERuns, drift: ae.mockAEIncidents, publications: ae.mockAECreativePublications, policies: url.searchParams.get("view") === "kill-switches" ? ae.mockAEKillSwitches : ae.mockAEPolicies, overrides: ae.mockAEOverrides, health: ae.mockAEHealth };
    return ok((values[tail] ?? []) as never);
  });
  api.on("GET", /^\/api\/v1\/marketing\/social\/.*/, (_req, url) => {
    const values: Record<string, unknown> = { connections: so.mockSOConnections, identities: so.mockSOIdentities, posts: so.mockSOPosts, media: so.mockSOMedia, publications: so.mockSOPublications, content: so.mockSOContentItems, conversations: so.mockSOConversations, comments: so.mockSOComments, escalations: so.mockSOEscalations, operations: so.mockSOJobs, settings: so.mockSOSettings };
    return ok((values[url.pathname.split("/").pop()!] ?? []) as never);
  });
  const mk = "/api/mail/v1/marketing";
  api.on("GET", new RegExp("^" + mk + "/.*"), ok([], { nextCursor: null }));
  // Match the real backend wire contract: brand IDs arrive as organizationId.
  api.on("GET", mk + "/organizations", ok([{ organizationId: org.id, slug: org.slug, name: org.name, canAuthor: org.canAuthor, canApprove: org.canApprove }]));
  api.on("GET", mk + "/org-cf/reports/overview", ok({flags:{broadcastDispatchEnabled:false,emergencyStop:false},recipientsLast30Days:{},activeSuppressions:{},automations:{},enrollments:{},jobs:[]}));
  api.on("GET", mk + "/org-cf/settings", ok({organizationId:org.id, defaultTimeZone:"Africa/Lagos", postalAddress:"Lagos", dailyBroadcastCap:1000, dailyAutomationCap:500, maxBroadcastRecipients:1000, hardMaxBroadcastRecipients:1000, dispatchPaused:false, provider:{configured:false}, flags:{broadcastDispatchEnabled:false,automationEnabled:false,confirmationEmailsEnabled:false,emergencyStop:false}}));
  api.on("GET", mk + "/org-cf/campaigns", ok([{ id: "cmp-1", name: row.name, status: "DRAFT", topic: "newsletter", revision: 1, updatedAt: now }]));
  api.on("GET", mk + "/org-cf/contacts", ok([{ id: "contact-1", email: "reader@cosmicforge.example", firstName: "Alex", lastName: "Reader", status: "ACTIVE", consents: [] }]));
  api.on("GET", mk + "/org-cf/templates", ok([{ id: "template-1", name: "Community newsletter", latestVersion: 1, updatedAt: now }]));
}
async function inspect(page: Page, name: string, width: number) {
  await page.waitForTimeout(120);
  await noHorizontalScroll(page);
  const controls = await page.locator(".marketing-workspace .marketing-search input:visible, .marketing-workspace #contact-search:visible").evaluateAll(nodes => nodes.map(node => { const r=node.getBoundingClientRect(); const p=(node.closest(".marketing-toolbar, form[role=search]") ?? node.parentElement!.parentElement!).getBoundingClientRect(); return { width:r.width, available:p.width, height:r.height }; }));
  for (const control of controls) { expect(control.height, name + " touch target").toBeGreaterThanOrEqual(43); if(width < 640) expect(control.width, name + " full-width search").toBeGreaterThanOrEqual(control.available - 3); }
  for (const table of await page.locator(".marketing-workspace table:visible").all()) {
    await expect(table.locator("xpath=.."), name + " contained table").toHaveClass(/marketing-table-scroll/);
  }
  await expect(page.getByRole("heading",{name:"This dashboard view could not be displayed"})).toHaveCount(0);
}
for (const width of [360,390,768,1024,1440]) for (const theme of ["light","dark"]) {
  test("Marketing responsive " + width + " " + theme, async ({ page, api }, info) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, SUPER_USER); fixtures(api);
    await page.addInitScript(t => localStorage.setItem("theme", t), theme);
    // The existing development preview uses the staging API URL. Intercept it
    // into the same synthetic API fixture; no request reaches that server.
    await page.context().route("https://stagingca.cosmicforge-healthnet.com/**", route => (api as unknown as { dispatch(r: Route, request: Request, url: URL): Promise<void> }).dispatch(route, route.request(), new URL(route.request().url())));
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if(m.type() === "error" && !m.text().includes("Failed to load resource")) console.log("BROWSER",m.text().slice(0,500)); });
    const visited: string[] = [];
    for (const section of sections) {
      console.log("VIEW", section);
      await page.goto("/dashboard/marketing?section=" + section, { waitUntil: "domcontentloaded" });
      await expect(page.locator(".marketing-workspace h1")).toBeVisible();
      if (theme === "dark" && !await page.locator("html").evaluate(e=>e.classList.contains("dark"))) await page.getByRole("button",{name:"Dark mode",exact:true}).click();
      if (theme === "light" && await page.locator("html").evaluate(e=>e.classList.contains("dark"))) await page.getByRole("button",{name:"Light mode",exact:true}).click();
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
      await inspect(page, section, width); visited.push(section);
      if (nested[section] && [390,1440].includes(width)) {
        const nav = page.getByRole("navigation", { name: nested[section], exact: true });
        const options = await nav.locator("select option").evaluateAll(nodes => nodes.map(n => ({ value:(n as HTMLOptionElement).value, text:n.textContent! })));
        for (const option of options) {
          if (await nav.locator("select").isVisible()) await nav.locator("select").selectOption(option.value);
          else await nav.getByRole("button", { name: option.text, exact: true }).click();
          await page.waitForTimeout(500);
          await inspect(page, section + "/" + option.value, width); visited.push(section + "/" + option.value);
          if (["plans","recommendations","creative-intelligence"].includes(option.value)) await page.screenshot({ path: info.outputPath(section + "-" + option.value + ".png"), animations:"disabled" });
        }
      }
      if (["content-manager","email-template","banners-promotion"].includes(section) && [390,1440].includes(width)) await page.screenshot({path:info.outputPath(section+".png"),animations:"disabled"});
    }
    if ([390,1440].includes(width)) for (const section of ["", "campaigns", "audiences", "contacts", "templates", "automation", "settings"]) {
      await page.goto("/dashboard/marketing/email-marketing/" + section + "?org=org-cf", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", {name:"Email Marketing",exact:true})).toBeVisible();
      if (theme === "dark" && !await page.locator("html").evaluate(e=>e.classList.contains("dark"))) await page.getByRole("button",{name:"Dark mode",exact:true}).click();
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
      await inspect(page,"email-marketing/"+section,width);visited.push("email-marketing/"+section);
      if (section === "" && width === 390 && theme === "light") {
        await expect(page.getByText("Not found", { exact: true })).toHaveCount(0);
        await expect.poll(() => api.callsTo("GET", mkPath("campaigns")).length).toBeGreaterThan(0);
        await expect.poll(() => api.callsTo("GET", mkPath("audiences")).length).toBeGreaterThan(0);
        await expect.poll(() => api.callsTo("GET", mkPath("templates")).length).toBeGreaterThan(0);
      }
    }
    await info.attach("visited-views",{body:JSON.stringify(visited,null,2),contentType:"application/json"});
    expect(errors).toEqual([]);
    expect(api.calls.filter(c=>!["GET","OPTIONS"].includes(c.method))).toEqual([]);
  });
}
