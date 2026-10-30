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
// - the sender's organization is not a restricted-health brand (HealthNet):
//   Resend is not a HIPAA/BAA provider, so clinical-domain organizations
//   cannot send through it at all until an approved alternative exists
//   (spec §19.7, §15). Callers must load domain.organization; an unknown
//   organization fails closed.
// Internal (local mailbox) delivery never reaches the provider and is not
// governed by this gate. Legacy SMTP/nodemailer senders are unaffected.

const REASONS = Object.freeze({
  SENDING_DISABLED: "MAIL_SENDING_DISABLED",
  PROVIDER_NOT_CONFIGURED: "MAIL_PROVIDER_NOT_CONFIGURED",
  ALLOWLIST_EMPTY: "SENDER_DOMAIN_ALLOWLIST_EMPTY",
  NOT_ALLOWLISTED: "SENDER_DOMAIN_NOT_ALLOWLISTED",
  NOT_VERIFIED: "SENDER_DOMAIN_NOT_VERIFIED",
  SENDING_SUSPENDED: "SENDER_DOMAIN_SENDING_DISABLED",
  RESTRICTED_HEALTH: "SENDER_ORGANIZATION_RESTRICTED_HEALTH",
  ORGANIZATION_UNKNOWN: "SENDER_ORGANIZATION_UNKNOWN",
});

function isRestrictedHealthOrganization(config, organization) {
  const slug = String(organization?.slug || "").toLowerCase();
  return Boolean(slug) && (config.restrictedHealth?.organizations || []).some((prefix) => slug === prefix || slug.startsWith(prefix));
}

function externalSendBlockReason({ config, providerReady, domain }) {
  if (!config.enabled || !config.sendingEnabled) return REASONS.SENDING_DISABLED;
  if (!providerReady()) return REASONS.PROVIDER_NOT_CONFIGURED;
  if (!config.domainAllowlist.length) return REASONS.ALLOWLIST_EMPTY;
  if (!domain || !config.domainAllowlist.includes(domain.domain)) return REASONS.NOT_ALLOWLISTED;
  if (domain.organization === undefined || domain.organization === null) return REASONS.ORGANIZATION_UNKNOWN;
  if (isRestrictedHealthOrganization(config, domain.organization) && !config.restrictedHealth?.providerApproved) return REASONS.RESTRICTED_HEALTH;
  if (domain.status === "SUSPENDED" || ["DISABLED", "FAILED"].includes(domain.sendingStatus)) return REASONS.SENDING_SUSPENDED;
  if (domain.status !== "VERIFIED" || domain.sendingStatus !== "VERIFIED") return REASONS.NOT_VERIFIED;
  return null;
}

module.exports = { externalSendBlockReason, isRestrictedHealthOrganization, SEND_BLOCK_REASONS: REASONS };
