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

// ── Product registrations (contract v1) ──────────────────────────────────
// Managed products registered to deliver contract-v1 events to HQ Mail and
// the event types an integration for that product may be allowed. A
// registered product can never be granted (or deliver) an event type outside
// its list; products not listed here keep the generic per-classification
// rules in integration.service.js. This is a product registration only: it
// creates no integration, no organization and no mailbox. A mail
// administrator still creates and activates the integration (owner approval
// plus MFA step-up), exactly as for Karryam.
//
// ops.alert@1 notifications for a product go to staff holding the Mail
// administrator grant (mail / admin) or that product's integration grant
// (mail / integration:<product>), and nobody else.
const PRODUCT_EVENT_REGISTRATIONS = Object.freeze({
  karryam: Object.freeze(["mail.delivery_status", "marketing.trigger", "ops.alert"]),
  // CF Meet (docs/product-admin/cfmeet-admin-design.md section 7): operational
  // alerts only. CF Meet keeps its own transactional mail and has no
  // approved marketing triggers.
  cfmeet: Object.freeze(["ops.alert"]),
});

function registeredProductEventTypes(product) {
  return Object.prototype.hasOwnProperty.call(PRODUCT_EVENT_REGISTRATIONS, product) ? PRODUCT_EVENT_REGISTRATIONS[product] : null;
}

// True when `product` may use `eventType`: always for unregistered products
// (generic rules apply), and only for listed types for registered ones.
function productAllowsEventType(product, eventType) {
  const registered = registeredProductEventTypes(product);
  return !registered || registered.includes(eventType);
}

// Section grants (module "mail") whose holders receive a product's ops alerts.
function opsAlertRecipientSections(product) {
  return ["admin", `integration:${product}`];
}

module.exports = { KARRYAM_NATIVE_EVENTS, KARRYAM_REFUSED_EVENTS, KARRYAM_SERVICE_ATTRIBUTE, karryamMapping, PRODUCT_EVENT_REGISTRATIONS, registeredProductEventTypes, productAllowsEventType, opsAlertRecipientSections };
