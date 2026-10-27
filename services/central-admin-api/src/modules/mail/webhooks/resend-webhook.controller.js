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
//
// One provider account, several senders (Resend Free allows one webhook
// endpoint): the KarryGo Notification Service sends OTPs and other automated
// mail as no-reply@karryam.com through the same account, so its email.*
// events reach this endpoint too. An outbound email event whose `from` is a
// reserved sender (MAIL_RESERVED_SENDER_ADDRESSES), or is not an address CA
// has ever provisioned, is not CA's: it is acknowledged (200, ignored) and
// nothing about it (recipient addresses included) is stored or queued.
//
// Ownership rules on the company endpoint (brand endpoints are per-account and
// keep the reserved/provisioned check only):
//   - outbound email.*: the sender's domain must be on MAIL_DOMAIN_ALLOWLIST
//     (broadcasts included: other brands' and HealthNet's senders never are);
//     a reserved or never-provisioned sender is foreign; an event without a
//     usable `from` is CA's only if its email id is one CA sent.
//   - email.received: only the event's allowlisted recipients (to/cc/bcc) are
//     stored for routing; other parties' addresses never are. The event is
//     not refused on its listed recipients (a Bcc'd delivery may list only the
//     header To); the inbound processor enforces exact-address ownership
//     before anything is stored.
//   - an ownership lookup that fails is not acknowledged (503, the provider
//     retries) so a possibly foreign event is never stored by default.
// Contact events are not affected.
//
// The same account and key also serve the other CA deployment (staging vs
// production), so, after signature verification:
//   - an email event tagged cf_app=cosmicforge-mail with another cf_env is
//     acknowledged and not stored (OTHER_DEPLOYMENT);
//   - a broadcast event whose broadcast_id CA never dispatched (e.g. a
//     campaign sent from the provider dashboard) is acknowledged and not
//     stored (FOREIGN_BROADCAST);
//   - email.received is refused with 503 unless this deployment owns inbound
//     mail (MAIL_INBOUND_ACTIVE_ENVIRONMENT), so the provider retries and,
//     after a webhook cutover, delivers to the owner instead.

const crypto = require("crypto");
const { verifyResendWebhook } = require("./resend-webhook.verifier");
const { reservedSenderSet, eventSenderAddress } = require("../security/reserved-senders");
const { parseParty } = require("../security/address.util");
const { taggedForOtherDeployment } = require("../security/shared-account");

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
  const reservedSenders = reservedSenderSet(config);

  const ownedDomains = new Set((config.domainAllowlist || []).map((domain) => String(domain).toLowerCase()));
  const ownedAddress = (address) => Boolean(address) && ownedDomains.has(address.split("@")[1]);

  // Every recipient address an event lists (strings, "Name <a@b>" or objects).
  function eventRecipients(data) {
    const values = [];
    for (const field of ["to", "cc", "bcc"]) {
      const value = data?.[field];
      for (const entry of Array.isArray(value) ? value : value ? [value] : []) {
        const party = parseParty(entry);
        if (party) values.push(party.address);
      }
    }
    return [...new Set(values)];
  }

  // Reason an outbound email event belongs to another system, or null.
  // Throws when ownership cannot be established (the caller answers 503).
  async function foreignSenderReason(payload) {
    const type = String(payload.type || "");
    if (!type.startsWith("email.") || type === "email.received") return null;
    if (taggedForOtherDeployment(payload.data, config.providerTags)) return "OTHER_DEPLOYMENT";
    const isBroadcast = Boolean(payload.data?.broadcast_id);
    const sender = eventSenderAddress(payload.data?.from);
    if (!sender) {
      if (brandMode || isBroadcast) return null;
      const providerId = String(payload.data?.email_id || payload.data?.id || "").slice(0, 255);
      if (!providerId) return null; // rejected as invalid (400) further down
      const matches = await Promise.all([
        client.mailMessage.findFirst({ where: { providerMessageId: providerId }, select: { id: true } }),
        client.mailMessageRecipient.findFirst({ where: { providerMessageId: providerId }, select: { id: true } }),
        client.marketingBroadcastRecipient.findFirst({ where: { providerEmailId: providerId }, select: { id: true } }),
        client.marketingAutomationStepRun.findFirst({ where: { providerMessageId: providerId }, select: { id: true } }),
      ]);
      return matches.some(Boolean) ? null : "SENDER_MISSING_NOT_CA";
    }
    if (reservedSenders.has(sender)) return "RESERVED_SENDER";
    if (!brandMode && !ownedAddress(sender)) return "SENDER_DOMAIN_NOT_OWNED";
    // An owned-domain broadcast is CA's only if CA dispatched it (a campaign
    // sent from the provider dashboard is not).
    if (isBroadcast) {
      const dispatch = await client.marketingBroadcastDispatch.findFirst({ where: { providerBroadcastId: String(payload.data.broadcast_id).slice(0, 128) }, select: { id: true } });
      return dispatch ? null : "FOREIGN_BROADCAST";
    }
    const known = await client.mailAddress.findUnique({ where: { address: sender }, select: { id: true } });
    return known ? null : "SENDER_NOT_PROVISIONED";
  }

  // For email.received: only the allowlisted recipients the event lists.
  // An event is never refused on this list alone: a Bcc'd delivery to one of
  // our addresses may list only the other party's header To. Ownership is
  // enforced by the inbound processor before anything is stored.
  function inboundOwnedRecipients(payload) {
    return eventRecipients(payload.data).filter(ownedAddress);
  }

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
    let foreign = null;
    let inboundRecipients = null;
    if (isInbound) {
      if (!brandMode) inboundRecipients = inboundOwnedRecipients(payload);
    } else {
      try {
        foreign = await foreignSenderReason(payload);
      } catch (error) {
        logger?.error?.(`[MailWebhook] ownership lookup failed: ${error?.code || error?.message}`);
        return res.status(503).json({ success: false, code: "MAIL_STORAGE_UNAVAILABLE", message: "Event not accepted" });
      }
    }
    if (foreign) {
      logger?.info?.(`[MailWebhook] ignored ${String(payload.type).slice(0, 40)} for another system (${foreign})`);
      return res.status(200).json({ success: true, ignored: true, reason: foreign === "OTHER_DEPLOYMENT" || foreign === "FOREIGN_BROADCAST" ? foreign : "FOREIGN_SENDER" });
    }
    if (isInbound && !config.receivingEnabled) return res.status(503).json({ success: false, code: "MAIL_RECEIVING_DISABLED", message: "Receiving is not enabled" });
    if (isInbound && config.inbound && !config.inbound.ownedHere) return res.status(503).json({ success: false, code: "MAIL_INBOUND_NOT_ACTIVE_HERE", message: "Inbound mail is handled by another deployment" });
    const providerEmailId = String(payload.data.email_id || payload.data.id || "").slice(0, 255);
    if (!providerEmailId) return res.status(400).json({ success: false, code: "MAIL_VALIDATION_FAILED", message: "Event has no email id" });

    const payloadSha256 = crypto.createHash("sha256").update(rawBody).digest("hex");
    // Store only routing metadata from the event; content is fetched later.
    const stored = storedPayload(payload, providerEmailId, target.organizationId);
    // Inbound: keep only our own recipients (a Bcc'd department address
    // included); other parties' addresses are never stored.
    if (inboundRecipients) {
      stored.data.to = inboundRecipients.slice(0, 100);
      delete stored.data.cc;
      delete stored.data.bcc;
      // Lists none of our addresses: likely another product's mail. Keep
      // nothing about its parties (the processor reads the sender from the
      // provider, not from here).
      if (!inboundRecipients.length) stored.data.from = null;
    }
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
