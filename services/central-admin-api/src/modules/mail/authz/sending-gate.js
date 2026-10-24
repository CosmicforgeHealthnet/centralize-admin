"use strict";

// Single gate for external (provider) delivery, applied before enqueueing,
// again before every provider call, and in marketing preflight. External
// delivery is denied unless ALL of these hold:
// - MAIL_ENABLED and MAIL_SENDING_ENABLED are true;
// - a provider adapter is actually configured (no credentials -> denied);
// - MAIL_DOMAIN_ALLOWLIST is non-empty (an empty allowlist denies everything);
// - the sender domain is on the allowlist;
// - the sender domain is VERIFIED with sendingStatus VERIFIED (a SUSPENDED
//   domain or a DISABLED sending status acts as a kill-switch).
// Internal (local mailbox) delivery never reaches the provider and is not
// governed by this gate. Legacy SMTP/nodemailer senders are unaffected.

const REASONS = Object.freeze({
  SENDING_DISABLED: "MAIL_SENDING_DISABLED",
  PROVIDER_NOT_CONFIGURED: "MAIL_PROVIDER_NOT_CONFIGURED",
  ALLOWLIST_EMPTY: "SENDER_DOMAIN_ALLOWLIST_EMPTY",
  NOT_ALLOWLISTED: "SENDER_DOMAIN_NOT_ALLOWLISTED",
  NOT_VERIFIED: "SENDER_DOMAIN_NOT_VERIFIED",
  SENDING_SUSPENDED: "SENDER_DOMAIN_SENDING_DISABLED",
});

function externalSendBlockReason({ config, providerReady, domain }) {
  if (!config.enabled || !config.sendingEnabled) return REASONS.SENDING_DISABLED;
  if (!providerReady()) return REASONS.PROVIDER_NOT_CONFIGURED;
  if (!config.domainAllowlist.length) return REASONS.ALLOWLIST_EMPTY;
  if (!domain || !config.domainAllowlist.includes(domain.domain)) return REASONS.NOT_ALLOWLISTED;
  if (domain.status === "SUSPENDED" || ["DISABLED", "FAILED"].includes(domain.sendingStatus)) return REASONS.SENDING_SUSPENDED;
  if (domain.status !== "VERIFIED" || domain.sendingStatus !== "VERIFIED") return REASONS.NOT_VERIFIED;
  return null;
}

module.exports = { externalSendBlockReason, SEND_BLOCK_REASONS: REASONS };
