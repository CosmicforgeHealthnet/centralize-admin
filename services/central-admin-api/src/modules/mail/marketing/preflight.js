"use strict";

// Marketing deliverability preflight + template QA (final gap 7).
//
// Every check has a status:
//   PASS     verified
//   WARNING  sendable, but a person should look (does not block)
//   BLOCKED  must be fixed before submit / approval (check.ok === false)
//   UNKNOWN  could not be verified (provider unreachable, too little data,
//            not reported by the provider). Never reported as PASS.
// `ok` on a check is `status !== "BLOCKED"`, and a preflight is ok when no
// check is BLOCKED, so the pre-existing boolean semantics are unchanged.
//
// Provider facts come from the provider account that actually sends the
// marketing mail (re-audit): a brand's marketing key may belong to another
// Resend account than the transactional key. The registered
// `marketingAccount(organizationId)` hook says whether that account is
// separate and, if so, how to look the domain up there (resend marketing
// adapter getDomainByName: GET /domains + GET /domains/{id}). A separate
// account without a lookup reports provider_domain_verified / SPF / DKIM /
// DMARC as UNKNOWN ("verified in the transactional account only"). Without the
// hook (older callers) the transactional adapter's validateDomain
// (GET /domains/{id}) is used: domain status and the SPF / DKIM records it
// returns. Resend does not report DMARC; DMARC (and therefore alignment) is
// UNKNOWN unless the provider returns a DMARC record. If the provider cannot
// be reached, the stored dns_records of the last verification are shown but
// never upgrade a check to PASS. Click tracking is not readable through the
// adapters, so it is UNKNOWN unless declared by MAIL_MARKETING_PROVIDER_CLICK_TRACKING.
//
// Template QA renders previews and runs static checks only. No URL is ever
// fetched (link scan is offline) and the email-client compatibility lint is a
// set of documented heuristics: a browser preview does not prove rendering in
// every email client.

const crypto = require("crypto");
const { scanLinks } = require("./link-scan");
const { renderTemplate, hasPromotionalCopy, hostAllowed, VARIABLE, TRANSACTIONAL_CLASSES } = require("./template-renderer");

const STATUSES = ["PASS", "WARNING", "BLOCKED", "UNKNOWN"];
const QA_DISCLAIMER = "Previews are rendered in a browser frame. They do not prove how the email renders in every email client (Outlook, Gmail, Apple Mail and mobile apps differ); the compatibility checks are static heuristics.";
const DEFAULT_DELIVERABILITY = { windowDays: 30, minSample: 100, bounceWarnBps: 200, bounceBlockBps: 500, complaintWarnBps: 10, complaintBlockBps: 30, providerClickTracking: null, securityLinkDomains: [], providerTimeoutMs: 5000 };
const SENT_STATUSES = ["PROVIDER_ACCEPTED", "DELIVERED", "DELAYED", "BOUNCED", "COMPLAINED"];
const SYSTEM_VARIABLES = new Set(["brand_name", "unsubscribe_url"]);
const NULLABLE_VARIABLES = new Set(["first_name", "last_name"]);
const DEFAULT_SAMPLE = { first_name: "Ada", last_name: "Lovelace", email: "ada@example.invalid" };

function check(id, status, detail, extra = {}) {
  if (!STATUSES.includes(status)) throw new Error(`invalid preflight status ${status}`);
  return { id, ok: status !== "BLOCKED", status, detail, ...extra };
}

function fromOk(id, ok, detail) {
  return check(id, ok ? "PASS" : "BLOCKED", detail);
}

function summarize(checks) {
  const summary = { PASS: 0, WARNING: 0, BLOCKED: 0, UNKNOWN: 0 };
  for (const entry of checks) summary[entry.status || (entry.ok ? "PASS" : "BLOCKED")] += 1;
  return summary;
}

// Binds an approval to the preflight outcome the reviewer saw: ids + states
// (not the free-text details, which carry counts and timestamps).
function preflightHash(checks) {
  const material = checks.map((entry) => `${entry.id}:${entry.status || (entry.ok ? "PASS" : "BLOCKED")}`).sort().join("|");
  return crypto.createHash("sha256").update(material).digest("hex");
}

function deliverabilityConfig(config) {
  return { ...DEFAULT_DELIVERABILITY, ...(config?.marketingDeliverability || {}) };
}

// ---- provider domain verification -----------------------------------------
const DELIVERABILITY = new WeakMap();

function registerDeliverability(client, deps) {
  if (client && typeof client === "object") DELIVERABILITY.set(client, deps);
}

function deliverabilityFor(client) {
  return DELIVERABILITY.get(client) || {};
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "PROVIDER_TIMEOUT" })), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function providerDomainState(domain, validateDomain, settings, lookupByName = null) {
  if (lookupByName) {
    try {
      const result = await withTimeout(Promise.resolve(lookupByName(domain.domain)), settings.providerTimeoutMs);
      if (!result) return { reachable: true, result: { status: "NOT_FOUND", sendingStatus: "NOT_CONFIGURED", records: [] }, notInAccount: true };
      return { reachable: true, result };
    } catch (error) {
      return { reachable: false, reason: error?.code || "PROVIDER_UNREACHABLE" };
    }
  }
  if (!domain?.providerDomainId) return { reachable: false, reason: "NO_PROVIDER_DOMAIN_ID" };
  if (typeof validateDomain !== "function") return { reachable: false, reason: "PROVIDER_NOT_AVAILABLE" };
  try {
    const result = await withTimeout(Promise.resolve(validateDomain(domain.providerDomainId)), settings.providerTimeoutMs);
    return { reachable: true, result: result || {} };
  } catch (error) {
    return { reachable: false, reason: error?.code || "PROVIDER_UNREACHABLE" };
  }
}

function recordsMatching(records, predicate) {
  return (Array.isArray(records) ? records : []).filter((record) => record && predicate(record));
}

function aggregateRecordStatus(list) {
  if (!list.length) return null;
  const states = list.map((record) => String(record.status || "").toLowerCase());
  if (states.every((state) => state === "verified")) return "VERIFIED";
  if (states.some((state) => state === "failed" || state === "temporary_failure")) return "FAILED";
  return "PENDING";
}

function recordCheck(id, label, list, live, lastCheckedAt) {
  const state = aggregateRecordStatus(list);
  if (!state) return check(id, "UNKNOWN", `${label}: no record reported by the provider`);
  if (!live) return check(id, "UNKNOWN", `${label}: provider unreachable; last provider check${lastCheckedAt ? ` ${new Date(lastCheckedAt).toISOString()}` : ""} reported ${state}`);
  if (state === "VERIFIED") return check(id, "PASS", `${label}: verified by the provider`);
  if (state === "FAILED") return check(id, "BLOCKED", `${label}: the provider reports the record as failed`);
  return check(id, "WARNING", `${label}: verification pending at the provider`);
}

// Sending-domain checks: brand ownership, provider verification, SPF/DKIM/DMARC.
async function domainChecks({ sender, organizationId, validateDomain, marketingAccount = null, config }) {
  const settings = deliverabilityConfig(config);
  const checks = [];
  const domain = sender?.domain;
  if (!domain) return [check("sender_domain_brand_owned", "BLOCKED", "No sender domain"), check("provider_domain_verified", "UNKNOWN", "No sender domain")];
  checks.push(fromOk("sender_domain_brand_owned", domain.organizationId === organizationId, domain.organizationId === organizationId ? `${domain.domain} belongs to this brand` : `${domain.domain} belongs to another brand`));
  // Which provider account sends this brand's marketing mail.
  let account = null;
  if (typeof marketingAccount === "function") {
    try {
      account = (await withTimeout(Promise.resolve(marketingAccount(organizationId)), settings.providerTimeoutMs)) || null;
    } catch (error) {
      account = { separate: true, lookup: null, reason: error?.code || "MARKETING_ACCOUNT_UNKNOWN" };
    }
  }
  if (account?.separate && typeof account.lookup !== "function") {
    const why = `verified in the transactional account only; the brand's marketing provider account cannot be checked${account.reason ? ` (${account.reason})` : ""}`;
    checks.push(check("provider_domain_verified", "UNKNOWN", `${domain.domain}: ${why}`));
    checks.push(check("spf", "UNKNOWN", `SPF: ${why}`));
    checks.push(check("dkim", "UNKNOWN", `DKIM: ${why}`));
    checks.push(check("dmarc", "UNKNOWN", `DMARC: ${why}; verify the _dmarc TXT record in DNS`));
    return checks;
  }
  const provider = await providerDomainState(domain, validateDomain, settings, account?.separate ? account.lookup : null);
  const live = provider.reachable;
  if (provider.notInAccount) {
    checks.push(check("provider_domain_verified", "BLOCKED", `${domain.domain}: not found in the brand's marketing provider account (marketing mail is sent with the brand key)`));
  } else if (!live) {
    checks.push(check("provider_domain_verified", "UNKNOWN", `${domain.domain}: provider verification unavailable (${provider.reason}); the local status ${domain.status}/${domain.sendingStatus} alone is not proof`));
  } else {
    const { status, sendingStatus } = provider.result;
    if (status === "VERIFIED" && sendingStatus === "VERIFIED") checks.push(check("provider_domain_verified", "PASS", `${domain.domain}: verified for sending by the provider`));
    else if (status === "FAILED" || sendingStatus === "FAILED" || sendingStatus === "NOT_CONFIGURED") checks.push(check("provider_domain_verified", "BLOCKED", `${domain.domain}: the provider reports ${status || "UNKNOWN"}/${sendingStatus || "UNKNOWN"}`));
    else checks.push(check("provider_domain_verified", "WARNING", `${domain.domain}: the provider reports verification pending (${status || "UNKNOWN"}/${sendingStatus || "UNKNOWN"}); re-run domain verification`));
  }
  const records = live ? provider.result.records : domain.dnsRecords;
  const upper = (value) => String(value || "").toUpperCase();
  const spf = recordsMatching(records, (record) => upper(record.record) === "SPF");
  const dkim = recordsMatching(records, (record) => upper(record.record) === "DKIM");
  const dmarc = recordsMatching(records, (record) => upper(record.record) === "DMARC" || String(record.name || "").toLowerCase().startsWith("_dmarc"));
  checks.push(recordCheck("spf", "SPF", spf, live, domain.lastCheckedAt));
  checks.push(recordCheck("dkim", "DKIM", dkim, live, domain.lastCheckedAt));
  const dmarcCheck = recordCheck("dmarc", "DMARC", dmarc, live, domain.lastCheckedAt);
  if (!dmarc.length) dmarcCheck.detail = "DMARC: not reported by the provider; verify the _dmarc TXT record in DNS. Alignment cannot be verified offline";
  else if (dmarcCheck.status === "PASS") {
    const policy = (String(dmarc[0].value || "").match(/\bp=(\w+)/i) || [])[1];
    const dkimAligned = aggregateRecordStatus(dkim) === "VERIFIED";
    dmarcCheck.detail = `DMARC: verified${policy ? ` (p=${policy})` : ""}; ${dkimAligned ? `aligned via DKIM on ${domain.domain}` : "alignment unknown (DKIM not verified)"}`;
    if (!dkimAligned) dmarcCheck.status = "UNKNOWN";
    else if (policy && policy.toLowerCase() === "none") dmarcCheck.status = "WARNING";
  }
  checks.push(dmarcCheck);
  return checks;
}

// ---- reputation --------------------------------------------------------------
async function reputationCheck({ client, config, organizationId, clock = () => new Date() }) {
  const settings = deliverabilityConfig(config);
  const since = new Date(clock().getTime() - settings.windowDays * 86400000);
  try {
    const [broadcast, automation] = await Promise.all([
      client.marketingBroadcastRecipient.groupBy({ by: ["status"], where: { organizationId, status: { in: SENT_STATUSES }, createdAt: { gte: since } }, _count: { _all: true } }),
      client.marketingAutomationStepRun.groupBy({ by: ["deliveryStatus"], where: { organizationId, deliveryStatus: { in: SENT_STATUSES }, createdAt: { gte: since } }, _count: { _all: true } }),
    ]);
    const counts = { total: 0, BOUNCED: 0, COMPLAINED: 0 };
    for (const row of broadcast) {
      counts.total += row._count._all;
      if (counts[row.status] != null) counts[row.status] += row._count._all;
    }
    for (const row of automation) {
      counts.total += row._count._all;
      if (counts[row.deliveryStatus] != null) counts[row.deliveryStatus] += row._count._all;
    }
    // Re-audit: only hard (Permanent) bounces count. Recipient rows carry
    // BOUNCED for soft and hard bounces alike; the bounce type is recorded as
    // the brand suppression a hard bounce creates (marketing-events.processor:
    // reason BOUNCED, source provider_hard_bounce). Soft bounces never create
    // one, so BOUNCED rows without that evidence are soft and excluded.
    let hardBounced = 0;
    if (counts.BOUNCED) {
      const [rows, runs] = await Promise.all([
        client.marketingBroadcastRecipient.findMany({ where: { organizationId, status: "BOUNCED", createdAt: { gte: since } }, select: { email: true } }),
        client.marketingAutomationStepRun.findMany({ where: { organizationId, deliveryStatus: "BOUNCED", createdAt: { gte: since } }, select: { recipientEmail: true } }),
      ]);
      const emails = [...rows.map((row) => row.email), ...runs.map((row) => row.recipientEmail)].filter(Boolean).map((email) => String(email).toLowerCase());
      const unique = [...new Set(emails)];
      const hard = unique.length ? await client.marketingSuppression.findMany({ where: { organizationId, reason: "BOUNCED", source: "provider_hard_bounce", email: { in: unique } }, select: { email: true } }) : [];
      const hardSet = new Set(hard.map((row) => String(row.email).toLowerCase()));
      hardBounced = Math.min(counts.BOUNCED, emails.filter((email) => hardSet.has(email)).length);
    }
    const softBounced = counts.BOUNCED - hardBounced;
    const metrics = { sent: counts.total, bounced: hardBounced, hardBounced, softBounced, complained: counts.COMPLAINED };
    if (counts.total < settings.minSample) return check("sender_reputation", "UNKNOWN", `Too little recent data: ${counts.total} sent in ${settings.windowDays} days (need ${settings.minSample})`, { metrics });
    const bounceBps = (hardBounced * 10000) / counts.total;
    const complaintBps = (counts.COMPLAINED * 10000) / counts.total;
    const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
    const detail = `${settings.windowDays}d: ${counts.total} sent, hard bounce rate ${pct(bounceBps)}${softBounced ? ` (${softBounced} soft bounce(s) not counted)` : ""}, complaint rate ${pct(complaintBps)} (warn ${pct(settings.bounceWarnBps)}/${pct(settings.complaintWarnBps)}, block ${pct(settings.bounceBlockBps)}/${pct(settings.complaintBlockBps)})`;
    const status = bounceBps > settings.bounceBlockBps || complaintBps > settings.complaintBlockBps ? "BLOCKED" : bounceBps > settings.bounceWarnBps || complaintBps > settings.complaintWarnBps ? "WARNING" : "PASS";
    return check("sender_reputation", status, detail, { metrics });
  } catch {
    return check("sender_reputation", "UNKNOWN", "Reputation data could not be read");
  }
}

// ---- provider quota ---------------------------------------------------------
// Spec: BLOCKED while a quota exhaustion is in force, WARNING when observed
// usage is at least 90% of a configured limit, UNKNOWN when nothing was
// observed (or no limit is configured, so remaining is unknown).
async function providerQuotaCheck({ organizationId, quotaState }) {
  if (typeof quotaState !== "function") return check("provider_quota", "UNKNOWN", "Provider quota is not available here");
  let state;
  try {
    state = await quotaState(organizationId);
  } catch {
    return check("provider_quota", "UNKNOWN", "Provider quota could not be read");
  }
  if (!state || state.status === "UNAVAILABLE") return check("provider_quota", "UNKNOWN", state?.reason || "Provider quota is not available");
  const scope = state.scope ? ` (${state.scope})` : "";
  if (state.exhausted) return check("provider_quota", "BLOCKED", `Provider ${String(state.exhaustedKind || "").toLowerCase() || "sending"} quota exhausted${scope} until ${state.exhaustedUntil}`, { quota: { scope: state.scope, exhaustedUntil: state.exhaustedUntil } });
  if (state.status !== "OBSERVED") return check("provider_quota", "UNKNOWN", `No provider quota observed yet${scope}`);
  const ratios = [];
  if (state.dailyLimit && state.dailyUsed != null) ratios.push({ period: "daily", used: state.dailyUsed, limit: state.dailyLimit });
  if (state.monthlyLimit && state.monthlyUsed != null) ratios.push({ period: "monthly", used: state.monthlyUsed, limit: state.monthlyLimit });
  if (!ratios.length) return check("provider_quota", "UNKNOWN", `Usage observed${scope} but no plan limit is configured (MAIL_PROVIDER_*_LIMIT): remaining quota unknown`);
  const describe = ratios.map((entry) => `${entry.period} ${entry.used}/${entry.limit}`).join(", ");
  const high = ratios.filter((entry) => entry.used * 10 >= entry.limit * 9);
  return check("provider_quota", high.length ? "WARNING" : "PASS", `${high.length ? "At least 90% of the provider quota used" : "Provider quota available"}${scope}: ${describe}`, { quota: { scope: state.scope, ratios } });
}

// ---- content -------------------------------------------------------------------
function decodeEntities(value) {
  return String(value).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function htmlLinks(html) {
  return [...String(html || "").matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi)].map((match) => decodeEntities(match[1]).trim()).filter((href) => /^https?:\/\//i.test(href));
}

function visibleWords(html) {
  const body = String(html || "")
    .replace(/<head[\s\S]*?<\/head>/i, " ")
    .replace(/<div style="display:none[\s\S]*?<\/div>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return wordsOf(decodeEntities(body));
}

function wordsOf(text) {
  return new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((word) => !/^https?$/.test(word)));
}

function plaintextConsistency(html, text) {
  if (!String(text || "").trim()) return check("plaintext_consistency", "BLOCKED", "No plain-text part");
  const textUrls = new Set((String(text).match(/https?:\/\/[^\s<>"')]+/gi) || []).map((url) => url.replace(/[.,;]+$/, "")));
  const missing = [...new Set(htmlLinks(html))].filter((href) => !textUrls.has(href));
  const htmlWords = visibleWords(html);
  const plainWords = wordsOf(text);
  const shared = [...htmlWords].filter((word) => plainWords.has(word)).length;
  const coverage = htmlWords.size ? shared / htmlWords.size : 1;
  const problems = [];
  if (missing.length) problems.push(`${missing.length} link(s) only in HTML (${missing.slice(0, 3).join(", ")})`);
  if (coverage < 0.8) problems.push(`plain text covers ${Math.round(coverage * 100)}% of the HTML wording`);
  return check("plaintext_consistency", problems.length ? "WARNING" : "PASS", problems.length ? problems.join("; ") : `Plain text present; links and wording match (${Math.round(coverage * 100)}%)`);
}

function linkTrackingCheck(classification, config) {
  const declared = deliverabilityConfig(config).providerClickTracking;
  if (classification === "TRANSACTIONAL_SECURITY") {
    if (declared === "on") return check("link_tracking", "BLOCKED", "Provider click tracking is declared ON: it would rewrite links in a security message");
    if (declared === "off") return check("link_tracking", "PASS", "Provider click tracking declared OFF (operator setting, not read from the provider)");
    return check("link_tracking", "UNKNOWN", "Provider click tracking state is unknown; security messages must not have rewritten links (set MAIL_MARKETING_PROVIDER_CLICK_TRACKING after checking the provider dashboard)");
  }
  if (declared === "on") return check("link_tracking", "PASS", "Provider click tracking declared ON: links are rewritten through the provider's tracking domain");
  if (declared === "off") return check("link_tracking", "PASS", "Provider click tracking declared OFF");
  return check("link_tracking", "UNKNOWN", "Provider click tracking state is not known (not exposed by the adapter; declare with MAIL_MARKETING_PROVIDER_CLICK_TRACKING)");
}

// Checks over a raw (un-personalized) render: unsubscribe, identity,
// plaintext consistency, link tracking.
function contentChecks({ rendered, classification = "MARKETING", brandSettings = null, config }) {
  const transactional = TRANSACTIONAL_CLASSES.has(classification);
  const checks = [];
  if (transactional) checks.push(check("unsubscribe_present", "PASS", "Not required: transactional service message (no marketing footer)"));
  else {
    const present = /href="\{\{unsubscribe_url\}\}"/.test(rendered.html) && /\{\{unsubscribe_url\}\}/.test(rendered.text);
    checks.push(fromOk("unsubscribe_present", present, present ? "Unsubscribe link in HTML and plain text (plus List-Unsubscribe headers at send)" : "Unsubscribe link missing"));
  }
  const name = rendered.brand?.name;
  const postal = brandSettings?.postalAddress || rendered.brand?.postalAddress;
  const identityStatus = name && postal ? "PASS" : transactional && name ? "WARNING" : "BLOCKED";
  checks.push(check("business_identity", identityStatus, name && postal ? `Sent as ${name}; postal address in the footer` : `${name ? `Sent as ${name}` : "No brand name"}; ${postal ? "postal address present" : "no postal address"}`));
  checks.push(plaintextConsistency(rendered.html, rendered.text));
  checks.push(linkTrackingCheck(classification, config));
  return checks;
}

// Shared by campaign preflight and automation steps.
async function deliverabilityChecks({ client, config, organizationId, sender, rendered, classification = "MARKETING", brandSettings = null, clock, validateDomain, marketingAccount, quotaState }) {
  const checks = [];
  const registered = deliverabilityFor(client);
  if (sender) checks.push(...(await domainChecks({ sender, organizationId, validateDomain: validateDomain ?? registered.validateDomain, marketingAccount: marketingAccount ?? registered.marketingAccount, config })));
  checks.push(await reputationCheck({ client, config, organizationId, clock }));
  if ((quotaState ?? registered.quotaState) && !TRANSACTIONAL_CLASSES.has(classification)) checks.push(await providerQuotaCheck({ organizationId, quotaState: quotaState ?? registered.quotaState }));
  if (rendered) checks.push(...contentChecks({ rendered, classification, brandSettings, config }));
  return checks;
}

// ---- template QA -----------------------------------------------------------
const COMPAT_RULES = [
  { id: "script", pattern: /<script\b/i, status: "BLOCKED", detail: "<script> is removed by every email client and marks mail as unsafe" },
  { id: "form", pattern: /<(form|input|select|textarea)\b/i, status: "BLOCKED", detail: "Forms are unsupported or disabled in most clients (Gmail, Outlook)" },
  { id: "embedded_content", pattern: /<(iframe|object|embed)\b/i, status: "BLOCKED", detail: "iframe/object/embed are stripped by email clients" },
  { id: "external_stylesheet", pattern: /<link\b[^>]*rel\s*=\s*["']?stylesheet/i, status: "WARNING", detail: "External stylesheets are ignored by Gmail and Outlook; inline the CSS" },
  { id: "css_import", pattern: /@import\b/i, status: "WARNING", detail: "@import is unsupported by most clients" },
  { id: "flexbox", pattern: /display\s*:\s*(inline-)?flex\b/i, status: "WARNING", detail: "Flexbox is unsupported in Outlook (Windows) and older Gmail apps; use tables" },
  { id: "grid", pattern: /display\s*:\s*(inline-)?grid\b/i, status: "WARNING", detail: "CSS grid is unsupported in Outlook and Gmail" },
  { id: "position", pattern: /position\s*:\s*(absolute|fixed|relative|sticky)\b/i, status: "WARNING", detail: "CSS position is stripped by Gmail and Outlook" },
  { id: "background_image", pattern: /background(-image)?\s*:[^;"']*url\(/i, status: "WARNING", detail: "CSS background images are ignored by Outlook (Windows)" },
  { id: "web_fonts", pattern: /@font-face|fonts\.googleapis\.com/i, status: "WARNING", detail: "Web fonts fall back in Outlook and Gmail; keep a safe font stack" },
  { id: "svg", pattern: /<svg\b/i, status: "WARNING", detail: "Inline SVG is not rendered by Gmail or Outlook" },
  { id: "media", pattern: /<(video|audio)\b/i, status: "WARNING", detail: "Video/audio elements are unsupported in most clients" },
  { id: "css_animation", pattern: /(animation|transition)\s*:/i, status: "WARNING", detail: "CSS animations/transitions are unsupported in Outlook and Gmail" },
  { id: "css_variables", pattern: /var\(--/i, status: "WARNING", detail: "CSS custom properties are unsupported in Outlook and Gmail" },
];

function lintEmailCompatibility(html) {
  return COMPAT_RULES.filter((rule) => rule.pattern.test(String(html || ""))).map((rule) => ({ id: rule.id, status: rule.status, detail: rule.detail }));
}

function luminance(hex) {
  const value = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  const channel = (index) => {
    const c = parseInt(value.slice(index, index + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrastRatio(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  if (a == null || b == null) return null;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function accessibilityQa(blocks, brand, html) {
  const checks = [];
  const images = blocks.filter((block) => block.type === "image");
  const missingAlt = images.filter((block) => !String(block.alt || "").trim()).length;
  checks.push(check("a11y_alt_text", missingAlt ? "WARNING" : "PASS", images.length ? (missingAlt ? `${missingAlt} of ${images.length} image(s) have no alt text` : `${images.length} image(s) have alt text`) : "No images"));
  const vague = blocks.filter((block) => block.type === "button" && /^(click here|here|link|more|read more|click)$/i.test(String(block.label || "").trim())).length;
  checks.push(check("a11y_link_text", vague ? "WARNING" : "PASS", vague ? `${vague} button(s) use non-descriptive text` : "Link text is descriptive"));
  const pairs = [
    ["button text on brand colour", "#FFFFFF", brand.primaryColor],
    ["body text", brand.textColor, "#FFFFFF"],
    ["links on white", brand.primaryColor, "#FFFFFF"],
    ["footer text", "#6B7280", "#FFFFFF"],
  ];
  const low = pairs.map(([label, fg, bg]) => ({ label, ratio: contrastRatio(fg, bg) })).filter((pair) => pair.ratio != null && pair.ratio < 4.5);
  checks.push(check("a11y_contrast", low.length ? "WARNING" : "PASS", low.length ? `Below WCAG AA 4.5:1: ${low.map((pair) => `${pair.label} ${pair.ratio.toFixed(2)}:1`).join(", ")}` : "Brand colour pairs meet WCAG AA (4.5:1)"));
  const lang = (String(html).match(/<html[^>]*\blang="([^"]+)"/i) || [])[1];
  checks.push(check("a11y_lang", lang ? "PASS" : "WARNING", lang ? `lang="${lang}"` : "No lang attribute"));
  const levels = blocks.filter((block) => block.type === "heading").map((block) => Number(block.level) || 1);
  let headingProblem = null;
  if (!levels.length) headingProblem = "No heading";
  else if (levels[0] !== 1) headingProblem = `First heading is H${levels[0]}, expected H1`;
  else for (let index = 1; index < levels.length; index += 1) if (levels[index] > levels[index - 1] + 1) headingProblem = `Heading level skips from H${levels[index - 1]} to H${levels[index]}`;
  checks.push(check("a11y_heading_order", headingProblem ? "WARNING" : "PASS", headingProblem || `Headings in order (${levels.map((level) => `H${level}`).join(", ")})`));
  return checks;
}

function usedVariables({ subject, preheader, blocks }) {
  const found = new Set();
  const collect = (value) => {
    for (const match of String(value || "").matchAll(VARIABLE)) found.add(match[1]);
  };
  collect(subject);
  collect(preheader);
  for (const block of blocks) ["text", "label", "url", "alt"].forEach((key) => collect(block[key]));
  return [...found];
}

function personalizationCheck(content, sample) {
  const findings = [];
  for (const name of usedVariables(content).filter((variable) => !SYSTEM_VARIABLES.has(variable))) {
    if (sample[name] == null || sample[name] === "") findings.push(`{{${name}}} has no value in the sample contact`);
    else if (NULLABLE_VARIABLES.has(name)) findings.push(`{{${name}}} has no fallback: renders empty for contacts without it`);
  }
  return check("missing_personalization", findings.length ? "WARNING" : "PASS", findings.length ? findings.join("; ") : "Every variable has a value");
}

function canonicalLocale(locale) {
  try {
    return Intl.getCanonicalLocales(String(locale || "en"))[0] || "en";
  } catch {
    return "en";
  }
}

function darkVariant(html) {
  // Simulates a client that forces dark mode by inverting colours.
  const style = `<meta name="color-scheme" content="dark"><style>html,body{background:#121212 !important}body{filter:invert(0.9) hue-rotate(180deg)}img{filter:invert(1) hue-rotate(180deg)}</style>`;
  return /<head>/i.test(html) ? html.replace(/<head>/i, `<head>${style}`) : `${style}${html}`;
}

function cleanSample(sampleData) {
  const output = { ...DEFAULT_SAMPLE };
  if (sampleData && typeof sampleData === "object") {
    for (const [key, value] of Object.entries(sampleData)) if (/^[a-z_]{1,40}$/.test(key) && value != null) output[key] = String(value).slice(0, 200);
  }
  return output;
}

function renderSafely(content, options) {
  try {
    return { rendered: renderTemplate(content, options), error: null };
  } catch (error) {
    if (error?.details || error?.code) return { rendered: null, error: { code: error.code || "RENDER_FAILED", details: error.details || null } };
    throw error;
  }
}

// QA report for one stored template version.
function runTemplateQa({ version, classification = "MARKETING", approval = null, brandSettings = null, config, allowedLinkDomains = [], locale, sampleData, clock = () => new Date() }) {
  const content = { subject: version.subject, preheader: version.preheader, blocks: version.blocks, brand: { ...(version.brand || {}), ...(brandSettings?.postalAddress ? { postalAddress: brandSettings.postalAddress } : {}) } };
  const resolvedLocale = canonicalLocale(locale);
  const sample = cleanSample(sampleData);
  if (!TRANSACTIONAL_CLASSES.has(classification)) sample.unsubscribe_url = sample.unsubscribe_url || "https://example.invalid/unsubscribe-preview";
  const now = clock();
  const formatted = {
    date: new Intl.DateTimeFormat(resolvedLocale, { dateStyle: "long", timeZone: "UTC" }).format(now),
    number: new Intl.NumberFormat(resolvedLocale).format(1234567.89),
    currency: new Intl.NumberFormat(resolvedLocale, { style: "currency", currency: /^[A-Z]{3}$/.test(String(sampleData?.currency || "")) ? sampleData.currency : "USD" }).format(1234.5),
  };
  const checks = [];
  const raw = renderSafely(content, { classification, allowedLinkDomains });
  if (!raw.rendered) {
    checks.push(check("template_renders", "BLOCKED", `${raw.error.code}: the version violates the ${classification} content policy`, { errors: raw.error.details }));
    return { versionId: version.id, version: version.version, classification, disclaimer: QA_DISCLAIMER, locale: resolvedLocale, sampleContact: sample, formatted, brandTokens: null, renders: null, checks, summary: summarize(checks), compatibility: [] };
  }
  const personalized = renderTemplate(content, { classification, allowedLinkDomains, data: sample });
  const localizedHtml = personalized.html.replace(/<html lang="[^"]*">/i, `<html lang="${resolvedLocale}">`);
  checks.push(check("template_renders", "PASS", `${raw.rendered.variables.length} variable(s); classification ${classification}`));
  // Approval state.
  if (classification === "TRANSACTIONAL_SECURITY") checks.push(check("approvals_state", approval?.approved ? "PASS" : "BLOCKED", approval?.approved ? "Version approved by a second person" : "Security templates need a version approval by someone other than the author"));
  else if (classification === "TRANSACTIONAL") checks.push(check("approvals_state", "PASS", approval?.approved ? "Version approved by a second person" : "No template approval required"));
  else checks.push(check("approvals_state", "PASS", "Reviewed and approved per campaign/automation (two-person review)"));
  checks.push(...contentChecks({ rendered: raw.rendered, classification, brandSettings, config }));
  // Links (offline; nothing is fetched).
  const links = scanLinks(raw.rendered.html);
  const linkProblems = links.issues.map((issue) => `${issue.kind}: ${issue.detail}`);
  if (classification === "TRANSACTIONAL_SECURITY") {
    for (const href of htmlLinks(raw.rendered.html)) {
      let host = null;
      try {
        host = new URL(href).hostname;
      } catch { /* reported by the scan */ }
      if (host && !hostAllowed(host, allowedLinkDomains)) linkProblems.push(`NOT_ALLOWLISTED: ${host}`);
    }
  }
  checks.push(check("links_safe", linkProblems.length ? "BLOCKED" : "PASS", linkProblems.length ? linkProblems.slice(0, 5).join("; ") : `${links.linkCount} link(s) checked offline (not fetched)`));
  if (TRANSACTIONAL_CLASSES.has(classification)) {
    const promo = [content.subject, content.preheader, ...content.blocks.flatMap((block) => [block.text, block.label])].some(hasPromotionalCopy);
    checks.push(check("promotional_copy", promo ? "WARNING" : "PASS", promo ? "Promotional wording found in a transactional message" : "No promotional wording found (heuristic)"));
  }
  checks.push(personalizationCheck(content, sample));
  checks.push(...accessibilityQa(content.blocks, raw.rendered.brand, localizedHtml));
  const supportsDarkMode = /prefers-color-scheme|color-scheme/i.test(raw.rendered.html);
  checks.push(check("dark_mode", supportsDarkMode ? "PASS" : "WARNING", supportsDarkMode ? "Template declares dark-mode styles" : "No dark-mode styles: clients apply their own colour inversion (simulated in the dark preview)"));
  const compatibility = lintEmailCompatibility(raw.rendered.html);
  const compatStatus = compatibility.some((entry) => entry.status === "BLOCKED") ? "BLOCKED" : compatibility.length ? "WARNING" : "PASS";
  checks.push(check("client_compatibility", compatStatus, compatibility.length ? compatibility.map((entry) => entry.id).join(", ") : "No known-unsupported HTML/CSS found (static heuristics)"));
  return {
    versionId: version.id,
    version: version.version,
    classification,
    disclaimer: QA_DISCLAIMER,
    locale: resolvedLocale,
    sampleContact: sample,
    formatted,
    brandTokens: { ...raw.rendered.brand, applied: true },
    renders: {
      subject: personalized.subject,
      desktop: { width: 600, html: localizedHtml },
      mobile: { width: 375, html: localizedHtml },
      dark: { html: darkVariant(localizedHtml), supportsDarkMode, simulated: true },
      plaintext: personalized.text,
    },
    checks,
    summary: summarize(checks),
    compatibility,
  };
}

module.exports = {
  check, fromOk, summarize, preflightHash, deliverabilityConfig, registerDeliverability, deliverabilityFor, providerQuotaCheck,
  domainChecks, reputationCheck, contentChecks, plaintextConsistency, linkTrackingCheck, deliverabilityChecks,
  lintEmailCompatibility, contrastRatio, runTemplateQa, QA_DISCLAIMER, STATUSES, COMPAT_RULES,
};
