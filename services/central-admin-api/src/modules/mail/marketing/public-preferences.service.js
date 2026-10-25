"use strict";

// Public (unauthenticated) recipient endpoints, authorised only by signed
// tokens: unsubscribe / preference page, RFC 8058 one-click unsubscribe and
// the double opt-in confirmation landing page. Pages are minimal HTML with a
// strict CSP, no scripts, no tracking and no third-party resources; state
// changes need a POST (a link scanner's GET never changes consent).

const { verifyUnsubscribeToken } = require("./unsubscribe-token");
const { enforceWithdrawal } = require("./consent-enforcement");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  return `${local.slice(0, 1)}${"*".repeat(Math.max(1, Math.min(local.length - 1, 6)))}@${domain}`;
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head><body style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#1F2937;line-height:1.5;"><main><h1 style="font-size:22px;">${escapeHtml(title)}</h1>${body}</main></body></html>`;
}

const button = "display:inline-block;margin:6px 8px 6px 0;padding:10px 16px;border-radius:8px;border:1px solid #272EA7;background:#272EA7;color:#fff;font-size:15px;cursor:pointer;";
const secondary = "display:inline-block;margin:6px 8px 6px 0;padding:10px 16px;border-radius:8px;border:1px solid #272EA7;background:#fff;color:#272EA7;font-size:15px;cursor:pointer;";

function createPublicPreferencesService({ client, config, audit, marketing, clock = () => new Date() }) {
  const secrets = () => [config.unsubscribe.secret, config.unsubscribe.previousSecret];

  async function resolve(token) {
    if (!config.marketingEnabled) return null;
    const claims = verifyUnsubscribeToken(token, secrets());
    if (!claims) return null;
    const contact = await client.marketingContact.findUnique({ where: { id: claims.contactId }, include: { consents: true } }).catch(() => null);
    if (!contact || contact.organizationId !== claims.organizationId) return null;
    const organization = await client.mailOrganization.findUnique({ where: { id: claims.organizationId } });
    return { claims, contact, organization };
  }

  async function renderPreferences(token) {
    const resolved = await resolve(token);
    if (!resolved) return { status: 404, html: page("Link not valid", "<p>This link is not valid or has expired. If you keep receiving emails you did not ask for, reply to one and ask to be removed.</p>") };
    const { claims, contact, organization } = resolved;
    const active = contact.consents.filter((consent) => consent.status !== "WITHDRAWN");
    const topicForm = claims.topic !== "*" && active.some((consent) => consent.topic === claims.topic)
      ? `<form method="post"><input type="hidden" name="scope" value="topic"><button type="submit" style="${secondary}">Stop emails about ${escapeHtml(claims.topic)}</button></form>`
      : "";
    const list = active.length ? `<p>You are subscribed to: ${active.map((consent) => `<strong>${escapeHtml(consent.topic)}</strong>`).join(", ")}.</p>` : "<p>You are not subscribed to any topics.</p>";
    return {
      status: 200,
      html: page(`${organization.name} email preferences`, `<p>Email: ${escapeHtml(maskEmail(contact.email))}</p>${list}${topicForm}<form method="post"><input type="hidden" name="scope" value="all"><button type="submit" style="${button}">Unsubscribe from all ${escapeHtml(organization.name)} marketing</button></form><p style="font-size:12px;color:#6B7280;">Transactional messages about your account or bookings are not affected.</p>`),
    };
  }

  // scope "all" | "topic". RFC 8058 one-click (body List-Unsubscribe=One-Click)
  // unsubscribes from the topic the message belonged to, or all when the
  // token is brand-wide.
  async function unsubscribe(token, { scope, oneClick = false, ipAddress = null } = {}) {
    const resolved = await resolve(token);
    if (!resolved) return { status: 404, ok: false };
    const { claims, contact, organization } = resolved;
    const topicScoped = (oneClick || scope === "topic") && claims.topic !== "*";
    const result = await client.$transaction(async (tx) => {
      const applied = await enforceWithdrawal(tx, { organizationId: organization.id, contactId: contact.id, topic: topicScoped ? claims.topic : null, reason: "UNSUBSCRIBED", source: oneClick ? "one_click" : "preference_page", now: clock() });
      await audit.record({ action: oneClick ? "MARKETING_ONE_CLICK_UNSUBSCRIBE" : "MARKETING_UNSUBSCRIBE", targetType: "marketing_contact", targetId: contact.id, organizationId: organization.id, metadata: { scope: topicScoped ? "topic" : "all", topic: topicScoped ? claims.topic : null, withdrawn: applied.withdrawn } }, { ipAddress }, tx);
      return applied;
    });
    const message = topicScoped ? `You will no longer receive ${organization.name} emails about ${claims.topic}.` : `You will no longer receive marketing emails from ${organization.name}.`;
    return { status: 200, ok: true, result, html: page("You are unsubscribed", `<p>${escapeHtml(message)}</p><p style="font-size:12px;color:#6B7280;">It can take a short while for messages already on their way to stop.</p>`) };
  }

  function confirmationLanding(token) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || "")) || !config.marketingEnabled) return { status: 404, html: page("Link not valid", "<p>This confirmation link is not valid.</p>") };
    return { status: 200, html: page("Confirm your subscription", `<p>Press the button to confirm that you want to receive these emails.</p><form method="post"><button type="submit" style="${button}">Confirm subscription</button></form>`) };
  }

  async function confirm(token) {
    try {
      await marketing.confirmConsent(token);
      return { status: 200, html: page("Subscription confirmed", "<p>Thank you. Your subscription is confirmed. You can unsubscribe at any time from the link in each email.</p>") };
    } catch {
      return { status: 404, html: page("Link not valid", "<p>This confirmation link is not valid or was already used.</p>") };
    }
  }

  return { renderPreferences, unsubscribe, confirmationLanding, confirm, PAGE_HEADERS };
}

module.exports = { createPublicPreferencesService, PAGE_HEADERS, maskEmail };
