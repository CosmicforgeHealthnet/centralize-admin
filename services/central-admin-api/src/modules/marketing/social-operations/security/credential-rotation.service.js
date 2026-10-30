const { prisma } = require("../../../../shared/config/database");
const {
  decryptJson,
  encryptJson,
  envelopeMetadata,
} = require("./encryption.service");
const { writeSocialAudit } = require("./social-audit.service");

const CREDENTIAL_PURPOSE = "SOCIAL_ACCOUNT_CONNECTION_CREDENTIALS";

async function rotateSocialConnectionCredentials({
  connectionId,
  db = prisma,
  keyring,
  actorId,
  auditWriter,
} = {}) {
  const connection = await db.socialAccountConnection.findUnique({
    where: { id: connectionId },
  });
  if (!connection) throw new Error("Social connection not found");

  const credentials = decryptJson(connection.encryptedCredentials, {
    purpose: CREDENTIAL_PURPOSE,
    keyring,
  });
  const encryptedCredentials = encryptJson(credentials, {
    purpose: CREDENTIAL_PURPOSE,
    keyring,
  });
  const metadata = envelopeMetadata(encryptedCredentials);

  const updated = await db.socialAccountConnection.update({
    where: { id: connection.id },
    data: {
      encryptedCredentials,
      credentialVersion: { increment: 1 },
    },
  });

  await writeSocialAudit({
    actorId,
    operation: "SOCIAL_CREDENTIAL_ROTATED",
    targetId: connection.id,
    targetType: "SOCIAL_ACCOUNT_CONNECTION",
    metadata: {
      provider: connection.provider,
      keyVersion: metadata.keyVersion,
      credentialVersion: updated.credentialVersion,
    },
    auditWriter,
  });

  return {
    id: updated.id,
    provider: updated.provider,
    credentialVersion: updated.credentialVersion,
    keyVersion: metadata.keyVersion,
  };
}

module.exports = {
  CREDENTIAL_PURPOSE,
  rotateSocialConnectionCredentials,
};
