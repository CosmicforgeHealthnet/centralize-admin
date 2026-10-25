"use strict";

const ApiError = require("../../shared/utils/ApiError");

const DEFAULT_MESSAGES = {
  MAIL_DISABLED: "CosmicForge Mail is not enabled.",
  MAIL_SENDING_DISABLED: "Sending is not enabled.",
  MAIL_RECEIVING_DISABLED: "Receiving is not enabled.",
  MAIL_MARKETING_DISABLED: "Email Marketing is not enabled.",
  MAIL_FORBIDDEN: "You do not have access to this resource.",
  MAIL_NOT_FOUND: "Not found.",
  MAIL_IDENTITY_INACTIVE: "Your account is not active for Mail.",
  MAIL_VALIDATION_FAILED: "Check the request and try again.",
  MAIL_SENDER_NOT_AUTHORIZED: "You are not approved to send as this address.",
  MAIL_STEP_UP_REQUIRED: "Fresh multi-factor verification is required.",
  MAIL_MFA_NOT_ENROLLED: "Two-factor authentication is not enrolled for this account.",
  MAIL_MFA_INVALID: "The verification code is not valid.",
  MAIL_MFA_SESSION_REQUIRED: "Sign in again to confirm with two-factor authentication.",
  MAIL_MFA_LOCKED: "Too many failed codes. Try again later.",
  MAIL_MFA_UNAVAILABLE: "Two-factor verification is not available yet.",
  MAIL_DRAFT_REVISION_CONFLICT: "This draft was changed elsewhere. Reload to continue.",
  MAIL_INVALID_TRANSITION: "This action is not allowed in the current state.",
  MAIL_CONVERSATION_LOCKED: "Another teammate is replying to this conversation.",
  MAIL_ADDRESS_TAKEN: "This address is already assigned.",
  MAIL_ALIAS_LOOP: "Alias configuration would create a loop.",
  MAIL_ATTACHMENT_TOO_LARGE: "Attachment exceeds the allowed size.",
  MAIL_ATTACHMENT_QUARANTINED: "This attachment is quarantined.",
  MAIL_ATTACHMENT_NOT_CLEAN: "Attachments must pass malware scanning before sending.",
  MAIL_QUOTA_EXCEEDED: "Sending quota exceeded.",
  MAIL_RATE_LIMITED: "Too many requests.",
  MAIL_STORAGE_UNAVAILABLE: "Private mail storage is unavailable.",
  MAIL_SCHEMA_NOT_READY: "CosmicForge Mail is not ready: its database migrations have not been applied.",
  MAIL_PROVIDER_UNAVAILABLE: "The mail provider is unavailable.",
  MAIL_WEBHOOK_SIGNATURE_INVALID: "Webhook signature verification failed.",
  MAIL_PREFLIGHT_FAILED: "Campaign preflight checks failed.",
  MAIL_TEMPLATE_INVALID_VARIABLE: "Template uses an unsupported variable.",
  MAIL_CONSENT_REQUIRED: "Consent evidence is required.",
  MAIL_LEGAL_HOLD: "Content is under legal hold.",
};

const DEFAULT_STATUS = {
  MAIL_DISABLED: 503,
  MAIL_SENDING_DISABLED: 503,
  MAIL_RECEIVING_DISABLED: 503,
  MAIL_MARKETING_DISABLED: 503,
  MAIL_STORAGE_UNAVAILABLE: 503,
  MAIL_SCHEMA_NOT_READY: 503,
  MAIL_PROVIDER_UNAVAILABLE: 503,
  MAIL_FORBIDDEN: 403,
  MAIL_IDENTITY_INACTIVE: 403,
  MAIL_SENDER_NOT_AUTHORIZED: 403,
  MAIL_STEP_UP_REQUIRED: 403,
  MAIL_MFA_NOT_ENROLLED: 403,
  MAIL_MFA_INVALID: 403,
  MAIL_MFA_SESSION_REQUIRED: 403,
  MAIL_MFA_LOCKED: 429,
  MAIL_MFA_UNAVAILABLE: 503,
  MAIL_ATTACHMENT_QUARANTINED: 403,
  MAIL_WEBHOOK_SIGNATURE_INVALID: 401,
  MAIL_NOT_FOUND: 404,
  MAIL_DRAFT_REVISION_CONFLICT: 409,
  MAIL_INVALID_TRANSITION: 409,
  MAIL_CONVERSATION_LOCKED: 409,
  MAIL_ADDRESS_TAKEN: 409,
  MAIL_ALIAS_LOOP: 409,
  MAIL_LEGAL_HOLD: 409,
  MAIL_ATTACHMENT_TOO_LARGE: 413,
  MAIL_PREFLIGHT_FAILED: 422,
  MAIL_ATTACHMENT_NOT_CLEAN: 422,
  MAIL_QUOTA_EXCEEDED: 429,
  MAIL_RATE_LIMITED: 429,
};

const RETRYABLE = new Set(["MAIL_SCHEMA_NOT_READY", "MAIL_STORAGE_UNAVAILABLE", "MAIL_PROVIDER_UNAVAILABLE", "MAIL_RATE_LIMITED"]);

function mailError(code, details = {}, message) {
  const status = details.status || DEFAULT_STATUS[code] || 400;
  const { status: _ignored, ...rest } = details;
  const error = new ApiError(status, message || DEFAULT_MESSAGES[code] || "Mail request failed", [
    { code, retryable: RETRYABLE.has(code), ...rest },
  ]);
  return error;
}

function isMailError(error, code) {
  return error instanceof ApiError && (!code || error.code === code);
}

module.exports = { mailError, isMailError, DEFAULT_MESSAGES };
