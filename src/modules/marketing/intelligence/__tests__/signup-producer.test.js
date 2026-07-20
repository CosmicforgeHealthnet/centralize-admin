const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const verificationServicePath = path.resolve(__dirname, "..", "..", "..", "verification", "verification.service.js");

function source() {
  return fs.readFileSync(verificationServicePath, "utf8");
}

test("real verification approval producer emits signup only after the main transaction resolves", () => {
  const text = source();
  const transactionIndex = text.indexOf("await mainPrisma.$transaction");
  const publishIndex = text.indexOf("eventBus.publish(EVENTS.USER_SIGNUP_COMPLETED");

  assert.ok(transactionIndex > 0);
  assert.ok(publishIndex > transactionIndex);
  assert.match(text, /deterministicSignupEventId\(newUser\.id, `lab:\$\{id\}`\)/);
  assert.match(text, /signupEventPayload = \{/);
  assert.match(text, /occurredAt: now\.toISOString\(\)/);
});

test("verification signup producer stays decoupled from Marketing Intelligence services", () => {
  const text = source();

  assert.equal(/require\([^)]*marketing\/intelligence/i.test(text), false);
  assert.equal(text.includes("FunnelEvent"), false);
  assert.equal(text.includes("attribution.service"), false);
  assert.ok(text.includes('require("../../shared/events/eventBus")'));
  assert.ok(text.includes('require("../../shared/events/events")'));
});

test("signup payload carries known attribution context without inventing values", () => {
  const text = source();

  for (const field of [
    "anonId",
    "sessionAttributionToken",
    "source",
    "platform",
    "connectionId",
    "accountExternalId",
    "campaignExternalId",
    "utmParams",
    "correlationId",
  ]) {
    assert.ok(text.includes(`${field}: attribution.${field} || null`), `${field} missing from signup payload`);
  }
});
