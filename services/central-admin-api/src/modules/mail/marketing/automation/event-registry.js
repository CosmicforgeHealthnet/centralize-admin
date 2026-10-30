"use strict";

// Approved product events that may trigger marketing automations. Only the
// listed, versioned event types are accepted, and only the listed payload
// fields are kept (everything else is dropped before storage). A product event
// is never consent: every automation send re-checks marketing consent.
//
// Adding an event requires the product owner's approval (M8 contract) and a
// privacy review. HealthNet clinical / patient events are deliberately absent
// and are rejected by the M8 integration layer.

const APPROVED_PRODUCT_EVENTS = Object.freeze({
  "karryam.account.registered": { versions: [1], product: "karryam", fields: { plan: "string", city: "string", channel: "string" } },
  "karryam.booking.completed": { versions: [1], product: "karryam", fields: { service: "string", city: "string", bookingCount: "number" } },
  "karryam.booking.first_completed": { versions: [1], product: "karryam", fields: { service: "string", city: "string" } },
  "karryam.subscription.renewed": { versions: [1], product: "karryam", fields: { plan: "string" } },
});

function approvedEvent(eventType, version) {
  const entry = APPROVED_PRODUCT_EVENTS[eventType];
  if (!entry || !entry.versions.includes(Number(version))) return null;
  return entry;
}

// Keep only approved fields with the declared primitive types; strings are
// bounded. Returns { payload, dropped } so callers can audit dropped keys.
function minimizePayload(eventType, version, raw) {
  const entry = approvedEvent(eventType, version);
  if (!entry) return null;
  const payload = {};
  const dropped = [];
  for (const [key, value] of Object.entries(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {})) {
    const type = entry.fields[key];
    if (!type || typeof value !== type) {
      dropped.push(key);
      continue;
    }
    payload[key] = type === "string" ? String(value).replace(/[\u0000-\u001f<>]/g, "").slice(0, 120) : Number.isFinite(value) ? value : null;
  }
  return { payload, dropped };
}

module.exports = { APPROVED_PRODUCT_EVENTS, approvedEvent, minimizePayload };
