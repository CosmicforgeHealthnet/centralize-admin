"use strict";

// Email HTML sanitization. Received HTML is hostile by default: scripts,
// event handlers, forms, iframes, CSS expressions, javascript: URLs and remote
// tracking pixels are removed. Remote images are blocked unless the caller
// explicitly allows them for a specific render. The frontend additionally
// renders inside a sandboxed iframe without script permissions.

const { FilterXSS, escapeAttrValue } = require("xss");

const ALLOWED_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "caption", "center", "code", "col", "colgroup", "dd", "del",
  "div", "dl", "dt", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins",
  "li", "ol", "p", "pre", "q", "s", "small", "span", "strike", "strong", "sub", "sup", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
];
const COMMON_ATTRS = ["style", "class", "align", "valign", "width", "height", "dir", "lang", "title"];
const TAG_ATTRS = {
  a: ["href", "title", "name"],
  img: ["src", "alt", "width", "height", "title"],
  td: ["colspan", "rowspan", "bgcolor"],
  th: ["colspan", "rowspan", "bgcolor"],
  table: ["border", "cellpadding", "cellspacing", "bgcolor"],
  font: ["color", "face", "size"],
  col: ["span"],
  colgroup: ["span"],
};

const SAFE_LINK = /^(https?:|mailto:|tel:|#)/i;
const SAFE_CID = /^cid:[A-Za-z0-9._@-]{1,200}$/i;
const SAFE_DATA_IMAGE = /^data:image\/(png|gif|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+$/i;
// Checked against the DECODED style value (HTML entities, CSS comments and
// whitespace removed), so "u&#114;l(", "\\75 rl(" or "image-set(" cannot slip
// through. Backslashes (CSS escapes) are refused outright.
const UNSAFE_CSS = /(expression\(|javascript:|vbscript:|behavior:|-moz-binding|@import|url\(|image-set\(|image\(|cross-fade\(|element\(|paint\(|position:(fixed|sticky)|\\)/i;
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", colon: ":", lpar: "(", rpar: ")", sol: "/", bsol: "\\", semi: ";", comma: ",", period: ".", excl: "!", num: "#", newline: "\n", tab: "\t" };

function decodeEntities(value) {
  return String(value ?? "").replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

// Returns the decoded style value when it is safe, otherwise null.
function safeStyle(value) {
  let decoded = String(value ?? "");
  // Decode repeatedly so nested encodings (&amp;#114;) are also inspected.
  for (let round = 0; round < 3; round += 1) {
    const next = decodeEntities(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f<>]/.test(decoded)) return null;
  const compact = decoded.replace(/\/\*[\s\S]*?(\*\/|$)/g, "").replace(/\s+/g, "");
  if (UNSAFE_CSS.test(compact)) return null;
  return decoded;
}

// Received-mail phishing hint: a link whose visible text names a different
// host than its href, or whose host is punycode (IDN look-alikes), is marked
// with data-suspicious so the viewer can flag it. The link itself is kept.
function linkHost(href) {
  try {
    const url = new URL(decodeEntities(href));
    return /^https?:$/.test(url.protocol) ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function suspiciousReason(href, inner) {
  const host = linkHost(href);
  if (!host) return null;
  if (host.split(".").some((label) => label.startsWith("xn--"))) return "punycode";
  const text = decodeEntities(inner.replace(/<[^>]*>/g, "")).trim();
  const shown = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?$/i.exec(text);
  if (!shown) return null;
  const strip = (name) => name.toLowerCase().replace(/^www\./, "");
  const named = strip(shown[1]);
  const actual = strip(host);
  return named === actual || actual.endsWith(`.${named}`) ? null : "host-mismatch";
}

function flagSuspiciousLinks(html) {
  return html.replace(/<a\s([^>]*?)href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi, (match, before, href, after, inner) => {
    const reason = suspiciousReason(href, inner);
    return reason ? `<a ${before}href="${href}" data-suspicious="${reason}"${after}>${inner}</a>` : match;
  });
}

function buildWhitelist() {
  const whiteList = {};
  for (const tag of ALLOWED_TAGS) whiteList[tag] = [...COMMON_ATTRS, ...(TAG_ATTRS[tag] || [])];
  return whiteList;
}

function sanitizeEmailHtml(html, { allowRemoteImages = false, cidResolver = null } = {}) {
  let remoteImagesBlocked = 0;
  const filter = new FilterXSS({
    whiteList: buildWhitelist(),
    stripIgnoreTag: true,
    stripIgnoreTagBody: ["script", "style", "iframe", "object", "embed", "form", "noscript", "template", "svg", "math", "head", "title", "meta", "link", "base"],
    allowCommentTag: false,
    css: false,
    onTagAttr(tag, name, value) {
      const attr = name.toLowerCase();
      if (attr.startsWith("on")) return "";
      if (attr === "style") {
        const style = safeStyle(value);
        if (style === null) return "";
        // Re-encode the value that was actually checked.
        return `style="${style.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
      }
      if (tag === "a" && attr === "href") {
        const href = String(value).trim();
        if (!SAFE_LINK.test(href)) return "";
        return `href="${href.replace(/"/g, "&quot;")}" rel="noopener noreferrer nofollow" target="_blank"`;
      }
      if (tag === "img" && attr === "src") {
        const src = String(value).trim();
        if (SAFE_CID.test(src)) {
          const resolved = cidResolver ? cidResolver(src.slice(4)) : null;
          return resolved ? `src="${resolved}"` : 'data-blocked-src="cid"';
        }
        if (SAFE_DATA_IMAGE.test(src) && src.length < 512 * 1024) return `src="${src}"`;
        if (/^https:\/\//i.test(src) && allowRemoteImages) return `src="${src.replace(/"/g, "&quot;")}"`;
        remoteImagesBlocked += 1;
        return 'data-blocked-src="remote"';
      }
      return undefined;
    },
    // Every attribute value that reaches the default path is escaped so a
    // quote inside a value can never open a new attribute (e.g. onmouseover).
    safeAttrValue(tag, name, value) {
      return escapeAttrValue(String(value ?? ""));
    },
  });
  const output = flagSuspiciousLinks(filter.process(String(html ?? "")));
  return { html: output, remoteImagesBlocked };
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlToText(html) {
  return String(html ?? "")
    .replace(/<\s*(script|style|head)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function textToHtml(text) {
  return `<div>${escapeHtml(text).replace(/\r?\n/g, "<br>")}</div>`;
}

function snippetOf(text, length = 200) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, length);
}

module.exports = { sanitizeEmailHtml, safeStyle, escapeHtml, htmlToText, textToHtml, snippetOf };
