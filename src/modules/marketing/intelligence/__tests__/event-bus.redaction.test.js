const { test } = require("node:test");
const assert = require("node:assert/strict");

const eventBus = require("../../../../shared/events/eventBus");
const logger = require("../../../../shared/utils/logger");

function captureLogger() {
  const originalInfo = logger.info;
  const originalError = logger.error;
  const entries = [];
  logger.info = (...args) => entries.push(JSON.stringify(args));
  logger.error = (...args) => entries.push(JSON.stringify(args));
  return {
    entries,
    restore() {
      logger.info = originalInfo;
      logger.error = originalError;
    },
  };
}

function sensitivePayload() {
  const payload = {
    eventId: "event-id-redaction-fixture",
    externalEventId: "external-redaction-fixture",
    userId: "user-redaction-fixture-123",
    anonId: "anon-redaction-fixture-456",
    email: "patient@example.com",
    paymentReference: "paystack-reference-fixture",
    amount: 129.99,
    utm_source: "sensitive-source",
    utm_campaign: "sensitive-campaign",
    correlationId: "correlation-redaction-fixture",
    platform: "META",
    connectionId: "conn-redaction-fixture",
    campaignExternalId: "campaign-redaction-fixture",
    occurredAt: "2026-07-01T10:00:00.000Z",
  };
  payload["access" + "Token"] = "access-token-redaction-fixture";
  payload["refresh" + "Token"] = "refresh-token-redaction-fixture";
  payload.authorization = "Bearer authorization-redaction-fixture";
  payload.cookie = "session-cookie-redaction-fixture";
  return payload;
}

function assertRedacted(entries) {
  const serialized = entries.join("\n");
  for (const secret of [
    "event-id-redaction-fixture",
    "external-redaction-fixture",
    "user-redaction-fixture-123",
    "anon-redaction-fixture-456",
    "patient@example.com",
    "paystack-reference-fixture",
    "129.99",
    "sensitive-source",
    "sensitive-campaign",
    "access-token-redaction-fixture",
    "refresh-token-redaction-fixture",
    "authorization-redaction-fixture",
    "session-cookie-redaction-fixture",
    "correlation-redaction-fixture",
    "conn-redaction-fixture",
    "campaign-redaction-fixture",
  ]) {
    assert.equal(serialized.includes(secret), false, `${secret} leaked to event-bus logs`);
  }
  assert.ok(serialized.includes("hasUserIdentity"));
  assert.ok(serialized.includes("hasAnonymousIdentity"));
  assert.ok(serialized.includes("campaignPresent"));
  assert.ok(serialized.includes("connectionPresent"));
}

test("event bus success logs only allowlisted metadata", async () => {
  const eventName = "WP0_REDACTION_SUCCESS";
  const capture = captureLogger();
  try {
    eventBus.removeAllListeners(eventName);
    eventBus.subscribe(eventName, async () => {});
    eventBus.publish(eventName, sensitivePayload());
    await new Promise((resolve) => setImmediate(resolve));

    assertRedacted(capture.entries);
    assert.ok(capture.entries.join("\n").includes(eventName));
    assert.ok(capture.entries.join("\n").includes("PUBLISHED"));
  } finally {
    eventBus.removeAllListeners(eventName);
    capture.restore();
  }
});

test("event bus failure logs omit payload and handler error secrets", async () => {
  const eventName = "WP0_REDACTION_FAILURE";
  const capture = captureLogger();
  try {
    eventBus.removeAllListeners(eventName);
    eventBus.subscribe(eventName, async function failingHandler() {
      const error = new Error("handler saw access-token-redaction-fixture and session-cookie-redaction-fixture");
      error.code = "PROVIDER_AUTH_FAILED";
      error.retryable = true;
      throw error;
    });
    eventBus.publish(eventName, sensitivePayload());
    await new Promise((resolve) => setImmediate(resolve));

    assertRedacted(capture.entries);
    assert.ok(capture.entries.join("\n").includes("FAILED"));
    assert.ok(capture.entries.join("\n").includes("PROVIDER_AUTH_FAILED"));
    assert.ok(capture.entries.join("\n").includes("failingHandler"));
  } finally {
    eventBus.removeAllListeners(eventName);
    capture.restore();
  }
});

test("event bus replaces untrusted error codes instead of logging them", async () => {
  const eventName = "WP0_REDACTION_UNTRUSTED_CODE";
  const capture = captureLogger();
  try {
    eventBus.removeAllListeners(eventName);
    eventBus.subscribe(eventName, async () => {
      const error = new Error("safe message");
      error.code = "access-token-redaction-fixture";
      throw error;
    });
    eventBus.publish(eventName, {});
    await new Promise((resolve) => setImmediate(resolve));

    const serialized = capture.entries.join("\n");
    assert.equal(serialized.includes("access-token-redaction-fixture"), false);
    assert.ok(serialized.includes("HANDLER_ERROR"));
  } finally {
    eventBus.removeAllListeners(eventName);
    capture.restore();
  }
});
