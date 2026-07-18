const crypto = require("crypto");
const {
  encryptBuffer,
  decryptBuffer,
} = require("../security/encryption.service");

const WEBHOOK_PAYLOAD_PURPOSE = "SOCIAL_WEBHOOK_PAYLOAD";

function encryptWebhookPayload(rawBody) {
  return encryptBuffer(rawBody, { purpose: WEBHOOK_PAYLOAD_PURPOSE });
}

function decryptWebhookPayload(encryptedRawPayload) {
  return decryptBuffer(encryptedRawPayload, { purpose: WEBHOOK_PAYLOAD_PURPOSE });
}

function hashWebhookPayload(rawBody) {
  return crypto
    .createHash("sha256")
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || "")))
    .digest("hex");
}

module.exports = {
  WEBHOOK_PAYLOAD_PURPOSE,
  encryptWebhookPayload,
  decryptWebhookPayload,
  hashWebhookPayload,
};
