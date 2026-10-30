"use strict";

// Inbound sender authentication (spec 10.4, 19.4).
//
// Trust boundary: only two sources are believed.
//   1. provider   - the provider's own SPF/DKIM/DMARC evaluation, returned by
//                   its authenticated API (Resend `authentication`).
//   2. trusted-header - an Authentication-Results header whose authserv-id is
//                   explicitly configured (MAIL_TRUSTED_AUTHSERV_IDS), i.e.
//                   stamped by our own receiving MTA. Any other
//                   Authentication-Results / Received-SPF header is sender
//                   controlled and is ignored for decisions.
//
// Verdicts: PASS | NONE (no trusted evidence / neutral) | SUSPICIOUS | FAIL.
// Legitimate forwarding breaks SPF but keeps DKIM, so "SPF fail + DKIM pass"
// is PASS, and a lone SPF failure is never grounds for rejection.
//
// Policy (MAIL_INBOUND_AUTH_POLICY):
//   monitor    - record and warn only, never quarantine
//   warn       - (default) warn; quarantine only spoofed internal domains
//   quarantine - also quarantine DMARC failures
// MAIL_INBOUND_QUARANTINE_INTERNAL_SPOOF (default true) controls the
// internal-domain rule independently under "warn"/"quarantine".

const POLICIES = new Set(["monitor", "warn", "quarantine"]);

function parseAuthenticationResults(header, trustedIds) {
  if (!header || !trustedIds.length) return null;
  const values = (Array.isArray(header) ? header : [header]).map(String);
  // Only the first (topmost, added last by the receiving MTA) header counts.
  const value = values[0].slice(0, 4000);
  const authservId = value.split(";")[0].trim().split(/\s+/)[0].toLowerCase();
  if (!trustedIds.includes(authservId)) return null;
  const grab = (method) => {
    const match = new RegExp(`(?:^|;)\\s*${method}\\s*=\\s*([a-z_]+)`, "i").exec(value);
    return match ? match[1].toLowerCase() : null;
  };
  const result = { spf: grab("spf"), dkim: grab("dkim"), dmarc: grab("dmarc") };
  return result.spf || result.dkim || result.dmarc ? result : null;
}

function loadSenderAuthPolicy(env = process.env) {
  const policy = String(env.MAIL_INBOUND_AUTH_POLICY || "warn").trim().toLowerCase();
  return {
    policy: POLICIES.has(policy) ? policy : "warn",
    quarantineInternalSpoof: String(env.MAIL_INBOUND_QUARANTINE_INTERNAL_SPOOF ?? "true").trim().toLowerCase() !== "false",
    trustedAuthservIds: String(env.MAIL_TRUSTED_AUTHSERV_IDS || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean),
  };
}

// inbound: { from: {address}, providerAuthentication?, authResults?: { authenticationResults } }
// internalDomains: Set of our own (lowercase) domains.
function assessSenderAuthentication(inbound, { settings, internalDomains = new Set() }) {
  const reasons = [];
  let source = "none";
  let results = inbound.providerAuthentication || null;
  if (results) source = "provider";
  else {
    results = parseAuthenticationResults(inbound.authResults?.authenticationResults, settings.trustedAuthservIds);
    if (results) source = "trusted-header";
  }
  const fromDomain = String(inbound.from?.address || "").split("@")[1]?.toLowerCase() || "";
  const claimsInternal = Boolean(fromDomain && internalDomains.has(fromDomain));
  const spf = results?.spf || null;
  const dkim = results?.dkim || null;
  const dmarc = results?.dmarc || null;

  let verdict = "NONE";
  if (!results) reasons.push("NO_TRUSTED_AUTH_RESULTS");
  else if (dmarc === "pass") verdict = "PASS";
  else if (dmarc === "fail") {
    verdict = "FAIL";
    reasons.push("DMARC_FAIL");
  } else if (dkim === "pass") {
    verdict = "PASS";
    if (spf && spf !== "pass") reasons.push("SPF_NOT_PASS_DKIM_PASS");
  } else if (spf === "fail" && (!dkim || dkim === "fail" || dkim === "none" || dkim === "unknown")) {
    verdict = "SUSPICIOUS";
    reasons.push("SPF_FAIL_NO_DKIM");
  } else if (dkim === "fail") {
    verdict = "SUSPICIOUS";
    reasons.push("DKIM_FAIL");
  } else if (spf === "pass") {
    // SPF covers the envelope sender, not the visible From: without DMARC or
    // DKIM there is no alignment evidence, so this is neutral, not PASS.
    reasons.push("SPF_PASS_ALIGNMENT_UNKNOWN");
  }

  // A message claiming to come from one of our own domains must prove it.
  const internalSpoof = claimsInternal && verdict !== "PASS";
  if (internalSpoof) {
    verdict = "FAIL";
    reasons.push("INTERNAL_DOMAIN_NOT_AUTHENTICATED");
  }

  let quarantineReason = null;
  if (settings.policy !== "monitor") {
    if (internalSpoof && settings.quarantineInternalSpoof) quarantineReason = "INTERNAL_DOMAIN_SPOOF";
    else if (settings.policy === "quarantine" && verdict === "FAIL") quarantineReason = "SENDER_AUTHENTICATION_FAILED";
  }
  return {
    verdict,
    reasons: [...new Set(reasons)],
    source,
    results: { spf, dkim, dmarc },
    fromDomain,
    claimsInternalDomain: claimsInternal,
    warn: verdict === "FAIL" || verdict === "SUSPICIOUS",
    quarantineReason,
    policy: settings.policy,
  };
}

// Persisted form inside mail_messages.auth_results (existing JSON column).
// Untrusted header text is kept separately and explicitly labelled.
function authResultsRecord(inbound, assessment) {
  return {
    assessment: { verdict: assessment.verdict, reasons: assessment.reasons, source: assessment.source, policy: assessment.policy, results: assessment.results },
    untrustedHeaders: {
      receivedSpf: inbound.authResults?.spf || null,
      authenticationResults: inbound.authResults?.authenticationResults || null,
    },
  };
}

// What readers see (no raw headers).
function publicSenderAuthentication(authResults) {
  const assessment = authResults && typeof authResults === "object" ? authResults.assessment : null;
  if (!assessment) return null;
  return { verdict: assessment.verdict, reasons: assessment.reasons || [], source: assessment.source || "none" };
}

module.exports = { assessSenderAuthentication, loadSenderAuthPolicy, parseAuthenticationResults, authResultsRecord, publicSenderAuthentication };
