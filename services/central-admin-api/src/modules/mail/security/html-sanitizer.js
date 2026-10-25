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
const UNSAFE_CSS = /(expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import|url\s*\()/i;

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
        if (UNSAFE_CSS.test(value)) return "";
        return `style="${String(value).replace(/"/g, "&quot;")}"`;
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
  const output = filter.process(String(html ?? ""));
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

module.exports = { sanitizeEmailHtml, escapeHtml, htmlToText, textToHtml, snippetOf };
