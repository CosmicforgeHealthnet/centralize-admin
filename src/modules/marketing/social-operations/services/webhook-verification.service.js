const crypto = require("crypto");
const ApiError = require("../../../../shared/utils/ApiError");
const { assertProvider } = require("../validators/social.validator");

function secretEnvName(provider) {
  return `SOCIAL_${provider}_WEBHOOK_SECRET`;
}

function verificationTokenEnvName(provider) {
  return `SOCIAL_${provider}_WEBHOOK_VERIFY_TOKEN`;
}

function resolveWebhookSecret(provider) {
  return process.env[secretEnvName(provider)] || null;
}

function hmacHex(secret, rawBody) {
  return crypto
    .createHmac("sha256", secret)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || "")))
    .digest("hex");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function extractSignature(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }

  const raw =
    normalized["x-social-signature"] ||
    normalized["x-hub-signature-256"] ||
    normalized["x-tiktok-signature"] ||
    normalized["x-twitter-webhooks-signature"] ||
    normalized["x-linkedin-signature"];

  if (!raw) return null;
  return String(raw).startsWith("sha256=") ? String(raw).slice("sha256=".length) : String(raw);
}

function verifyWebhookSignature({ provider, headers, rawBody, secret } = {}) {
  const normalizedProvider = assertProvider(provider);
  const resolvedSecret = secret || resolveWebhookSecret(normalizedProvider);
  if (!resolvedSecret) {
    return {
      valid: false,
      reasonCode: "WEBHOOK_SECRET_NOT_CONFIGURED",
    };
  }

  const signature = extractSignature(headers);
  if (!signature) {
    return {
      valid: false,
      reasonCode: "WEBHOOK_SIGNATURE_MISSING",
    };
  }

  const expected = hmacHex(resolvedSecret, rawBody);
  return {
    valid: safeEqual(signature, expected),
    reasonCode: safeEqual(signature, expected) ? null : "WEBHOOK_SIGNATURE_INVALID",
  };
}

function handleWebhookChallenge({ provider, query } = {}) {
  const normalizedProvider = assertProvider(provider);

  if (normalizedProvider === "META") {
    const mode = query?.["hub.mode"];
    const token = query?.["hub.verify_token"];
    const challenge = query?.["hub.challenge"];
    const expectedToken = process.env[verificationTokenEnvName(normalizedProvider)];

    if (mode !== "subscribe" || !challenge) {
      throw new ApiError(400, "Invalid webhook verification challenge");
    }
    if (!expectedToken || token !== expectedToken) {
      throw new ApiError(403, "Webhook verification token is invalid");
    }
    return { provider: normalizedProvider, challenge: String(challenge), raw: true };
  }

  throw new ApiError(400, "Webhook challenge is not configured for this provider");
}

function signWebhookPayload({ provider, rawBody, secret } = {}) {
  const resolvedSecret = secret || resolveWebhookSecret(assertProvider(provider));
  if (!resolvedSecret) throw new Error("Webhook secret is not configured");
  return `sha256=${hmacHex(resolvedSecret, rawBody)}`;
}

module.exports = {
  secretEnvName,
  verificationTokenEnvName,
  resolveWebhookSecret,
  verifyWebhookSignature,
  handleWebhookChallenge,
  signWebhookPayload,
};
