"use strict";

// Reserved sender addresses (MAIL_RESERVED_SENDER_ADDRESSES).
//
// A reserved address lives on one of our domains but is owned by another
// system that sends through the provider directly, e.g. the KarryGo
// Notification Service sending OTPs and login codes as no-reply@karryam.com.
// CosmicForge Admin is never in that delivery path, so for CA:
//   - nobody may send as it (staff identities, sender grants, marketing);
//   - it may only exist as a SYSTEM address without a mailbox;
//   - inbound mail to it is discarded with an audit record (no catch-all,
//     no quarantine hold, nothing stored);
//   - provider events for mail it sent are acknowledged and not stored.
//
// Most callers use config.reservedSenders (loaded from the env passed to
// loadMailConfig). Code that has no config in scope (the authorization
// policy, the marketing sender helpers) reads process.env through
// reservedSenderSet(), which parses the same variable.

const { normalizeAddress, parseParty } = require("./address.util");

function parseReservedSenders(value) {
  const addresses = [];
  const invalid = [];
  for (const entry of String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const address = normalizeAddress(entry);
    if (address) {
      if (!addresses.includes(address)) addresses.push(address);
    } else invalid.push(entry.slice(0, 80));
  }
  return { addresses, invalid };
}

function reservedSenderSet(source = process.env) {
  if (Array.isArray(source)) return new Set(source);
  if (Array.isArray(source?.reservedSenders)) return new Set(source.reservedSenders);
  return new Set(parseReservedSenders(source?.MAIL_RESERVED_SENDER_ADDRESSES).addresses);
}

function isReservedSender(address, source = process.env) {
  const normalized = normalizeAddress(address);
  return Boolean(normalized) && reservedSenderSet(source).has(normalized);
}

// The bare address of a provider event's `from` ("Name <a@b.c>" or "a@b.c").
function eventSenderAddress(from) {
  if (!from) return null;
  return parseParty(Array.isArray(from) ? from[0] : from)?.address || null;
}

module.exports = { parseReservedSenders, reservedSenderSet, isReservedSender, eventSenderAddress };
