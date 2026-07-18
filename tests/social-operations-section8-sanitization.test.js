const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeForResponse,
  sanitizeOperationRecord,
  sanitizeConnectionRecord,
} = require("../src/modules/marketing/social-operations/services/sanitization.service");

test("connection responses expose safe metadata only", () => {
  const sanitized = sanitizeConnectionRecord({
    id: "conn",
    provider: "META",
    status: "ACTIVE",
    accessToken: "secret",
    refreshToken: "secret",
    encryptedCredentials: Buffer.from("secret"),
    providerAuthorization: "Bearer secret",
    scopes: ["pages_read_engagement"],
  });

  assert.equal(sanitized.id, "conn");
  assert.equal(sanitized.provider, "META");
  assert.deepEqual(sanitized.scopes, ["pages_read_engagement"]);
  assert.equal("accessToken" in sanitized, false);
  assert.equal("refreshToken" in sanitized, false);
  assert.equal("encryptedCredentials" in sanitized, false);
  assert.equal("providerAuthorization" in sanitized, false);
});

test("operations responses remove payload and content fields", () => {
  const sanitized = sanitizeOperationRecord({
    id: "job",
    jobType: "REPLY_COMMENT",
    payloadJson: { text: "private" },
    credentials: "secret",
    authorizationHeader: "Bearer secret",
    messageContent: "private message",
    commentContent: "private comment",
    content: "private",
    lastError: "rate_limited",
  });

  assert.deepEqual(sanitized, {
    id: "job",
    jobType: "REPLY_COMMENT",
    lastError: "rate_limited",
  });
});

test("sanitization recursively removes raw webhook and provider response data", () => {
  const sanitized = sanitizeForResponse({
    ok: true,
    nested: {
      webhookPayload: { raw: true },
      rawProviderResponse: { token: "secret" },
      safe: "value",
    },
  });
  assert.deepEqual(sanitized, { ok: true, nested: { safe: "value" } });
});

