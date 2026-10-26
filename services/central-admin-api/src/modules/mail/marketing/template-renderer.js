"use strict";

// Email-safe, table-based renderer for Marketing Email Studio blocks. All
// user text is escaped; only a fixed set of personalization variables is
// allowed; links/images must be https; an unsubscribe link is always present
// for MARKETING templates.
//
// Template classification (gap 1): MARKETING (default) keeps the mandatory
// unsubscribe + consent + postal address footer. TRANSACTIONAL and
// TRANSACTIONAL_SECURITY render a service footer without the marketing
// unsubscribe text and refuse:
// - promotional blocks: the reserved promotional block types (hero, promo,
//   coupon, product; not part of the builder) and clickable image banners
//   (an image block with href);
// - marketing-only personalization ({{unsubscribe_url}}).
// TRANSACTIONAL_SECURITY additionally refuses remote images (image blocks and
// a brand logo), links (buttons or URLs in text) outside the allow-listed
// brand domains, promotional copy, and an empty plaintext part.
// MARKETING output and its contentSha256 are byte-for-byte unchanged.

const crypto = require("crypto");
const { escapeHtml } = require("../security/html-sanitizer");

const ALLOWED_VARIABLES = new Set(["first_name", "last_name", "email", "brand_name", "unsubscribe_url"]);
const BLOCK_TYPES = new Set(["heading", "text", "button", "image", "divider", "spacer", "footer"]);
const VARIABLE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_BLOCKS = 60;
const CLASSIFICATIONS = ["MARKETING", "TRANSACTIONAL", "TRANSACTIONAL_SECURITY"];
const TRANSACTIONAL_CLASSES = new Set(["TRANSACTIONAL", "TRANSACTIONAL_SECURITY"]);
// Reserved promotional block types: not offered by the builder (so MARKETING
// rejects them as UNSUPPORTED), refused with an explicit reason for
// transactional templates.
const PROMOTIONAL_BLOCK_TYPES = new Set(["hero", "promo", "coupon", "product"]);
const MARKETING_ONLY_VARIABLES = new Set(["unsubscribe_url"]);
// Heuristic promotional-copy detector (English). Refused in
// TRANSACTIONAL_SECURITY, reported by template QA for TRANSACTIONAL.
const PROMOTIONAL_COPY = /\b(sale|discount|coupon|promo(?:tion|tional)?(?:\s+code)?|voucher|% off|\d+\s?% off|limited[- ]time|buy now|shop now|order now|free shipping|special offer|deal of|exclusive offer|upgrade now|subscribe now|black friday|cyber monday)\b/i;
const URL_IN_TEXT = /https?:\/\/[^\s<>"')]+/gi;

class TemplateError extends Error {
  constructor(code, details) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

function safeUrl(value, { allowVariable = false } = {}) {
  const url = String(value || "").trim();
  if (allowVariable && /^\{\{\s*unsubscribe_url\s*\}\}$/.test(url)) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  return parsed.toString();
}

function collectVariables(text, found) {
  for (const match of String(text || "").matchAll(VARIABLE)) found.add(match[1]);
}

function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_(.+?)_(?=[\s).,!?]|$)/g, "$1<em>$2</em>")
    .replace(/\r?\n/g, "<br>");
}

function normalizeBrand(brand = {}) {
  // Physical postal address (required in marketing mail); plain text only.
  // Omitted when absent so existing template hashes are unchanged.
  const postalAddress = brand.postalAddress ? String(brand.postalAddress).replace(/[\u0000-\u001f<>{}]/g, " ").trim().slice(0, 500) : "";
  return {
    name: String(brand.name || "CosmicForge").slice(0, 80),
    primaryColor: COLOR.test(brand.primaryColor || "") ? brand.primaryColor : "#272EA7",
    textColor: COLOR.test(brand.textColor || "") ? brand.textColor : "#1F2937",
    backgroundColor: COLOR.test(brand.backgroundColor || "") ? brand.backgroundColor : "#F4F5FB",
    logoUrl: brand.logoUrl ? safeUrl(brand.logoUrl) : null,
    ...(postalAddress ? { postalAddress } : {}),
  };
}

function hostAllowed(host, allowedDomains) {
  const value = String(host || "").toLowerCase();
  return allowedDomains.some((domain) => value === domain || value.endsWith(`.${domain}`));
}

function hostOfUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hasPromotionalCopy(value) {
  return PROMOTIONAL_COPY.test(String(value || ""));
}

// Classification content policy for transactional templates (see header).
function classificationErrors(blocks, { classification, allowedLinkDomains = [], brand = {}, subject = "", preheader = "" }) {
  if (!TRANSACTIONAL_CLASSES.has(classification)) return [];
  const errors = [];
  const security = classification === "TRANSACTIONAL_SECURITY";
  const domains = [...new Set(allowedLinkDomains.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean))];
  const checkLink = (value, field) => {
    const host = hostOfUrl(value);
    if (!host || !hostAllowed(host, domains)) errors.push({ field, reason: "EXTERNAL_LINK_NOT_ALLOWED", host: host || null });
  };
  (Array.isArray(blocks) ? blocks : []).forEach((block, index) => {
    if (!block) return;
    if (PROMOTIONAL_BLOCK_TYPES.has(block.type)) return errors.push({ field: `blocks[${index}].type`, reason: "PROMOTIONAL_BLOCK_NOT_ALLOWED" });
    if (block.type === "image" && block.href) errors.push({ field: `blocks[${index}].href`, reason: "PROMOTIONAL_BLOCK_NOT_ALLOWED", detail: "clickable image banner" });
    if (!security) return;
    if (block.type === "image") errors.push({ field: `blocks[${index}].src`, reason: "REMOTE_IMAGE_NOT_ALLOWED" });
    if (block.type === "button" && !/^\{\{/.test(String(block.url || "").trim())) checkLink(block.url, `blocks[${index}].url`);
    for (const key of ["text", "label"]) {
      if (typeof block[key] !== "string") continue;
      if (hasPromotionalCopy(block[key])) errors.push({ field: `blocks[${index}].${key}`, reason: "PROMOTIONAL_COPY_NOT_ALLOWED" });
      for (const match of block[key].matchAll(URL_IN_TEXT)) checkLink(match[0], `blocks[${index}].${key}`);
    }
  });
  if (security) {
    if (brand?.logoUrl) errors.push({ field: "brand.logoUrl", reason: "REMOTE_IMAGE_NOT_ALLOWED" });
    if (hasPromotionalCopy(subject) || hasPromotionalCopy(preheader)) errors.push({ field: "subject", reason: "PROMOTIONAL_COPY_NOT_ALLOWED" });
  }
  return errors;
}

function validateBlocks(blocks, { classification = "MARKETING" } = {}) {
  const errors = [];
  if (!Array.isArray(blocks) || !blocks.length) errors.push({ field: "blocks", reason: "REQUIRED" });
  else if (blocks.length > MAX_BLOCKS) errors.push({ field: "blocks", reason: "TOO_MANY" });
  (Array.isArray(blocks) ? blocks : []).forEach((block, index) => {
    if (block && PROMOTIONAL_BLOCK_TYPES.has(block.type) && TRANSACTIONAL_CLASSES.has(classification)) return; // reported by classificationErrors
    if (!block || !BLOCK_TYPES.has(block.type)) return errors.push({ field: `blocks[${index}].type`, reason: "UNSUPPORTED" });
    const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
    if (block.type === "heading" && !text(block.text, 300)) errors.push({ field: `blocks[${index}].text` });
    if ((block.type === "text" || block.type === "footer") && !text(block.text, 5000)) errors.push({ field: `blocks[${index}].text` });
    if (block.type === "button") {
      if (!text(block.label, 80)) errors.push({ field: `blocks[${index}].label` });
      if (!safeUrl(block.url, { allowVariable: true })) errors.push({ field: `blocks[${index}].url`, reason: "HTTPS_REQUIRED" });
    }
    if (block.type === "image") {
      if (!safeUrl(block.src)) errors.push({ field: `blocks[${index}].src`, reason: "HTTPS_REQUIRED" });
      if (typeof block.alt !== "string" || block.alt.length > 300) errors.push({ field: `blocks[${index}].alt` });
      if (block.href && !safeUrl(block.href)) errors.push({ field: `blocks[${index}].href`, reason: "HTTPS_REQUIRED" });
    }
  });
  return errors;
}

function accessibilityChecks(blocks, subject) {
  const warnings = [];
  if (!blocks.some((block) => block.type === "heading")) warnings.push({ id: "heading", detail: "Add a heading so screen readers can navigate the email." });
  blocks.forEach((block, index) => {
    if (block.type === "image" && !String(block.alt || "").trim()) warnings.push({ id: "image-alt", detail: `Image ${index + 1} has no alt text.` });
    if (block.type === "button" && /^(click here|here|link)$/i.test(String(block.label || "").trim())) warnings.push({ id: "link-text", detail: `Button ${index + 1} needs descriptive text.` });
  });
  if (!String(subject || "").trim()) warnings.push({ id: "subject", detail: "Subject is empty." });
  return warnings;
}

function renderTemplate({ subject, preheader, blocks, brand }, { data = null, classification = "MARKETING", allowedLinkDomains = [] } = {}) {
  if (!CLASSIFICATIONS.includes(classification)) throw new TemplateError("MAIL_VALIDATION_FAILED", [{ field: "classification", reason: "UNSUPPORTED" }]);
  const transactional = TRANSACTIONAL_CLASSES.has(classification);
  const errors = validateBlocks(blocks, { classification });
  const cleanSubject = String(subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 998);
  if (!cleanSubject) errors.push({ field: "subject", reason: "REQUIRED" });
  errors.push(...classificationErrors(blocks, { classification, allowedLinkDomains, brand, subject: cleanSubject, preheader }));
  if (errors.length) throw new TemplateError("MAIL_VALIDATION_FAILED", errors);
  const resolvedBrand = normalizeBrand(brand);
  const variables = new Set();
  collectVariables(cleanSubject, variables);
  collectVariables(preheader, variables);
  for (const block of blocks) ["text", "label", "url", "alt"].forEach((key) => collectVariables(block[key], variables));
  const unknown = [...variables].filter((name) => !ALLOWED_VARIABLES.has(name));
  if (unknown.length) throw new TemplateError("MAIL_TEMPLATE_INVALID_VARIABLE", unknown.map((name) => ({ variable: name })));
  const marketingOnly = transactional ? [...variables].filter((name) => MARKETING_ONLY_VARIABLES.has(name)) : [];
  if (marketingOnly.length) throw new TemplateError("MAIL_TEMPLATE_INVALID_VARIABLE", marketingOnly.map((name) => ({ variable: name, reason: "MARKETING_ONLY_VARIABLE" })));

  const htmlParts = [];
  const textParts = [];
  const p = resolvedBrand;
  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const size = { 1: 26, 2: 21, 3: 18 }[block.level] || 26;
        htmlParts.push(`<tr><td style="padding:12px 32px 4px;font-family:Arial,Helvetica,sans-serif;font-size:${size}px;line-height:1.3;font-weight:bold;color:${p.textColor};" role="heading" aria-level="${block.level || 1}">${inline(block.text)}</td></tr>`);
        textParts.push(String(block.text).toUpperCase(), "");
        break;
      }
      case "text":
        htmlParts.push(`<tr><td style="padding:8px 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:${p.textColor};">${inline(block.text)}</td></tr>`);
        textParts.push(String(block.text).replace(/\*\*|_/g, ""), "");
        break;
      case "button": {
        const url = safeUrl(block.url, { allowVariable: true });
        htmlParts.push(`<tr><td style="padding:16px 32px;" align="left"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:8px;background:${p.primaryColor};"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(block.label)}</a></td></tr></table></td></tr>`);
        textParts.push(`${block.label}: ${url}`, "");
        break;
      }
      case "image": {
        const width = Math.min(Math.max(Number(block.width) || 536, 40), 536);
        const image = `<img src="${escapeHtml(safeUrl(block.src))}" alt="${escapeHtml(block.alt || "")}" width="${width}" style="display:block;max-width:100%;height:auto;border:0;">`;
        htmlParts.push(`<tr><td style="padding:8px 32px;">${block.href ? `<a href="${escapeHtml(safeUrl(block.href))}">${image}</a>` : image}</td></tr>`);
        if (block.alt) textParts.push(`[${block.alt}]`, "");
        break;
      }
      case "divider":
        htmlParts.push(`<tr><td style="padding:12px 32px;"><hr style="border:0;border-top:1px solid #E5E7EB;margin:0;"></td></tr>`);
        textParts.push("----------", "");
        break;
      case "spacer":
        htmlParts.push(`<tr><td style="height:${Math.min(Math.max(Number(block.height) || 16, 4), 96)}px;line-height:0;font-size:0;">&nbsp;</td></tr>`);
        break;
      case "footer":
        htmlParts.push(`<tr><td style="padding:16px 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#6B7280;">${inline(block.text)}</td></tr>`);
        textParts.push(String(block.text), "");
        break;
      default:
        break;
    }
  }
  if (transactional) {
    // Service footer: company identity, no marketing consent/unsubscribe text.
    htmlParts.push(`<tr><td style="padding:16px 32px 28px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6B7280;">This is a service message from {{brand_name}} about your account or request.${p.postalAddress ? `<br>${escapeHtml(p.postalAddress)}` : ""}</td></tr>`);
    textParts.push("This is a service message from {{brand_name}} about your account or request.", ...(p.postalAddress ? [p.postalAddress] : []));
  } else {
    // Mandatory unsubscribe footer (cannot be removed by template authors).
    htmlParts.push(`<tr><td style="padding:16px 32px 28px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6B7280;">You are receiving this because you opted in to {{brand_name}} updates. <a href="{{unsubscribe_url}}" style="color:${p.primaryColor};">Unsubscribe</a>${p.postalAddress ? `<br>${escapeHtml(p.postalAddress)}` : ""}</td></tr>`);
    textParts.push("You are receiving this because you opted in to {{brand_name}} updates.", "Unsubscribe: {{unsubscribe_url}}", ...(p.postalAddress ? [p.postalAddress] : []));
    variables.add("unsubscribe_url");
  }
  variables.add("brand_name");

  const logo = p.logoUrl && classification !== "TRANSACTIONAL_SECURITY" ? `<tr><td style="padding:24px 32px 8px;"><img src="${escapeHtml(p.logoUrl)}" alt="${escapeHtml(p.name)}" height="36" style="display:block;border:0;"></td></tr>` : "";
  const pre = preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(String(preheader).slice(0, 255))}</div>` : "";
  let html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(cleanSubject)}</title></head><body style="margin:0;padding:0;background:${p.backgroundColor};">${pre}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${p.backgroundColor};"><tr><td align="center" style="padding:24px 12px;"><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;">${logo}${htmlParts.join("")}</table></td></tr></table></body></html>`;
  let text = textParts.join("\n").trim();
  if (classification === "TRANSACTIONAL_SECURITY" && !text) throw new TemplateError("MAIL_VALIDATION_FAILED", [{ field: "text", reason: "PLAINTEXT_REQUIRED" }]);
  let renderedSubject = cleanSubject;
  if (data) {
    const values = { brand_name: p.name, ...data };
    const substitute = (input, escape) =>
      input.replace(VARIABLE, (_, name) => {
        const value = values[name] == null ? "" : String(values[name]);
        return escape ? escapeHtml(value) : value;
      });
    html = substitute(html, true);
    text = substitute(text, false);
    renderedSubject = substitute(renderedSubject, false).replace(/[\r\n]+/g, " ");
  }
  // MARKETING hashes exactly as before; other classes bind the class too.
  const hashInput = { subject: cleanSubject, preheader: preheader || null, blocks, brand: resolvedBrand, ...(transactional ? { classification } : {}) };
  const contentSha256 = crypto.createHash("sha256").update(JSON.stringify(hashInput)).digest("hex");
  return { subject: renderedSubject, html, text, variables: [...variables].sort(), brand: resolvedBrand, warnings: [], accessibility: accessibilityChecks(blocks, cleanSubject), contentSha256, classification };
}

module.exports = {
  renderTemplate, validateBlocks, classificationErrors, hasPromotionalCopy, hostAllowed, TemplateError, ALLOWED_VARIABLES, safeUrl,
  CLASSIFICATIONS, TRANSACTIONAL_CLASSES, PROMOTIONAL_BLOCK_TYPES, MARKETING_ONLY_VARIABLES, VARIABLE,
};
