"use strict";

// Provider-neutral contract (§18). Every provider call made by Mail goes
// through these wrappers, whatever adapter sits underneath (Resend, the
// offline fake, a future provider):
//
//   sendMessage, fetchInboundMessage, fetchInboundAttachments, validateDomain,
//   queueBroadcast, cancelBroadcast, syncAudience, retrieveDeliveryEvents,
//   healthProbe
//
// The wrappers
//   - validate inputs before any network call (VALIDATION_FAILED, PERMANENT:
//     nothing was submitted, so a retry cannot help and nothing is ambiguous);
//   - normalize outputs (stable shapes, known status values);
//   - normalize errors: anything that is not a MailProviderError becomes one
//     (a failed write is OUTCOME_UNKNOWN, a failed read is retryable), and
//     every error carries the operation name and a normalized category;
//   - keep every other adapter property (quota hooks, list helpers) as is.
// Business services never see provider error bodies or SDK types, and Mail
// business state stays in the Admin database (providers only get the exact
// recipients computed by CosmicForge).

const { MailProviderError } = require("./mail-provider.contract");
const { unapprovedRecipients, withProviderTags } = require("../security/shared-account");

const PROVIDER_ID = /^[A-Za-z0-9_.:@-]{1,255}$/;
const DOMAIN_STATES = new Set(["VERIFIED", "PENDING", "FAILED", "NOT_STARTED", "PARTIAL", "NOT_CONFIGURED", "DISABLED"]);
const EVENT_TYPES = new Set(["SENT", "DELIVERED", "DELIVERY_DELAYED", "BOUNCED", "COMPLAINED", "FAILED", "OPENED", "CLICKED", "SUPPRESSED"]);
const WRITE_OPERATIONS = new Set(["sendMessage", "sendEmail", "createBroadcast", "sendBroadcast", "cancelBroadcast", "deleteBroadcast", "createContact", "addContactToSegment", "removeContactFromSegment", "createSegment", "deleteSegment", "resubscribeContact", "createDomain", "verifyDomain", "queueBroadcast", "syncAudience"]);

function invalid(operation, code, message) {
  return new MailProviderError("PERMANENT", code, message, { category: "VALIDATION_FAILED", operation });
}

function normalizeError(error, operation) {
  if (error instanceof MailProviderError || error?.name === "MailProviderError") {
    if (!error.operation) error.operation = operation;
    return error;
  }
  // An unexpected exception inside an adapter (bug, TypeError, socket
  // error): a write may have reached the provider, so it is never retried
  // blindly; a read is safe to retry.
  const write = WRITE_OPERATIONS.has(operation);
  const wrapped = new MailProviderError(write ? "AMBIGUOUS" : "RETRYABLE", write ? "PROVIDER_OUTCOME_UNKNOWN" : "PROVIDER_ERROR", "Provider call failed unexpectedly", { category: write ? "OUTCOME_UNKNOWN" : "PROVIDER_UNAVAILABLE", operation });
  wrapped.cause = error;
  return wrapped;
}

function requireId(operation, value, field) {
  const id = String(value ?? "");
  if (!PROVIDER_ID.test(id)) throw invalid(operation, "PROVIDER_ID_INVALID", `${field} is not a valid provider id`);
  return id;
}

function partyOk(party) {
  return party && typeof party.address === "string" && /^[^\s@<>]+@[^\s@<>]+$/.test(party.address) && party.address.length <= 320;
}

function validateSendRequest(operation, request) {
  if (!request || typeof request !== "object") throw invalid(operation, "SEND_REQUEST_INVALID", "Send request is missing");
  const key = String(request.idempotencyKey || "");
  if (!key || key.length > 256) throw invalid(operation, "IDEMPOTENCY_KEY_INVALID", "A stable idempotency key (1-256 characters) is required");
  if (!partyOk(request.from)) throw invalid(operation, "FROM_INVALID", "From address is invalid");
  for (const field of ["to", "cc", "bcc"]) {
    const list = request[field] ?? [];
    if (!Array.isArray(list) || !list.every(partyOk)) throw invalid(operation, "RECIPIENT_INVALID", `${field} contains an invalid address`);
  }
  if (!request.to?.length) throw invalid(operation, "TO_REQUIRED", "At least one To recipient is required");
  if (typeof request.subject !== "string") throw invalid(operation, "SUBJECT_REQUIRED", "Subject is required");
  if (request.html == null && request.text == null) throw invalid(operation, "BODY_REQUIRED", "An HTML or text body is required");
  for (const attachment of request.attachments || []) {
    if (!attachment || !attachment.filename || attachment.content == null) throw invalid(operation, "ATTACHMENT_INVALID", "Attachment is missing a filename or content");
  }
}

function normalizeSendResult(operation, result) {
  const id = result?.providerMessageId != null ? String(result.providerMessageId) : "";
  // Accepted without an id cannot be reconciled by id: treat as unknown.
  if (!id) throw new MailProviderError("AMBIGUOUS", "PROVIDER_NO_ID", "Provider accepted the request without an id", { category: "OUTCOME_UNKNOWN", operation });
  return { ...result, providerMessageId: id };
}

function normalizeHealth(result, started, clock) {
  if (!result || typeof result !== "object") return { ok: false, status: "UNAVAILABLE", latencyMs: clock() - started, detail: "invalid health response" };
  const status = result.status || (result.ok ? "OK" : /not.?configured|credentials/i.test(String(result.detail || "")) ? "NOT_CONFIGURED" : "UNAVAILABLE");
  return { ...result, ok: Boolean(result.ok), status, latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : clock() - started, detail: String(result.detail || "").slice(0, 120) };
}

function normalizeDomain(result) {
  const pick = (value) => (DOMAIN_STATES.has(value) ? value : value ? "PENDING" : "NOT_CONFIGURED");
  return {
    ...result,
    status: pick(result?.status),
    sendingStatus: pick(result?.sendingStatus),
    receivingStatus: pick(result?.receivingStatus),
    spfStatus: result?.spfStatus ? pick(result.spfStatus) : "NOT_REPORTED",
    dkimStatus: result?.dkimStatus ? pick(result.dkimStatus) : "NOT_REPORTED",
    dmarcStatus: result?.dmarcStatus || "NOT_REPORTED",
    records: Array.isArray(result?.records) ? result.records : [],
  };
}

function normalizeEvents(result) {
  return (Array.isArray(result) ? result : []).filter((event) => EVENT_TYPES.has(event?.type)).map((event) => ({ type: event.type, occurredAt: event.occurredAt instanceof Date ? event.occurredAt : new Date(event.occurredAt || Date.now()), recipient: event.recipient || null }));
}

// Per-operation guards: [validate(args), normalize(result, args)].
const TRANSPORT_RULES = {
  sendMessage: [(args) => validateSendRequest("sendMessage", args[0]), (result) => normalizeSendResult("sendMessage", result)],
  fetchInboundMessage: [(args) => requireId("fetchInboundMessage", args[0], "providerEmailId"), (result, args) => ({ ...result, providerEmailId: String(result?.providerEmailId || args[0]) })],
  fetchInboundAttachments: [(args) => requireId("fetchInboundAttachments", args[0], "providerEmailId"), (result) => (Array.isArray(result) ? result : [])],
  validateDomain: [(args) => requireId("validateDomain", args[0], "providerDomainId"), (result) => normalizeDomain(result)],
  retrieveDeliveryEvents: [(args) => requireId("retrieveDeliveryEvents", args[0], "providerMessageId"), (result) => normalizeEvents(result)],
  verifyDomain: [(args) => requireId("verifyDomain", args[0], "providerDomainId"), (result) => result],
  createDomain: [(args) => {
    if (!args[0]?.name) throw invalid("createDomain", "DOMAIN_NAME_REQUIRED", "Domain name is required");
  }, (result) => normalizeDomain(result)],
  findDomainByName: [(args) => {
    if (!args[0]) throw invalid("findDomainByName", "DOMAIN_NAME_REQUIRED", "Domain name is required");
  }, (result) => (result ? normalizeDomain(result) : null)],
};

const MARKETING_RULES = {
  sendEmail: [(args) => validateSendRequest("sendEmail", args[0]), (result) => normalizeSendResult("sendEmail", result)],
  getBroadcast: [(args) => requireId("getBroadcast", args[0], "providerBroadcastId"), (result) => result],
  cancelBroadcast: [(args) => requireId("cancelBroadcast", args[0], "providerBroadcastId"), (result) => result],
  sendBroadcast: [(args) => requireId("sendBroadcast", args[0], "providerBroadcastId"), (result) => result],
  deleteBroadcast: [(args) => requireId("deleteBroadcast", args[0], "providerBroadcastId"), (result) => result],
  addContactToSegment: [(args) => {
    requireId("addContactToSegment", args[0], "contactId");
    requireId("addContactToSegment", args[1], "segmentId");
  }, (result) => result],
  removeContactFromSegment: [(args) => {
    requireId("removeContactFromSegment", args[0], "contactId");
    requireId("removeContactFromSegment", args[1], "segmentId");
  }, (result) => result],
};

// Shared-account guards (security/shared-account.js), applied to every send
// before the adapter is called: a recipient outside an active test allowlist
// is refused (PERMANENT, nothing submitted) and CA's cf_app / cf_env tags are
// added so delivery events can be attributed to the right deployment.
const SEND_OPERATIONS = new Set(["sendMessage", "sendEmail"]);

function applySendGuards(prop, args, { recipientPolicy, providerTags }) {
  if (!SEND_OPERATIONS.has(prop)) return args;
  const refused = unapprovedRecipients(recipientPolicy, args[0]);
  if (refused.length) throw invalid(prop, "RECIPIENT_NOT_APPROVED", `${refused.length} recipient(s) are not on MAIL_TEST_RECIPIENT_ALLOWLIST`);
  return [withProviderTags(args[0], providerTags), ...args.slice(1)];
}

function wrapAdapter(adapter, rules, { clock = () => Date.now(), recipientPolicy = null, providerTags = null } = {}) {
  if (!adapter || typeof adapter !== "object" || adapter.__providerContract) return adapter;
  const cache = new Map();
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === "__providerContract") return true;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string" || prop === "setQuotaObserver" || prop === "rateLimitState") return value;
      if (cache.has(prop)) return cache.get(prop);
      const [validate, normalize] = rules[prop] || [null, (result) => result];
      // The method is resolved at call time: callers (and tests) may replace
      // an adapter method after the wrapper was created.
      const wrapped = async (...args) => {
        const current = Reflect.get(target, prop);
        if (typeof current !== "function") throw normalizeError(new TypeError(`${String(prop)} is not available`), prop);
        if (prop === "healthProbe") {
          const started = clock();
          try {
            return normalizeHealth(await current.apply(target, args), started, clock);
          } catch (error) {
            return { ok: false, status: error?.kind === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "UNAVAILABLE", latencyMs: clock() - started, detail: String(error?.code || "unreachable").slice(0, 120) };
          }
        }
        if (validate) validate(args);
        if (prop === "sendBroadcast" && recipientPolicy?.active) throw invalid(prop, "BROADCAST_BLOCKED_BY_TEST_ALLOWLIST", "Broadcasts cannot be sent while MAIL_TEST_RECIPIENT_ALLOWLIST is active");
        args = applySendGuards(prop, args, { recipientPolicy, providerTags });
        let result;
        try {
          result = await current.apply(target, args);
        } catch (error) {
          throw normalizeError(error, prop);
        }
        return normalize(result, args);
      };
      cache.set(prop, wrapped);
      return wrapped;
    },
  });
}

function withTransportContract(adapter, options) {
  return wrapAdapter(adapter, TRANSPORT_RULES, options);
}

// Composite marketing operations of the contract, built only from documented
// adapter calls. CosmicForge stays the record of consent: syncAudience only
// accepts contacts the caller has already proven eligible, and never lifts a
// provider-side unsubscribe.
function marketingOperations(provider, { recipientPolicy = null } = {}) {
  // queueBroadcast: send (or schedule) a provider broadcast that was created
  // as a draft. Broadcast calls are not idempotent at the provider, so the
  // status is read first and a broadcast that already left draft is never
  // sent twice.
  async function queueBroadcast(input) {
    const providerBroadcastId = typeof input === "string" ? input : input?.providerBroadcastId;
    const scheduledAt = typeof input === "string" ? null : input?.scheduledAt ?? null;
    const id = requireId("queueBroadcast", providerBroadcastId, "providerBroadcastId");
    const before = await provider.getBroadcast(id);
    if (!before) throw new MailProviderError("PERMANENT", "BROADCAST_NOT_FOUND", "Provider broadcast not found", { category: "NOT_FOUND", operation: "queueBroadcast" });
    if (before.status !== "DRAFT") return { providerBroadcastId: id, status: before.status, alreadyQueued: true };
    try {
      await provider.sendBroadcast(id, { scheduledAt });
    } catch (error) {
      throw normalizeError(error, "queueBroadcast");
    }
    const after = await provider.getBroadcast(id).catch(() => null);
    return { providerBroadcastId: id, status: after?.status || (scheduledAt ? "SCHEDULED" : "QUEUED"), alreadyQueued: false };
  }

  // cancelBroadcast (Resend: POST /broadcasts/{id}/cancel): only queued or
  // scheduled broadcasts can be cancelled; a scheduled one returns to draft
  // (nothing sent); a queued one stops the emails still queued, and emails
  // already sent are NOT recalled. `sentBeforeCancel` is "NONE" only when the
  // provider proves nothing went out.
  async function cancelBroadcast(input) {
    // Accepts { providerBroadcastId } or, for older callers, the bare id.
    const providerBroadcastId = typeof input === "string" ? input : input?.providerBroadcastId;
    const id = requireId("cancelBroadcast", providerBroadcastId, "providerBroadcastId");
    const before = await provider.getBroadcast(id);
    if (!before) return { outcome: "NOT_FOUND", providerStatus: null, sentBeforeCancel: "UNKNOWN" };
    if (before.status === "SENT") return { outcome: "NOT_CANCELLABLE_ALREADY_SENT", providerStatus: "SENT", sentBeforeCancel: "ALL" };
    if (before.status === "CANCELED") return { outcome: "ALREADY_CANCELED", providerStatus: "CANCELED", sentBeforeCancel: "UNKNOWN" };
    if (before.status === "DRAFT") return { outcome: "NOTHING_TO_CANCEL", providerStatus: "DRAFT", sentBeforeCancel: "NONE" };
    try {
      await provider.cancelBroadcast(id);
    } catch (error) {
      throw normalizeError(error, "cancelBroadcast");
    }
    const after = await provider.getBroadcast(id).catch(() => null);
    if (before.status === "SCHEDULED") return { outcome: "RETURNED_TO_DRAFT", providerStatus: after?.status || "DRAFT", sentBeforeCancel: "NONE" };
    return { outcome: "CANCELED", providerStatus: after?.status || "CANCELED", sentBeforeCancel: "UNKNOWN" };
  }

  // syncAudience: make the provider segment contain exactly the eligible
  // contacts given (adds) and drop the given provider contacts (removes).
  // Contacts unsubscribed at the provider are reported, never re-subscribed.
  async function syncAudience({ segmentId, add = [], remove = [] }) {
    const segment = requireId("syncAudience", segmentId, "segmentId");
    for (const contact of add) {
      if (!contact?.email || contact.consentVerified !== true) throw invalid("syncAudience", "CONTACT_NOT_ELIGIBLE", "Only consent-verified contacts can be synchronised");
      if (unapprovedRecipients(recipientPolicy, { to: [{ address: contact.email }] }).length) throw invalid("syncAudience", "RECIPIENT_NOT_APPROVED", "A contact is not on MAIL_TEST_RECIPIENT_ALLOWLIST");
    }
    const result = { added: 0, created: 0, removed: 0, providerUnsubscribed: [] };
    for (const contact of add) {
      const existing = await provider.getContact(contact.email);
      if (existing?.unsubscribed) {
        result.providerUnsubscribed.push(contact.email);
        continue;
      }
      if (existing?.id) {
        await provider.addContactToSegment(existing.id, segment);
        result.added += 1;
      } else {
        await provider.createContact({ email: contact.email, firstName: contact.firstName || null, lastName: contact.lastName || null, segmentIds: [segment] });
        result.created += 1;
      }
    }
    for (const contactId of remove) {
      await provider.removeContactFromSegment(requireId("syncAudience", contactId, "contactId"), segment);
      result.removed += 1;
    }
    return result;
  }

  return { queueBroadcast, cancelBroadcast, syncAudience };
}

function withMarketingContract(adapter, options) {
  if (!adapter || typeof adapter !== "object" || adapter.__providerContract) return adapter;
  const wrapped = wrapAdapter(adapter, MARKETING_RULES, options);
  const composite = marketingOperations(wrapped, options);
  return new Proxy(wrapped, {
    get(target, prop, receiver) {
      if (Object.prototype.hasOwnProperty.call(composite, prop)) return composite[prop];
      return Reflect.get(target, prop, receiver);
    },
  });
}

// The nine-operation contract as one object, for components that need the
// whole surface (readiness, ops tooling, contract tests). Marketing
// operations take the brand organization because each brand may use its own
// provider account.
function createMailProviderContract({ transport, marketingFor, clock = () => Date.now(), guards = {} }) {
  const mail = withTransportContract(transport, { clock, ...guards });
  const marketing = (organization) => withMarketingContract(marketingFor(organization), { clock, ...guards });
  return {
    sendMessage: (request) => mail.sendMessage(request),
    fetchInboundMessage: (providerEmailId) => mail.fetchInboundMessage(providerEmailId),
    fetchInboundAttachments: (providerEmailId) => mail.fetchInboundAttachments(providerEmailId),
    validateDomain: (providerDomainId) => mail.validateDomain(providerDomainId),
    retrieveDeliveryEvents: (providerMessageId) => mail.retrieveDeliveryEvents(providerMessageId),
    queueBroadcast: ({ organization, ...input }) => marketing(organization).queueBroadcast(input),
    cancelBroadcast: ({ organization, ...input }) => marketing(organization).cancelBroadcast(input),
    syncAudience: ({ organization, ...input }) => marketing(organization).syncAudience(input),
    async healthProbe({ organization = null } = {}) {
      const transportHealth = await mail.healthProbe();
      const marketingHealth = organization ? await marketing(organization).healthProbe() : null;
      return { ok: transportHealth.ok && (marketingHealth ? marketingHealth.ok : true), transport: transportHealth, marketing: marketingHealth };
    },
  };
}

const CONTRACT_OPERATIONS = Object.freeze(["sendMessage", "fetchInboundMessage", "fetchInboundAttachments", "validateDomain", "queueBroadcast", "cancelBroadcast", "syncAudience", "retrieveDeliveryEvents", "healthProbe"]);

module.exports = { withTransportContract, withMarketingContract, createMailProviderContract, normalizeProviderError: normalizeError, validateSendRequest, CONTRACT_OPERATIONS };
