"use strict";

// Explicit mapping from Karryam Go's native notification event types
// (KarryGo shared/go/notifications/notifications.go, Event* constants) to
// HQ Mail contract v1 events. Used ONLY by the scoped legacy-shape
// normalizer (karryam-compat.js). Anything not listed here is refused; there
// is no pattern matching and no pass-through.
//
// HQ never receives Karryam message content and never sends Karryam mail:
// the only native event HQ can act on is a booking completion, which becomes
// an approved marketing trigger (never consent; every automation send
// re-checks marketing consent). Transactional notifications (OTP, booking
// lifecycle, payments) stay inside Karryam.

const { approvedEvent } = require("../marketing/automation/event-registry");

// Karryam source_service values (sourceService constants in each Karryam
// service's notification client) -> the approved `service` attribute.
const KARRYAM_SERVICE_ATTRIBUTE = Object.freeze({
  "driver-hauling-service": "hauling",
  "driver-taxi-service": "taxi",
  "driver-dispatch-delivery-service": "dispatch",
});

const KARRYAM_NATIVE_EVENTS = Object.freeze({
  // notifications.EventBookingCompleted
  "booking.completed": Object.freeze({ eventType: "marketing.trigger", eventVersion: 1, triggerType: "karryam.booking.completed", triggerVersion: 1, sources: Object.keys(KARRYAM_SERVICE_ATTRIBUTE) }),
});

// Native events that are explicitly refused with a precise reason (instead of
// the generic unsupported-event error), because they must never leave Karryam.
const KARRYAM_REFUSED_EVENTS = Object.freeze({
  "customer.auth.otp": "OTP_NEVER_SENT_TO_HQ",
});

function karryamMapping(nativeEventType) {
  const entry = KARRYAM_NATIVE_EVENTS[nativeEventType];
  if (!entry) return null;
  // The mapped trigger must also be approved in the marketing registry.
  if (!approvedEvent(entry.triggerType, entry.triggerVersion)) return null;
  return entry;
}

module.exports = { KARRYAM_NATIVE_EVENTS, KARRYAM_REFUSED_EVENTS, KARRYAM_SERVICE_ATTRIBUTE, karryamMapping };
