"use strict";

// One Resend account (and one API key) serves CosmicForge Admin staging,
// CosmicForge Admin production and the KarryGo Notification Service. These
// helpers keep the deployments from acting on each other's traffic:
//
//   - test recipient allowlist (MAIL_TEST_RECIPIENT_ALLOWLIST): when set,
//     external delivery may only reach the listed addresses / domains, so a
//     staging test can never mail a real customer or burn the shared quota;
//   - provider tags: every CA send carries cf_app / cf_env tags; a delivery
//     event tagged for another CA deployment is not ours to store;
//   - inbound ownership (MAIL_INBOUND_ACTIVE_ENVIRONMENT): only the deployment
//     the single webhook points at accepts or reconciles received mail.

const { normalizeAddress } = require("./address.util");

const TAG_APP = "cf_app";
const TAG_ENV = "cf_env";
// Resend tag names/values: ASCII letters, numbers, underscores, dashes.
const TAG_VALUE = /^[A-Za-z0-9_-]{1,256}$/;

function recipientApproved(policy, address) {
  if (!policy?.active) return true;
  const normalized = normalizeAddress(address);
  if (!normalized) return false;
  return policy.addresses.includes(normalized) || policy.domains.includes(normalized.split("@")[1]);
}

// Addresses in a send request that the allowlist refuses (empty = allowed).
function unapprovedRecipients(policy, request) {
  if (!policy?.active) return [];
  const all = ["to", "cc", "bcc"].flatMap((field) => (Array.isArray(request?.[field]) ? request[field] : []).map((party) => party?.address));
  return [...new Set(all.filter((address) => !recipientApproved(policy, address)))];
}

function providerTagList(tags) {
  if (!tags?.app || !tags?.environment) return [];
  return [{ name: TAG_APP, value: tags.app }, { name: TAG_ENV, value: tags.environment }].filter((tag) => TAG_VALUE.test(tag.value));
}

// Merge CA's tags into a send request without dropping the caller's own.
function withProviderTags(request, tags) {
  const ours = providerTagList(tags);
  if (!ours.length) return request;
  const existing = (Array.isArray(request.tags) ? request.tags : []).filter((tag) => tag && tag.name !== TAG_APP && tag.name !== TAG_ENV);
  return { ...request, tags: [...existing, ...ours] };
}

// Event tags arrive as an object ({ name: value }) or an array of
// { name, value }; anything else is treated as no tags.
function eventTags(data) {
  const raw = data?.tags;
  const tags = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) if (entry && typeof entry.name === "string") tags[entry.name] = String(entry.value ?? "");
  } else if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw)) tags[name] = String(value ?? "");
  }
  return tags;
}

// True only when the event carries CA's own app tag for a different
// deployment. Untagged events (older mail, other systems) return false.
function taggedForOtherDeployment(data, tags) {
  const seen = eventTags(data);
  return seen[TAG_APP] === tags?.app && Boolean(seen[TAG_ENV]) && seen[TAG_ENV] !== tags?.environment;
}

module.exports = { recipientApproved, unapprovedRecipients, providerTagList, withProviderTags, eventTags, taggedForOtherDeployment, TAG_APP, TAG_ENV };
