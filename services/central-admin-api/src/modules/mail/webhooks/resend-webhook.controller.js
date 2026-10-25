"use strict";

// POST /api/mail/v1/webhooks/resend
// Raw-body route (mounted before JSON parsing / XSS mutation in app.js).
// Acknowledges only after the event and its processing job are committed in
// one transaction. No fire-and-forget work happens after the response.

const crypto = require("crypto");
const { verifyResendWebhook } = require("./resend-webhook.verifier");

function createResendWebhookHandler({ client, config, jobs, audit, logger, clock = () => Date.now(), schemaReady = null }) {
  return async function handleResendWebhook(req, res) {
    if (!config.enabled || (!config.receivingEnabled && !config.sendingEnabled)) {
      return res.status(503).json({ success: false, code: "MAIL_DISABLED", message: "Mail webhooks are not enabled" });
    }
    // Not acknowledged until the schema exists: the provider retries later.
    if (schemaReady && !(await schemaReady())) return res.status(503).json({ success: false, code: "MAIL_SCHEMA_NOT_READY", message: "Mail is not ready" });
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
    const verification = verifyResendWebhook({
      rawBody,
      headers: req.headers,
      secret: [config.resend.webhookSecret, config.resend.previousWebhookSecret].filter(Boolean),
      toleranceSeconds: config.webhook.toleranceSeconds,
      maxBodyBytes: config.webhook.maxBodyBytes,
      now: clock(),
    });
    if (!verification.ok) {
      logger?.warn?.(`[MailWebhook] rejected: ${verification.reason}`);
      const status = verification.reason === "SECRET_NOT_CONFIGURED" ? 503 : verification.reason === "BODY_TOO_LARGE" ? 413 : 401;
      return res.status(status).json({ success: false, code: "MAIL_WEBHOOK_SIGNATURE_INVALID", message: "Webhook rejected" });
    }
    const { eventId, payload } = verification;
    if (!verification.accepted) return res.status(200).json({ success: true, ignored: true });

    const isInbound = payload.type === "email.received";
    if (isInbound && !config.receivingEnabled) return res.status(503).json({ success: false, code: "MAIL_RECEIVING_DISABLED", message: "Receiving is not enabled" });
    const providerEmailId = String(payload.data.email_id || payload.data.id || "").slice(0, 255);
    if (!providerEmailId) return res.status(400).json({ success: false, code: "MAIL_VALIDATION_FAILED", message: "Event has no email id" });

    const payloadSha256 = crypto.createHash("sha256").update(rawBody).digest("hex");
    // Store only routing metadata from the event; content is fetched later.
    const stored = {
      type: payload.type,
      created_at: payload.created_at || null,
      data: {
        email_id: providerEmailId,
        to: Array.isArray(payload.data.to) ? payload.data.to.slice(0, 100).map((value) => String(value).slice(0, 320)) : payload.data.to ? [String(payload.data.to).slice(0, 320)] : [],
        from: payload.data.from ? String(payload.data.from).slice(0, 320) : null,
        created_at: payload.data.created_at || null,
        bounce: payload.data.bounce ? { type: String(payload.data.bounce.type || "").slice(0, 64), message: String(payload.data.bounce.message || "").slice(0, 300) } : undefined,
      },
    };
    try {
      const result = await client.$transaction(async (tx) => {
        const existing = await tx.mailWebhookEvent.findUnique({ where: { provider_providerEventId: { provider: "resend", providerEventId: eventId } } });
        if (existing) return { duplicate: true, id: existing.id };
        const event = await tx.mailWebhookEvent.create({ data: { provider: "resend", providerEventId: eventId, eventType: payload.type, payloadSha256, payload: stored, signatureVerified: true } });
        await jobs.enqueue(tx, isInbound
          ? { queue: "INBOUND", kind: "PROCESS_INBOUND", idempotencyKey: `inbound:resend:${eventId}`, webhookEventId: event.id, payload: { providerEmailId, to: stored.data.to }, maxAttempts: config.worker.maxAttempts }
          : { queue: "EVENTS", kind: "PROCESS_DELIVERY_EVENT", idempotencyKey: `event:resend:${eventId}`, webhookEventId: event.id, payload: null, maxAttempts: config.worker.maxAttempts });
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

module.exports = { createResendWebhookHandler };
