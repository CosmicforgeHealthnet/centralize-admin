"use strict";

// POST /api/mail/v1/webhooks/resend                 (company Resend account)
// POST /api/mail/v1/webhooks/resend/brand/:slug     (a brand's marketing account)
// Raw-body routes (mounted before JSON parsing / XSS mutation in app.js).
// Acknowledges only after the event and its processing job are committed in
// one transaction. No fire-and-forget work happens after the response.
//
// Brand endpoints verify with that brand's own signing secret
// (RESEND_WEBHOOK_SECRET__<SLUG>) and stamp the brand organization id on the
// stored event, so marketing events from one brand's provider account can
// never change another brand's contacts, consents or reports. Brand endpoints
// never accept inbound mail (email.received).

const crypto = require("crypto");
const { verifyResendWebhook } = require("./resend-webhook.verifier");

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function brandSecretName(slug) {
  return `RESEND_WEBHOOK_SECRET__${String(slug).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function storedPayload(payload, providerEmailId, brandOrganizationId) {
  const data = payload.data || {};
  const isContact = String(payload.type).startsWith("contact.");
  return {
    type: payload.type,
    created_at: payload.created_at || null,
    ...(brandOrganizationId ? { brand_organization_id: brandOrganizationId } : {}),
    data: {
      email_id: providerEmailId,
      to: Array.isArray(data.to) ? data.to.slice(0, 100).map((value) => String(value).slice(0, 320)) : data.to ? [String(data.to).slice(0, 320)] : [],
      // cc/bcc (when the provider sends them) let delivery events be
      // attributed to the exact recipients instead of only the To list.
      ...(Array.isArray(data.cc) ? { cc: data.cc.slice(0, 100).map((value) => String(value).slice(0, 320)) } : {}),
      ...(Array.isArray(data.bcc) ? { bcc: data.bcc.slice(0, 100).map((value) => String(value).slice(0, 320)) } : {}),
      from: data.from ? String(data.from).slice(0, 320) : null,
      created_at: data.created_at || null,
      ...(data.broadcast_id ? { broadcast_id: String(data.broadcast_id).slice(0, 128) } : {}),
      // GAP 8: the provider's own RFC Message-ID (Resend may replace ours);
      // stored as an alias for threading and echo dedup. Email events only.
      ...(!isContact && data.message_id ? { message_id: String(data.message_id).slice(0, 998) } : {}),
      bounce: data.bounce ? { type: String(data.bounce.type || "").slice(0, 64), message: String(data.bounce.message || "").slice(0, 300) } : undefined,
      // contact.updated: only the identifiers and the subscription flag.
      ...(isContact ? { contact_id: String(data.id || "").slice(0, 128), email: data.email ? String(data.email).slice(0, 320) : null, unsubscribed: data.unsubscribed === true } : {}),
    },
  };
}

function createResendWebhookHandler({ client, config, jobs, audit, logger, clock = () => Date.now(), env = process.env, brandMode = false, schemaReady = null }) {
  // Each target carries its current secret and, during a rotation grace
  // period, the previous one (spec §19.3).
  async function resolveTarget(req) {
    if (!brandMode) return { secret: [config.resend.webhookSecret, config.resend.previousWebhookSecret].filter(Boolean), organizationId: null };
    const slug = String(req.params?.slug || "").toLowerCase();
    if (!SLUG.test(slug)) return null;
    const organization = await client.mailOrganization.findUnique({ where: { slug } }).catch(() => null);
    if (!organization || organization.status !== "ACTIVE") return null;
    const name = brandSecretName(slug);
    return { secret: [env[name], env[`${name}_PREVIOUS`]].filter(Boolean).map(String), organizationId: organization.id };
  }

  return async function handleResendWebhook(req, res) {
    if (!config.enabled || (!config.receivingEnabled && !config.sendingEnabled && !config.marketingEnabled)) {
      return res.status(503).json({ success: false, code: "MAIL_DISABLED", message: "Mail webhooks are not enabled" });
    }
    if (brandMode && !config.marketingEnabled) return res.status(503).json({ success: false, code: "MAIL_MARKETING_DISABLED", message: "Marketing webhooks are not enabled" });
    // Not acknowledged until the schema exists: the provider retries later.
    if (schemaReady && !(await schemaReady())) return res.status(503).json({ success: false, code: "MAIL_SCHEMA_NOT_READY", message: "Mail is not ready" });
    const target = await resolveTarget(req);
    // Unknown brand looks exactly like a bad signature (no enumeration).
    if (!target) return res.status(401).json({ success: false, code: "MAIL_WEBHOOK_SIGNATURE_INVALID", message: "Webhook rejected" });
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
    const verification = verifyResendWebhook({
      rawBody,
      headers: req.headers,
      secret: target.secret,
      toleranceSeconds: config.webhook.toleranceSeconds,
      maxBodyBytes: config.webhook.maxBodyBytes,
      now: clock(),
    });
    if (!verification.ok) {
      logger?.warn?.(`[MailWebhook] rejected${brandMode ? " (brand)" : ""}: ${verification.reason}`);
      const status = verification.reason === "SECRET_NOT_CONFIGURED" ? 503 : verification.reason === "BODY_TOO_LARGE" ? 413 : 401;
      return res.status(status).json({ success: false, code: "MAIL_WEBHOOK_SIGNATURE_INVALID", message: "Webhook rejected" });
    }
    const { eventId, payload } = verification;
    if (!verification.accepted) return res.status(200).json({ success: true, ignored: true });

    const isInbound = payload.type === "email.received";
    if (isInbound && brandMode) return res.status(200).json({ success: true, ignored: true });
    if (isInbound && !config.receivingEnabled) return res.status(503).json({ success: false, code: "MAIL_RECEIVING_DISABLED", message: "Receiving is not enabled" });
    const providerEmailId = String(payload.data.email_id || payload.data.id || "").slice(0, 255);
    if (!providerEmailId) return res.status(400).json({ success: false, code: "MAIL_VALIDATION_FAILED", message: "Event has no email id" });

    const payloadSha256 = crypto.createHash("sha256").update(rawBody).digest("hex");
    // Store only routing metadata from the event; content is fetched later.
    const stored = storedPayload(payload, providerEmailId, target.organizationId);
    // Brand events are namespaced so two provider accounts can never collide.
    const providerKey = brandMode ? `resend:${req.params.slug}` : "resend";
    try {
      const result = await client.$transaction(async (tx) => {
        const existing = await tx.mailWebhookEvent.findUnique({ where: { provider_providerEventId: { provider: providerKey, providerEventId: eventId } } });
        if (existing) return { duplicate: true, id: existing.id };
        const event = await tx.mailWebhookEvent.create({ data: { provider: providerKey, providerEventId: eventId, eventType: payload.type, payloadSha256, payload: stored, signatureVerified: true } });
        await jobs.enqueue(tx, isInbound
          ? { queue: "INBOUND", kind: "PROCESS_INBOUND", idempotencyKey: `inbound:resend:${eventId}`, webhookEventId: event.id, payload: { providerEmailId, to: stored.data.to }, maxAttempts: config.worker.maxAttempts }
          : { queue: "EVENTS", kind: "PROCESS_DELIVERY_EVENT", idempotencyKey: `event:${providerKey}:${eventId}`, webhookEventId: event.id, payload: null, maxAttempts: config.worker.maxAttempts });
        return { duplicate: false, id: event.id };
      });
      return res.status(200).json({ success: true, received: true, duplicate: result.duplicate });
    } catch (error) {
      if (error?.code === "P2002") return res.status(200).json({ success: true, received: true, duplicate: true });
      logger?.error?.(`[MailWebhook] durable acceptance failed: ${error?.code || error?.message}`);
      // Not acknowledged: the provider will retry delivery.
      return res.status(503).json({ success: false, code: "MAIL_STORAGE_UNAVAILABLE", message: "Event not accepted" });
    }
  };
}

module.exports = { createResendWebhookHandler, brandSecretName };
