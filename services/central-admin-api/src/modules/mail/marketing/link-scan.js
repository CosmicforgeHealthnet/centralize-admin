"use strict";

// Campaign preflight link and phishing scan (spec §13.2 step 4). Deterministic,
// offline heuristics over the rendered HTML; no URL is fetched (no SSRF).
// Flags: non-HTTPS links, script/data/file schemes, raw IP hosts, punycode
// look-alike hosts, known link shorteners (hide the destination), and anchor
// text that shows one domain while the link goes to another.

const SHORTENERS = new Set(["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "cutt.ly", "rebrand.ly", "shorturl.at", "tiny.cc", "rb.gy"]);
const PLACEHOLDER = /\{\{\{?[^}]+\}\}\}?/;

function decodeEntities(value) {
  return String(value).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function scanLinks(html) {
  const issues = [];
  const anchors = [...String(html || "").matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)];
  for (const match of anchors) {
    const href = decodeEntities((match[2] ?? match[3] ?? "").trim());
    const text = decodeEntities(String(match[4] || "").replace(/<[^>]+>/g, " ")).trim();
    if (!href || PLACEHOLDER.test(href) || /^(mailto|tel):/i.test(href) || href.startsWith("#")) continue;
    const scheme = (href.match(/^([a-z][a-z0-9+.-]*):/i) || [])[1]?.toLowerCase();
    if (scheme && !["http", "https"].includes(scheme)) {
      issues.push({ kind: "UNSAFE_SCHEME", detail: scheme });
      continue;
    }
    const host = hostOf(href);
    if (!host) {
      issues.push({ kind: "INVALID_URL", detail: href.slice(0, 80) });
      continue;
    }
    if (scheme === "http") issues.push({ kind: "NOT_HTTPS", detail: host });
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) issues.push({ kind: "IP_HOST", detail: host });
    if (host.split(".").some((label) => label.startsWith("xn--"))) issues.push({ kind: "PUNYCODE_HOST", detail: host });
    if (SHORTENERS.has(host)) issues.push({ kind: "LINK_SHORTENER", detail: host });
    const shown = text.match(/\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/\S*)?/i);
    if (shown) {
      const shownHost = hostOf(/^https?:\/\//i.test(shown[1]) ? shown[1] : `https://${shown[1]}`);
      const sameSite = (a, b) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
      if (shownHost && !sameSite(shownHost, host)) issues.push({ kind: "MISLEADING_TEXT", detail: `${shownHost} -> ${host}` });
    }
  }
  return { ok: issues.length === 0, linkCount: anchors.length, issues };
}

module.exports = { scanLinks };
