"use strict";

// Final gaps 1 + 7 (unit): template classification content policy in the
// renderer, deliverability preflight states and template QA heuristics.
// Pure functions and stubbed clients only; no database, no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const { renderTemplate, TemplateError } = require("../src/modules/mail/marketing/template-renderer");
const preflight = require("../src/modules/mail/marketing/preflight");
const { createTemplatePolicy } = require("../src/modules/mail/marketing/template-policy");
const { loadMailConfig } = require("../src/modules/mail/mail.config");

const BLOCKS = [{ type: "heading", text: "Your receipt" }, { type: "text", text: "Hello {{first_name}}, thanks for your order." }, { type: "button", label: "View receipt", url: "https://cosmicforge.example/receipts/1" }];
const reasons = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TemplateError, String(error));
    return error.details.map((entry) => entry.reason || entry.variable);
  }
  return [];
};
const config = (env = {}) => loadMailConfig({ NODE_ENV: "test", ...env });

test("MARKETING rendering and hashes are unchanged by classification support", () => {
  const plain = renderTemplate({ subject: "Hi", blocks: BLOCKS, brand: { name: "CF" } });
  const explicit = renderTemplate({ subject: "Hi", blocks: BLOCKS, brand: { name: "CF" } }, { classification: "MARKETING" });
  assert.equal(plain.html, explicit.html);
  assert.equal(plain.contentSha256, explicit.contentSha256);
  assert.match(plain.html, /href="\{\{unsubscribe_url\}\}"/);
  assert.match(plain.text, /Unsubscribe: \{\{unsubscribe_url\}\}/);
  // The hash input for MARKETING has no classification key (pre-gap hashes stay valid).
  const crypto = require("node:crypto");
  const legacy = crypto.createHash("sha256").update(JSON.stringify({ subject: "Hi", preheader: null, blocks: BLOCKS, brand: plain.brand })).digest("hex");
  assert.equal(plain.contentSha256, legacy);
});

test("TRANSACTIONAL renders without the marketing footer and refuses promotional blocks and marketing variables", () => {
  const rendered = renderTemplate({ subject: "Receipt", blocks: BLOCKS, brand: { name: "CF", postalAddress: "1 Marina Road" } }, { classification: "TRANSACTIONAL" });
  assert.doesNotMatch(rendered.html, /unsubscribe/i);
  assert.doesNotMatch(rendered.html, /opted in/);
  assert.match(rendered.html, /service message from \{\{brand_name\}\}/);
  assert.match(rendered.html, /1 Marina Road/);
  assert.ok(!rendered.variables.includes("unsubscribe_url"));
  assert.notEqual(rendered.contentSha256, renderTemplate({ subject: "Receipt", blocks: BLOCKS, brand: { name: "CF", postalAddress: "1 Marina Road" } }).contentSha256, "the class is bound into the hash");
  assert.deepEqual(reasons(() => renderTemplate({ subject: "x", blocks: [...BLOCKS, { type: "text", text: "Leave: {{unsubscribe_url}}" }] }, { classification: "TRANSACTIONAL" })), ["MARKETING_ONLY_VARIABLE"]);
  assert.deepEqual(reasons(() => renderTemplate({ subject: "x", blocks: [{ type: "hero", text: "Big sale" }] }, { classification: "TRANSACTIONAL" })), ["PROMOTIONAL_BLOCK_NOT_ALLOWED"]);
  assert.deepEqual(reasons(() => renderTemplate({ subject: "x", blocks: [{ type: "image", src: "https://cdn.example/banner.png", alt: "Banner", href: "https://shop.example" }] }, { classification: "TRANSACTIONAL" })), ["PROMOTIONAL_BLOCK_NOT_ALLOWED"]);
  // MARKETING still treats reserved promotional types as unsupported builder blocks.
  assert.deepEqual(reasons(() => renderTemplate({ subject: "x", blocks: [{ type: "coupon", text: "x" }] })), ["UNSUPPORTED"]);
});

test("TRANSACTIONAL_SECURITY content policy: no remote images, no external links, no promotional copy", () => {
  const options = { classification: "TRANSACTIONAL_SECURITY", allowedLinkDomains: ["cosmicforge.example"] };
  const ok = renderTemplate({ subject: "Reset your password", blocks: [{ type: "heading", text: "Password reset" }, { type: "button", label: "Reset password", url: "https://auth.cosmicforge.example/reset" }] }, options);
  assert.ok(ok.text.length > 0);
  assert.deepEqual(reasons(() => renderTemplate({ subject: "x", blocks: [{ type: "image", src: "https://cdn.example/a.png", alt: "a" }] }, options)), ["REMOTE_IMAGE_NOT_ALLOWED"]);
  assert.deepEqual(reasons(() => renderTemplate({ subject: "x", blocks: [{ type: "button", label: "Reset", url: "https://evil.example/reset" }] }, options)), ["EXTERNAL_LINK_NOT_ALLOWED"]);
  assert.deepEqual(reasons(() => renderTemplate({ subject: "x", blocks: [{ type: "text", text: "Go to https://evil.example/login now" }] }, options)), ["EXTERNAL_LINK_NOT_ALLOWED"]);
  assert.deepEqual(reasons(() => renderTemplate({ subject: "x", blocks: [{ type: "text", text: "Get 50% off today" }] }, options)), ["PROMOTIONAL_COPY_NOT_ALLOWED"]);
  assert.deepEqual(reasons(() => renderTemplate({ subject: "Limited time offer", blocks: [{ type: "text", text: "Code inside" }] }, options)), ["PROMOTIONAL_COPY_NOT_ALLOWED"]);
  assert.deepEqual(reasons(() => renderTemplate({ subject: "x", blocks: [{ type: "text", text: "hi" }], brand: { logoUrl: "https://cdn.example/logo.png" } }, options)), ["REMOTE_IMAGE_NOT_ALLOWED"]);
  assert.deepEqual(reasons(() => renderTemplate({ subject: "x", blocks: [{ type: "text", text: "hi" }] }, { classification: "BOGUS" })), ["UNSUPPORTED"]);
});

test("preflight statuses: ok semantics, summary and hash", () => {
  const checks = [preflight.check("a", "PASS", ""), preflight.check("b", "WARNING", ""), preflight.check("c", "UNKNOWN", ""), preflight.check("d", "BLOCKED", "")];
  assert.deepEqual(checks.map((entry) => entry.ok), [true, true, true, false]);
  assert.deepEqual(preflight.summarize(checks), { PASS: 1, WARNING: 1, BLOCKED: 1, UNKNOWN: 1 });
  const changed = [...checks.slice(0, 3), preflight.check("d", "PASS", "different detail")];
  assert.notEqual(preflight.preflightHash(checks), preflight.preflightHash(changed));
  assert.equal(preflight.preflightHash([preflight.check("a", "PASS", "x")]), preflight.preflightHash([preflight.check("a", "PASS", "y")]), "details do not change the hash");
  assert.throws(() => preflight.check("x", "MAYBE", ""), /invalid preflight status/);
});

test("domain checks: UNKNOWN when the provider is unavailable, BLOCKED when it reports failure, PASS only from the provider", async () => {
  const domain = { domain: "cosmicforge.example", organizationId: "org", status: "VERIFIED", sendingStatus: "VERIFIED", providerDomainId: "dom_1", dnsRecords: [{ record: "SPF", status: "verified" }, { record: "DKIM", status: "verified" }], lastCheckedAt: new Date("2026-10-01T00:00:00Z") };
  const byId = (checks) => Object.fromEntries(checks.map((entry) => [entry.id, entry.status]));
  const unreachable = byId(await preflight.domainChecks({ sender: { domain }, organizationId: "org", validateDomain: async () => { throw Object.assign(new Error("down"), { code: "RESEND_HTTP_503" }); }, config: config() }));
  assert.equal(unreachable.provider_domain_verified, "UNKNOWN", "a local VERIFIED flag alone is never PASS");
  assert.equal(unreachable.spf, "UNKNOWN", "stored records never upgrade to PASS");
  assert.equal(unreachable.dkim, "UNKNOWN");
  const noProvider = byId(await preflight.domainChecks({ sender: { domain }, organizationId: "org", validateDomain: undefined, config: config() }));
  assert.equal(noProvider.provider_domain_verified, "UNKNOWN");
  const hanging = byId(await preflight.domainChecks({ sender: { domain }, organizationId: "org", validateDomain: () => new Promise(() => {}), config: { marketingDeliverability: { providerTimeoutMs: 20 } } }));
  assert.equal(hanging.provider_domain_verified, "UNKNOWN", "a hanging provider times out to UNKNOWN");
  const failed = byId(await preflight.domainChecks({ sender: { domain }, organizationId: "org", validateDomain: async () => ({ status: "FAILED", sendingStatus: "FAILED", records: [{ record: "SPF", status: "failed" }, { record: "DKIM", status: "verified" }] }), config: config() }));
  assert.equal(failed.provider_domain_verified, "BLOCKED");
  assert.equal(failed.spf, "BLOCKED");
  const pending = byId(await preflight.domainChecks({ sender: { domain }, organizationId: "org", validateDomain: async () => ({ status: "PENDING", sendingStatus: "PENDING", records: [{ record: "DKIM", status: "pending" }] }), config: config() }));
  assert.equal(pending.provider_domain_verified, "WARNING");
  assert.equal(pending.dkim, "WARNING");
  assert.equal(pending.spf, "UNKNOWN", "no SPF record reported");
  const verified = await preflight.domainChecks({ sender: { domain }, organizationId: "org", validateDomain: async () => ({ status: "VERIFIED", sendingStatus: "VERIFIED", records: [{ record: "SPF", status: "verified" }, { record: "DKIM", status: "verified" }, { record: "DMARC", name: "_dmarc", value: "v=DMARC1; p=quarantine", status: "verified" }] }), config: config() });
  const states = byId(verified);
  assert.deepEqual([states.provider_domain_verified, states.spf, states.dkim, states.dmarc], ["PASS", "PASS", "PASS", "PASS"]);
  assert.match(verified.find((entry) => entry.id === "dmarc").detail, /aligned via DKIM/);
  const noDmarc = byId(await preflight.domainChecks({ sender: { domain }, organizationId: "org", validateDomain: async () => ({ status: "VERIFIED", sendingStatus: "VERIFIED", records: [] }), config: config() }));
  assert.equal(noDmarc.dmarc, "UNKNOWN", "DMARC is not reported by Resend: UNKNOWN, never PASS");
  const foreign = byId(await preflight.domainChecks({ sender: { domain: { ...domain, organizationId: "other" } }, organizationId: "org", validateDomain: async () => ({ status: "VERIFIED", sendingStatus: "VERIFIED", records: [] }), config: config() }));
  assert.equal(foreign.sender_domain_brand_owned, "BLOCKED");
});

test("reputation thresholds: UNKNOWN with little data, WARNING and BLOCKED above the configured rates", async () => {
  // Bounced rows; every bounce here is hard (a provider_hard_bounce suppression exists).
  const stub = (counts, hardShare = 1) => ({
    marketingBroadcastRecipient: {
      groupBy: async () => Object.entries(counts).map(([status, n]) => ({ status, _count: { _all: n } })),
      findMany: async () => Array.from({ length: counts.BOUNCED || 0 }, (_, index) => ({ email: `b${index}@reader.example` })),
    },
    marketingAutomationStepRun: { groupBy: async () => [], findMany: async () => [] },
    marketingSuppression: { findMany: async ({ where }) => where.email.in.slice(0, Math.round(where.email.in.length * hardShare)).map((email) => ({ email })) },
  });
  const run = (counts, env) => preflight.reputationCheck({ client: stub(counts), config: config(env), organizationId: "org" });
  assert.equal((await run({ DELIVERED: 20, BOUNCED: 5 })).status, "UNKNOWN");
  assert.equal((await run({ DELIVERED: 990, BOUNCED: 10 })).status, "PASS");
  assert.equal((await run({ DELIVERED: 970, BOUNCED: 30 })).status, "WARNING", "3% bounces > 2%");
  assert.equal((await run({ DELIVERED: 940, BOUNCED: 60 })).status, "BLOCKED", "6% bounces > 5%");
  assert.equal((await run({ DELIVERED: 9980, COMPLAINED: 20 })).status, "WARNING", "0.2% complaints > 0.1%");
  assert.equal((await run({ DELIVERED: 9950, COMPLAINED: 50 })).status, "BLOCKED", "0.5% complaints > 0.3%");
  assert.equal((await run({ DELIVERED: 970, BOUNCED: 30 }, { MAIL_MARKETING_BOUNCE_WARN_BPS: "400" })).status, "PASS", "thresholds are configurable");
  assert.equal((await run({ DELIVERED: 30 }, { MAIL_MARKETING_REPUTATION_MIN_SAMPLE: "10" })).status, "PASS");
  const broken = await preflight.reputationCheck({ client: { marketingBroadcastRecipient: { groupBy: async () => { throw new Error("db"); } }, marketingAutomationStepRun: { groupBy: async () => [] } }, config: config(), organizationId: "org" });
  assert.equal(broken.status, "UNKNOWN");
  // Re-audit: soft (Transient) bounces are not counted in the bounce rate.
  const soft = await preflight.reputationCheck({ client: stub({ DELIVERED: 940, BOUNCED: 60 }, 0), config: config(), organizationId: "org" });
  assert.equal(soft.status, "PASS", "60 soft bounces only");
  assert.deepEqual([soft.metrics.hardBounced, soft.metrics.softBounced], [0, 60]);
  assert.match(soft.detail, /hard bounce rate 0\.00% \(60 soft bounce\(s\) not counted\)/);
  const mixed = await preflight.reputationCheck({ client: stub({ DELIVERED: 940, BOUNCED: 60 }, 0.5), config: config(), organizationId: "org" });
  assert.equal(mixed.status, "WARNING", "30 hard bounces = 3%");
  assert.equal(mixed.metrics.bounced, 30);
});

test("content checks: plaintext consistency, unsubscribe, identity, link tracking", () => {
  assert.equal(preflight.plaintextConsistency("<p>Hello</p>", "  ").status, "BLOCKED");
  const mismatch = preflight.plaintextConsistency('<p>Hello reader, read the full report here</p><a href="https://cosmicforge.example/report">Report</a>', "Hello reader");
  assert.equal(mismatch.status, "WARNING");
  assert.match(mismatch.detail, /only in HTML/);
  assert.match(mismatch.detail, /plain text covers/);
  assert.equal(preflight.plaintextConsistency('<p>Hello reader</p><a href="https://cosmicforge.example/r">Read</a>', "Hello reader\nRead: https://cosmicforge.example/r").status, "PASS");
  const rendered = renderTemplate({ subject: "Hi", blocks: BLOCKS, brand: { name: "CF", postalAddress: "1 Marina Road" } });
  const byId = (checks) => Object.fromEntries(checks.map((entry) => [entry.id, entry.status]));
  const marketing = byId(preflight.contentChecks({ rendered, classification: "MARKETING", config: config() }));
  assert.deepEqual(marketing, { unsubscribe_present: "PASS", business_identity: "PASS", plaintext_consistency: "PASS", link_tracking: "UNKNOWN" });
  const noPostal = renderTemplate({ subject: "Hi", blocks: BLOCKS, brand: { name: "CF" } });
  assert.equal(byId(preflight.contentChecks({ rendered: noPostal, config: config() })).business_identity, "BLOCKED");
  const stripped = { ...rendered, html: rendered.html.replace(/href="\{\{unsubscribe_url\}\}"/, 'href="#"') };
  assert.equal(byId(preflight.contentChecks({ rendered: stripped, config: config() })).unsubscribe_present, "BLOCKED");
  assert.equal(preflight.linkTrackingCheck("TRANSACTIONAL_SECURITY", config({ MAIL_MARKETING_PROVIDER_CLICK_TRACKING: "on" })).status, "BLOCKED", "tracking would rewrite security links");
  assert.equal(preflight.linkTrackingCheck("TRANSACTIONAL_SECURITY", config()).status, "UNKNOWN");
  assert.equal(preflight.linkTrackingCheck("TRANSACTIONAL_SECURITY", config({ MAIL_MARKETING_PROVIDER_CLICK_TRACKING: "off" })).status, "PASS");
  assert.equal(preflight.linkTrackingCheck("MARKETING", config({ MAIL_MARKETING_PROVIDER_CLICK_TRACKING: "on" })).status, "PASS");
});

test("compatibility lint flags HTML/CSS common clients do not support (static heuristics)", () => {
  const ids = (html) => preflight.lintEmailCompatibility(html).map((entry) => `${entry.id}:${entry.status}`);
  assert.deepEqual(ids(renderTemplate({ subject: "Hi", blocks: BLOCKS }).html), [], "builder output is clean");
  const bad = '<link rel="stylesheet" href="https://x"><div style="display:flex;position:absolute;background-image:url(https://x/bg.png)"><script>1</script><form></form><svg></svg></div><style>@import url(x); @font-face{}</style><div style="display:grid"></div>';
  const found = ids(bad);
  for (const expected of ["script:BLOCKED", "form:BLOCKED", "external_stylesheet:WARNING", "css_import:WARNING", "flexbox:WARNING", "grid:WARNING", "position:WARNING", "background_image:WARNING", "web_fonts:WARNING", "svg:WARNING"]) assert.ok(found.includes(expected), `${expected} in ${found}`);
  assert.ok(preflight.contrastRatio("#FFFFFF", "#000000") > 20);
  assert.ok(preflight.contrastRatio("#FFFFFF", "#FFFF00") < 4.5);
});

test("template QA: previews, locale formatting, accessibility, personalization, unsafe links, disclaimer", () => {
  const version = { id: "11111111-1111-4111-8111-111111111111", version: 3, subject: "Hi {{first_name}} {{last_name}}", preheader: null, blocks: [{ type: "heading", text: "News", level: 2 }, { type: "heading", text: "Sub", level: 4 }, { type: "image", src: "https://cdn.example/a.png", alt: "" }, { type: "button", label: "Click here", url: "https://bit.ly/abc" }], brand: { name: "CF", primaryColor: "#FFFF00" } };
  const report = preflight.runTemplateQa({ version, classification: "MARKETING", brandSettings: { postalAddress: "1 Marina Road" }, config: config(), locale: "de-DE", sampleData: { first_name: "Ada", last_name: "" }, clock: () => new Date("2026-10-26T12:00:00Z") });
  const states = Object.fromEntries(report.checks.map((entry) => [entry.id, entry.status]));
  assert.match(report.disclaimer, /do not prove/);
  assert.equal(report.locale, "de-DE");
  assert.equal(report.formatted.number, "1.234.567,89");
  assert.match(report.renders.desktop.html, /<html lang="de-DE">/);
  assert.equal(report.renders.mobile.width, 375);
  assert.match(report.renders.dark.html, /color-scheme/);
  assert.equal(report.renders.dark.supportsDarkMode, false);
  assert.match(report.renders.plaintext, /Hi|NEWS/);
  assert.equal(states.a11y_alt_text, "WARNING");
  assert.equal(states.a11y_link_text, "WARNING");
  assert.equal(states.a11y_contrast, "WARNING", "yellow brand colour fails WCAG AA");
  assert.equal(states.a11y_heading_order, "WARNING");
  assert.equal(states.a11y_lang, "PASS");
  assert.equal(states.missing_personalization, "WARNING");
  assert.match(report.checks.find((entry) => entry.id === "missing_personalization").detail, /last_name\}\} has no value/);
  assert.equal(states.links_safe, "BLOCKED", "link shortener");
  assert.equal(states.dark_mode, "WARNING");
  assert.equal(states.client_compatibility, "PASS");
  assert.equal(states.unsubscribe_present, "PASS");
  assert.ok(report.summary.BLOCKED >= 1);
  // A version that violates its class policy reports BLOCKED instead of throwing.
  const security = preflight.runTemplateQa({ version: { ...version, blocks: [{ type: "image", src: "https://cdn.example/a.png", alt: "x" }] }, classification: "TRANSACTIONAL_SECURITY", config: config() });
  assert.equal(security.checks[0].status, "BLOCKED");
  assert.equal(security.renders, null);
  const unapproved = preflight.runTemplateQa({ version: { ...version, subject: "Reset", blocks: [{ type: "heading", text: "Reset", level: 1 }, { type: "button", label: "Reset password", url: "https://cosmicforge.example/r" }] }, classification: "TRANSACTIONAL_SECURITY", approval: { approved: false }, config: config({ MAIL_MARKETING_PROVIDER_CLICK_TRACKING: "on" }), allowedLinkDomains: ["cosmicforge.example"] });
  const unapprovedStates = Object.fromEntries(unapproved.checks.map((entry) => [entry.id, entry.status]));
  assert.equal(unapprovedStates.approvals_state, "BLOCKED");
  assert.equal(unapprovedStates.link_tracking, "BLOCKED");
  assert.equal(unapprovedStates.unsubscribe_present, "PASS", "not required for transactional");
});

test("template policy before migration 37: everything is MARKETING, nothing is queried, writes answer 503", async () => {
  const touched = [];
  const proxy = new Proxy({}, { get: (_, name) => { touched.push(name); return new Proxy({}, { get: () => async () => { throw new Error(`queried ${String(name)}`); } }); } });
  const policy = createTemplatePolicy({ client: proxy, feature: { isReady: async () => false } });
  assert.equal((await policy.templateClassification("t")).classification, "MARKETING");
  assert.equal(await policy.versionClassification("v"), "MARKETING");
  assert.equal(await policy.snapshotVersion(proxy, "v", "MARKETING"), null);
  await assert.rejects(policy.requireReady(), (error) => error.errors?.[0]?.code === "MAIL_FEATURE_NOT_READY" && error.statusCode === 503);
  const throwing = createTemplatePolicy({ client: proxy, feature: { isReady: async () => { throw new Error("probe failed"); } } });
  assert.equal(await throwing.ready(), false);
  assert.deepEqual(touched, [], "no table is touched before the migration");
});

// Re-audit: marketing mail is sent with the brand key (possibly another
// provider account), so the domain must be verified in that account.
test("domain checks: verified in the marketing account, else UNKNOWN (transactional account only)", async () => {
  const domain = { domain: "cosmicforge.example", organizationId: "org", providerDomainId: "tx_dom", status: "VERIFIED", sendingStatus: "VERIFIED", dnsRecords: [] };
  const transactionalVerified = async () => ({ status: "VERIFIED", sendingStatus: "VERIFIED", records: [{ record: "SPF", status: "verified" }, { record: "DKIM", status: "verified" }] });
  const byId = (checks) => Object.fromEntries(checks.map((entry) => [entry.id, entry]));
  const only = byId(await preflight.domainChecks({ sender: { domain }, organizationId: "org", validateDomain: transactionalVerified, marketingAccount: async () => ({ separate: true, lookup: null }), config: config() }));
  for (const id of ["provider_domain_verified", "spf", "dkim", "dmarc"]) {
    assert.equal(only[id].status, "UNKNOWN", id);
    assert.match(only[id].detail, /verified in the transactional account only/);
  }
  const looked = [];
  const marketing = byId(await preflight.domainChecks({ sender: { domain }, organizationId: "org", validateDomain: transactionalVerified, marketingAccount: async () => ({ separate: true, lookup: async (name) => { looked.push(name); return { status: "FAILED", sendingStatus: "FAILED", records: [{ record: "DKIM", status: "failed" }] }; } }), config: config() }));
  assert.deepEqual(looked, ["cosmicforge.example"]);
  assert.equal(marketing.provider_domain_verified.status, "BLOCKED", "the marketing account's answer counts");
  const absent = byId(await preflight.domainChecks({ sender: { domain }, organizationId: "org", validateDomain: transactionalVerified, marketingAccount: async () => ({ separate: true, lookup: async () => null }), config: config() }));
  assert.equal(absent.provider_domain_verified.status, "BLOCKED");
  const same = byId(await preflight.domainChecks({ sender: { domain }, organizationId: "org", validateDomain: transactionalVerified, marketingAccount: async () => ({ separate: false }), config: config() }));
  assert.equal(same.provider_domain_verified.status, "PASS", "one account for both purposes");
  const broken = byId(await preflight.domainChecks({ sender: { domain }, organizationId: "org", validateDomain: transactionalVerified, marketingAccount: async () => { throw new Error("db"); }, config: config() }));
  assert.equal(broken.provider_domain_verified.status, "UNKNOWN");
});

test("provider quota check: BLOCKED while exhausted, WARNING at >= 90% of a configured limit, UNKNOWN when not observed", async () => {
  const run = (state) => preflight.providerQuotaCheck({ organizationId: "org", quotaState: async () => state });
  assert.equal((await run({ status: "UNKNOWN", scope: "brand:cf" })).status, "UNKNOWN");
  assert.equal((await run({ status: "UNAVAILABLE", reason: "pre-37" })).status, "UNKNOWN");
  assert.equal((await run({ status: "OBSERVED", scope: "brand:cf", dailyUsed: 10, dailyLimit: null, monthlyUsed: 10, monthlyLimit: null })).status, "UNKNOWN", "no configured limit: remaining unknown");
  assert.equal((await run({ status: "OBSERVED", scope: "brand:cf", dailyUsed: 89, dailyLimit: 100 })).status, "PASS");
  assert.equal((await run({ status: "OBSERVED", scope: "brand:cf", dailyUsed: 90, dailyLimit: 100 })).status, "WARNING");
  assert.equal((await run({ status: "OBSERVED", scope: "brand:cf", monthlyUsed: 2700, monthlyLimit: 3000, dailyUsed: 1, dailyLimit: 100 })).status, "WARNING");
  const blocked = await run({ status: "OBSERVED", scope: "brand:cf", exhausted: true, exhaustedKind: "MONTHLY", exhaustedUntil: "2026-11-01T00:00:00.000Z" });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.ok, false);
  assert.equal((await preflight.providerQuotaCheck({ organizationId: "org", quotaState: async () => { throw new Error("x"); } })).status, "UNKNOWN");
});

test("resend marketing adapter: getDomainByName lists /domains then reads /domains/{id} with the brand key", async () => {
  const { createResendMarketingAdapter } = require("../src/modules/mail/adapters/marketing/resend-marketing.adapter");
  const calls = [];
  const responses = [
    { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: [{ id: "d_other", name: "other.example" }, { id: "d_cf", name: "cosmicforge.example" }], has_more: false }) },
    { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ id: "d_cf", status: "verified", records: [{ record: "SPF", status: "verified" }, { record: "DKIM", status: "verified" }] }) },
    { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: [], has_more: false }) },
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization });
    return responses.shift();
  };
  const cfg = loadMailConfig({ NODE_ENV: "test", MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_tx_unit" });
  const adapter = createResendMarketingAdapter({ apiKey: "re_brand_unit", config: cfg, fetchImpl, sleep: async () => {} });
  const result = await adapter.getDomainByName("CosmicForge.example");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sendingStatus, "VERIFIED");
  assert.deepEqual(calls.map((entry) => [entry.method, new URL(entry.url).pathname]), [["GET", "/domains"], ["GET", "/domains/d_cf"]]);
  assert.ok(calls.every((entry) => entry.auth === "Bearer re_brand_unit"), "the brand key, not the transactional key");
  assert.equal(await adapter.getDomainByName("missing.example"), null);
});
