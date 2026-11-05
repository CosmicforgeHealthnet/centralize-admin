"use strict";

// Marketing permission for tests, through the same paths production uses.
// Staff never choose a consent source (the server records MANUAL). A contact
// becomes eligible only by confirming the double opt-in email themselves (the
// token is exposed to the API caller only outside production when confirmation
// emails are disabled) or by a second approver accepting documented consent.

const assert = require("node:assert/strict");
const crypto = require("crypto");

// Allowed choices the API enforces (MAIL_MARKETING_CONSENT_*).
const CONSENT_ENV = {
  MAIL_MARKETING_CONSENT_TOPICS: "newsletter,news,offers,caps,tips,product-updates,other",
  MAIL_MARKETING_CONSENT_POLICY_VERSIONS: "2026-10,2026-11,1,v1",
};

const requestConfirmation = (topic = "newsletter", extra = {}) => ({ mode: "REQUEST_CONFIRMATION", topic, policyVersion: "2026-10", ...extra });
const documented = (topic = "newsletter", extra = {}) => ({ mode: "DOCUMENTED", topic, policyVersion: "2026-10", evidence: { reference: `form-${crypto.randomUUID().slice(0, 8)}` }, ...extra });

// The contact confirms (public route); returns the confirmed state.
async function confirmContact(call, response) {
  const token = response.body?.data?.confirmationToken;
  assert.ok(token, `confirmation token expected (non-production, confirmation emails off): ${response.text}`);
  const confirmed = await call(null, "POST", "/public/consent/confirm", { token });
  assert.equal(confirmed.status, 200, confirmed.text);
  return response.body.data;
}

module.exports = { CONSENT_ENV, requestConfirmation, documented, confirmContact };
