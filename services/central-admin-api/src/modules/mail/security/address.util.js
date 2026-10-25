"use strict";

// Conservative address handling. We deliberately accept a strict subset of
// RFC 5321/5322 (no quoted local parts, no IP literals, no comments) because
// every accepted value may later be placed into a provider request or header.

const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function normalizeDomain(value) {
  const domain = String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!domain || domain.length > 253 || !DOMAIN.test(domain)) return null;
  return domain;
}

function normalizeLocalPart(value) {
  const local = String(value ?? "").trim().toLowerCase();
  if (!local || local.length > 64 || !LOCAL_PART.test(local)) return null;
  return local;
}

function normalizeAddress(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 320 || CONTROL.test(raw)) return null;
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return null;
  const local = normalizeLocalPart(raw.slice(0, at));
  const domain = normalizeDomain(raw.slice(at + 1));
  if (!local || !domain) return null;
  return `${local}@${domain}`;
}

function domainOf(address) {
  const normalized = normalizeAddress(address);
  return normalized ? normalized.split("@")[1] : null;
}

function cleanDisplayName(value) {
  if (value == null) return null;
  const name = String(value).replace(/[\u0000-\u001f\u007f"<>\\]/g, "").trim().slice(0, 160);
  return name || null;
}

// Parses `Name <a@b.c>` or `a@b.c`. Returns null when invalid.
function parseParty(input) {
  if (input && typeof input === "object") {
    const address = normalizeAddress(input.address || input.email);
    return address ? { address, name: cleanDisplayName(input.name) } : null;
  }
  const raw = String(input ?? "").trim();
  const match = raw.match(/^(.*)<([^<>]+)>\s*$/);
  if (match) {
    const address = normalizeAddress(match[2]);
    return address ? { address, name: cleanDisplayName(match[1].replace(/^"|"$/g, "")) } : null;
  }
  const address = normalizeAddress(raw);
  return address ? { address, name: null } : null;
}

function parsePartyList(input) {
  const values = Array.isArray(input)
    ? input
    : String(input ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
  const parties = [];
  const invalid = [];
  const seen = new Set();
  for (const value of values) {
    const party = parseParty(value);
    if (!party) {
      invalid.push(typeof value === "string" ? value.slice(0, 80) : String(value?.address || "").slice(0, 80));
      continue;
    }
    if (seen.has(party.address)) continue;
    seen.add(party.address);
    parties.push(party);
  }
  return { parties, invalid };
}

function formatParty(party) {
  if (!party) return "";
  const name = cleanDisplayName(party.name);
  return name ? `"${name}" <${party.address}>` : party.address;
}

module.exports = {
  normalizeAddress,
  normalizeDomain,
  normalizeLocalPart,
  domainOf,
  parseParty,
  parsePartyList,
  formatParty,
  cleanDisplayName,
};
