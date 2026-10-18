const assert = require("node:assert/strict");
const test = require("node:test");

const {
  validateNormalizedProviderContent,
  validateNormalizedWebhookEvent,
} = require("../connectors/connector.validators");
const {
  mapProviderPublishResult,
  validatePublishResult,
} = require("../connectors/publish-result.mapper");
const { mapTikTokPublishResult } = require("../connectors/tiktok-publish-result.mapper");
const { ConnectorNormalizationError } = require("../connectors/connector.errors");

test("normalized provider content validation accepts safe content and rejects unsafe content", () => {
  assert.deepEqual(
    validateNormalizedProviderContent({
      providerContentId: "provider-1",
      contentType: "TEXT",
      text: "hello",
      providerUrl: null,
      providerCreatedAt: null,
      providerUpdatedAt: null,
      metadata: { campaign: "spring" },
    }),
    {
      providerContentId: "provider-1",
      contentType: "TEXT",
      text: "hello",
      providerUrl: null,
      providerCreatedAt: null,
      providerUpdatedAt: null,
      metadata: { campaign: "spring" },
    },
  );

  assert.throws(
    () => validateNormalizedProviderContent({ contentType: "TEXT", metadata: {} }),
    ConnectorNormalizationError,
  );
  assert.throws(
    () =>
      validateNormalizedProviderContent({
        providerContentId: "provider-1",
        contentType: "UNKNOWN",
      }),
    ConnectorNormalizationError,
  );
  assert.throws(
    () =>
      validateNormalizedProviderContent({
        providerContentId: "provider-1",
        contentType: "TEXT",
        metadata: { accessToken: "secret" },
      }),
    ConnectorNormalizationError,
  );
});

test("normalized webhook event validation accepts allowed kinds and rejects unsafe shapes", () => {
  assert.deepEqual(
    validateNormalizedWebhookEvent({
      kind: "MESSAGE",
      eventId: "event-1",
      identityProviderId: "identity-1",
      data: { providerMessageId: "message-1" },
    }),
    {
      kind: "MESSAGE",
      eventId: "event-1",
      identityProviderId: "identity-1",
      data: { providerMessageId: "message-1" },
    },
  );

  assert.throws(
    () => validateNormalizedWebhookEvent({ kind: "UNKNOWN", data: {} }),
    ConnectorNormalizationError,
  );
  assert.throws(
    () => validateNormalizedWebhookEvent({ kind: "MESSAGE" }),
    ConnectorNormalizationError,
  );
});

test("publish result validation rejects invalid or fake provider states", () => {
  assert.deepEqual(
    validatePublishResult({
      providerPostId: "provider-1",
      url: "https://example.test/post/provider-1",
      status: "PROCESSING",
    }),
    {
      providerPostId: "provider-1",
      url: "https://example.test/post/provider-1",
      status: "PROCESSING",
    },
  );

  assert.throws(
    () => validatePublishResult({ providerPostId: "provider-1", status: "SUBMITTED" }),
    ConnectorNormalizationError,
  );
  assert.throws(
    () => validatePublishResult({ providerPostId: "provider-1", status: "UNKNOWN" }),
    ConnectorNormalizationError,
  );
  assert.throws(
    () => validatePublishResult({ providerPostId: "local-123", status: "PROCESSING" }),
    ConnectorNormalizationError,
  );
  assert.throws(
    () => validatePublishResult({ providerPostId: "provider-1", status: "PUBLISHED" }),
    ConnectorNormalizationError,
  );
});

test("provider submission acknowledgements and TikTok draft modes normalize safely", () => {
  assert.equal(
    mapProviderPublishResult({ providerPostId: "provider-1", accepted: true }).status,
    "PROCESSING",
  );

  const draft = mapTikTokPublishResult({
    postingMode: "UPLOAD_TO_DRAFT",
    providerPostId: "draft-1",
  });
  assert.equal(draft.status, "AWAITING_USER_ACTION");
  assert.equal(draft.postingMode, "UPLOAD_TO_DRAFT");
  assert.notEqual(draft.status, "PUBLISHED");

  const direct = mapTikTokPublishResult({
    postingMode: "DIRECT_POST",
    providerPostId: "direct-1",
  });
  assert.equal(direct.status, "PROCESSING");
  assert.notEqual(direct.status, "SUBMITTED");

  assert.equal(
    mapTikTokPublishResult({
      postingMode: "DIRECT_POST",
      providerPostId: "direct-2",
      confirmed: true,
    }).status,
    "PUBLISHED",
  );
  assert.throws(
    () => mapTikTokPublishResult({ postingMode: "SIDELOAD" }),
    ConnectorNormalizationError,
  );
});
