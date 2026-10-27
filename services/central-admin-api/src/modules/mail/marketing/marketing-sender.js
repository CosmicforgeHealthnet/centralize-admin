"use strict";

// Single marketing email send (automation steps, double opt-in confirmations)
// through the brand's marketing provider account, with the same outcome
// rules as transactional mail:
// - one stable Idempotency-Key per logical send;
// - ambiguous outcomes are retried with the same key only inside the
//   provider's idempotency window (config.reconciliation.idempotencyWindowHours,
//   max 23 h of Resend's 24 h); after that, or on an idempotency conflict, the
//   outcome is UNKNOWN and is never retried automatically;
// - provider acceptance is recorded as PROVIDER_ACCEPTED, never as delivered.

const { isReservedSender } = require("../security/reserved-senders");

function classifySendError(error, { firstAttemptAt, now, windowHours }) {
  const outsideWindow = firstAttemptAt && now.getTime() - new Date(firstAttemptAt).getTime() > windowHours * 3600000;
  switch (error?.kind) {
    case "IDEMPOTENCY_CONFLICT":
      return { outcome: "UNKNOWN", code: "PROVIDER_IDEMPOTENCY_CONFLICT" };
    case "AMBIGUOUS":
      return outsideWindow ? { outcome: "UNKNOWN", code: "AMBIGUOUS_OUTSIDE_IDEMPOTENCY_WINDOW" } : { outcome: "RETRY", code: error.code || "PROVIDER_AMBIGUOUS" };
    case "RETRYABLE":
      return outsideWindow ? { outcome: "UNKNOWN", code: "RETRY_OUTSIDE_IDEMPOTENCY_WINDOW" } : { outcome: "RETRY", code: error.code || "PROVIDER_RETRYABLE", retryAfterSeconds: error.retryAfterSeconds ?? null };
    case "NOT_CONFIGURED":
      return { outcome: "DEFER", code: error.code || "PROVIDER_NOT_CONFIGURED" };
    default:
      return { outcome: "FAILED", code: error?.code || "PROVIDER_REJECTED" };
  }
}

// Re-audit fix: error codes that prove the provider definitively rejected a
// send (nothing was accepted). Only these make a FAILED step run safe to
// retry with a fresh idempotency key; any other code on a run that was
// attempted (a database error after acceptance, an unclassified exception,
// "PROVIDER_REJECTED" as the generic fallback) may hide an accepted email.
// Resend: 4xx other than 408 (timeout), 409 (idempotency) and 429 (rate/quota).
function isDefinitiveProviderRejection(code) {
  const match = /^RESEND_HTTP_(4\d\d)$/.exec(String(code || ""));
  return Boolean(match) && !["408", "409", "429"].includes(match[1]);
}

function unsubscribeHeaders(url) {
  if (!url) return {};
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}


// Brand sender identities for marketing mail (campaigns, automations, test
// sends, confirmations). SHARED/SYSTEM/ALIAS addresses only, and never one
// that lives on a PERSONAL mailbox: an ALIAS can be a person's alias.
// Callers must load the address with `include: SENDER_INCLUDE` (mailbox
// type); an address with a mailbox that was not loaded fails closed.
const BRAND_SENDER_KINDS = ["SHARED", "SYSTEM", "ALIAS"];
const SENDER_MAILBOX_SELECT = { select: { type: true, purpose: true, status: true } };

function brandSenderProblem(address, organizationId) {
  if (!address || address.organizationId !== organizationId) return "SENDER_NOT_FOUND";
  if (address.status !== "ACTIVE") return "SENDER_INACTIVE";
  // Owned by another system (e.g. KarryGo's no-reply@): never a CA sender.
  if (isReservedSender(address.address)) return "RESERVED_SENDER";
  if (!BRAND_SENDER_KINDS.includes(address.kind)) return "PERSONAL_SENDER";
  if (address.mailboxId && address.mailbox?.type !== "SHARED") return "PERSONAL_MAILBOX_SENDER";
  return null;
}

function isBrandSender(address, organizationId) {
  return brandSenderProblem(address, organizationId) === null;
}

// Reply-To for marketing mail must route to an active SHARED mailbox of the
// same brand (any purpose: marketing, support, general), so replies reach a
// team inbox and can be attributed (campaign-replies.js).
async function replyToProblem(client, organizationId, replyTo) {
  const address = replyTo ? await client.mailAddress.findUnique({ where: { address: String(replyTo).toLowerCase() }, include: { mailbox: SENDER_MAILBOX_SELECT } }) : null;
  if (!address || address.organizationId !== organizationId) return "REPLY_TO_NOT_BRAND_ADDRESS";
  if (address.status !== "ACTIVE") return "REPLY_TO_INACTIVE";
  if (isReservedSender(address.address)) return "REPLY_TO_RESERVED";
  if (!address.mailboxId || address.mailbox?.type !== "SHARED" || address.mailbox?.status !== "ACTIVE") return "REPLY_TO_NOT_SHARED_MAILBOX";
  return null;
}

// Reply-To for an automation send step: the step's replyTo, or else the
// sender itself when it is a shared-mailbox address. Returns the address to
// use, or the reason none is acceptable.
async function automationReplyTo(client, organizationId, step, sender) {
  const candidate = step.replyTo || (sender?.mailboxId && sender?.mailbox?.type === "SHARED" ? sender.address : null);
  if (!candidate) return { address: null, problem: "REPLY_TO_REQUIRED" };
  const problem = await replyToProblem(client, organizationId, candidate);
  return problem ? { address: null, problem } : { address: String(candidate).toLowerCase(), problem: null };
}

module.exports = { classifySendError, isDefinitiveProviderRejection, unsubscribeHeaders, brandSenderProblem, isBrandSender, replyToProblem, automationReplyTo, BRAND_SENDER_KINDS, SENDER_MAILBOX_SELECT };
