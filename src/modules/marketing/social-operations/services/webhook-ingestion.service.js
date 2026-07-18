const ApiError = require("../../../../shared/utils/ApiError");
const { prisma } = require("../../../../shared/config/database");
const { assertProvider } = require("../validators/social.validator");
const {
  encryptWebhookPayload,
  hashWebhookPayload,
} = require("./webhook-crypto.service");
const {
  verifyWebhookSignature,
} = require("./webhook-verification.service");

function rawBodyFromRequest(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  return Buffer.from(JSON.stringify(req.body || {}));
}

function parsedBodyFromRequest(req) {
  if (req.body && !Buffer.isBuffer(req.body) && typeof req.body === "object") {
    return req.body;
  }
  const raw = rawBodyFromRequest(req).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "Webhook payload must be valid JSON");
  }
}

function parseRawJsonBody(rawBody) {
  const raw = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "Webhook payload must be valid JSON");
  }
}

function assertWebhookPayloadSize(rawBody) {
  const maxBytes = Number(process.env.SOCIAL_WEBHOOK_MAX_BYTES || 10 * 1024);
  const size = Buffer.isBuffer(rawBody)
    ? rawBody.length
    : Buffer.byteLength(String(rawBody || ""));
  if (size > maxBytes) throw new ApiError(413, "Webhook payload is too large");
}

function extractEventId(payload) {
  return (
    payload?.eventId ||
    payload?.event_id ||
    payload?.id ||
    payload?.data?.eventId ||
    payload?.entry?.[0]?.id ||
    null
  );
}

function extractIdentityProviderId(payload) {
  return (
    payload?.identityProviderId ||
    payload?.identity_provider_id ||
    payload?.providerIdentityId ||
    payload?.data?.identityProviderId ||
    payload?.entry?.[0]?.id ||
    null
  );
}

function extractProviderEventType(payload) {
  return payload?.type || payload?.eventType || payload?.object || payload?.kind || null;
}

async function findDuplicate({ db, provider, eventId, payloadHash }) {
  if (eventId) {
    const byEventId = await db.socialWebhookEvent.findUnique({
      where: { provider_eventId: { provider, eventId } },
    });
    if (byEventId) return byEventId;
  }

  return db.socialWebhookEvent.findUnique({
    where: { provider_payloadHash: { provider, payloadHash } },
  });
}

async function ingestWebhookEvent({
  provider,
  headers,
  rawBody,
  payload,
  db = prisma,
  signatureVerifier = verifyWebhookSignature,
} = {}) {
  const normalizedProvider = assertProvider(provider);
  assertWebhookPayloadSize(rawBody);
  const signature = signatureVerifier({
    provider: normalizedProvider,
    headers,
    rawBody,
  });

  if (!signature.valid) {
    throw new ApiError(401, "Webhook signature verification failed", [
      { reasonCode: signature.reasonCode },
    ]);
  }

  const trustedPayload = payload || parseRawJsonBody(rawBody);
  const payloadHash = hashWebhookPayload(rawBody);
  const eventId = extractEventId(trustedPayload);
  const duplicate = await findDuplicate({
    db,
    provider: normalizedProvider,
    eventId,
    payloadHash,
  });
  if (duplicate) {
    return {
      acknowledged: true,
      duplicate: true,
      event: duplicate,
    };
  }

  const event = await db.socialWebhookEvent.create({
    data: {
      provider: normalizedProvider,
      eventId,
      payloadHash,
      identityProviderId: extractIdentityProviderId(trustedPayload),
      providerEventType: extractProviderEventType(trustedPayload),
      status: "RECEIVED",
      signatureValid: true,
      encryptedRawPayload: encryptWebhookPayload(rawBody),
      payloadMetadataJson: {
        eventIdPresent: Boolean(eventId),
        providerEventType: extractProviderEventType(trustedPayload),
      },
    },
  });

  return {
    acknowledged: true,
    duplicate: false,
    event,
  };
}

async function ingestWebhookRequest({ provider, req, db = prisma } = {}) {
  const rawBody = rawBodyFromRequest(req);
  return ingestWebhookEvent({
    provider,
    headers: req.headers,
    rawBody,
    db,
  });
}

module.exports = {
  rawBodyFromRequest,
  parsedBodyFromRequest,
  parseRawJsonBody,
  assertWebhookPayloadSize,
  extractEventId,
  extractIdentityProviderId,
  extractProviderEventType,
  ingestWebhookEvent,
  ingestWebhookRequest,
};
