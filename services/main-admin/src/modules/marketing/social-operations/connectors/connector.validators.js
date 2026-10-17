const {
  SOCIAL_PROVIDER_CONTENT_TYPES,
  WEBHOOK_EVENT_KINDS,
} = require("./connector.constants");
const {
  ConnectorNormalizationError,
  ConnectorValidationError,
} = require("./connector.errors");

const SENSITIVE_METADATA_KEYS = [
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /authorization/i,
  /bearer/i,
  /encrypted[_-]?credentials/i,
  /credential/i,
  /secret/i,
  /password/i,
];

function hasSensitiveMetadataKey(value) {
  if (!value || typeof value !== "object") return false;

  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_METADATA_KEYS.some((pattern) => pattern.test(key))) {
      return true;
    }
    if (nested && typeof nested === "object" && hasSensitiveMetadataKey(nested)) {
      return true;
    }
  }

  return false;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorNormalizationError(`${label} must be a normalized object`);
  }
}

function validateNormalizedProviderContent(content) {
  assertPlainObject(content, "Provider content");

  if (!content.providerContentId || typeof content.providerContentId !== "string") {
    throw new ConnectorNormalizationError("Provider content ID is required");
  }

  if (!SOCIAL_PROVIDER_CONTENT_TYPES.includes(content.contentType)) {
    throw new ConnectorNormalizationError("Provider content type is unsupported");
  }

  if (content.text !== null && content.text !== undefined && typeof content.text !== "string") {
    throw new ConnectorNormalizationError("Provider content text must be a string or null");
  }

  if (
    content.providerUrl !== null &&
    content.providerUrl !== undefined &&
    typeof content.providerUrl !== "string"
  ) {
    throw new ConnectorNormalizationError("Provider URL must be a string or null");
  }

  if (content.metadata !== null && content.metadata !== undefined) {
    assertPlainObject(content.metadata, "Provider metadata");
    if (hasSensitiveMetadataKey(content.metadata)) {
      throw new ConnectorNormalizationError("Provider metadata contains sensitive keys");
    }
  }

  return {
    providerContentId: content.providerContentId,
    contentType: content.contentType,
    text: content.text ?? null,
    providerUrl: content.providerUrl ?? null,
    providerCreatedAt: content.providerCreatedAt ?? null,
    providerUpdatedAt: content.providerUpdatedAt ?? null,
    metadata: content.metadata ?? {},
  };
}

function validateNormalizedWebhookEvent(event) {
  assertPlainObject(event, "Webhook event");

  if (!WEBHOOK_EVENT_KINDS.includes(event.kind)) {
    throw new ConnectorNormalizationError("Webhook event kind is unsupported");
  }

  if (event.eventId !== null && event.eventId !== undefined && typeof event.eventId !== "string") {
    throw new ConnectorNormalizationError("Webhook event ID must be a string or null");
  }

  if (
    event.identityProviderId !== null &&
    event.identityProviderId !== undefined &&
    typeof event.identityProviderId !== "string"
  ) {
    throw new ConnectorNormalizationError(
      "Webhook identity provider ID must be a string or null",
    );
  }

  assertPlainObject(event.data, "Webhook event data");
  if (hasSensitiveMetadataKey(event.data)) {
    throw new ConnectorNormalizationError("Webhook event data contains sensitive keys");
  }

  return {
    kind: event.kind,
    eventId: event.eventId ?? null,
    identityProviderId: event.identityProviderId ?? null,
    data: event.data,
  };
}

function assertPublishingConnection(connection, platform) {
  if (!connection || typeof connection !== "object") {
    throw new ConnectorValidationError("Social connection is required", { platform });
  }

  if (connection.provider && connection.provider !== platform) {
    throw new ConnectorValidationError("Social connection provider mismatch", {
      platform,
    });
  }

  if (
    connection.platform &&
    !connection.provider &&
    Object.hasOwn(connection, "accountId")
  ) {
    throw new ConnectorValidationError(
      "Advertising connections are not organic publishing connections",
      { platform },
    );
  }
}

module.exports = {
  hasSensitiveMetadataKey,
  validateNormalizedProviderContent,
  validateNormalizedWebhookEvent,
  assertPublishingConnection,
};
