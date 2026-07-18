const {
  encryptCredential,
  decryptCredential,
} = require("./credential-encryption");

const ENVELOPE_MARKER = "__ENCRYPTED_CREDENTIAL_ENVELOPE__";

function normalizeEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [key, String(value)]),
  );
}

function encryptCredentialEnvelope(input) {
  const envelope = normalizeEnvelope(input);
  if (Object.keys(envelope).length === 0) return null;
  return encryptCredential(JSON.stringify(envelope));
}

function decryptCredentialEnvelope(payload) {
  if (!payload) return {};
  const decrypted = decryptCredential(payload);
  const parsed = JSON.parse(decrypted);
  return normalizeEnvelope(parsed);
}

function legacyCredentialsFromConnection(connection) {
  const credentials = {};
  if (connection?.accessToken) {
    const accessToken = decryptCredential(connection.accessToken);
    if (accessToken !== ENVELOPE_MARKER) credentials.accessToken = accessToken;
  }
  if (connection?.refreshToken) {
    credentials.refreshToken = decryptCredential(connection.refreshToken);
  }
  return credentials;
}

function resolveStoredCredentials(connection) {
  return {
    ...legacyCredentialsFromConnection(connection),
    ...decryptCredentialEnvelope(connection?.encryptedCredentials),
  };
}

function encryptedEnvelopeMarker() {
  return encryptCredential(ENVELOPE_MARKER);
}

module.exports = {
  ENVELOPE_MARKER,
  normalizeEnvelope,
  encryptCredentialEnvelope,
  decryptCredentialEnvelope,
  resolveStoredCredentials,
  encryptedEnvelopeMarker,
};
