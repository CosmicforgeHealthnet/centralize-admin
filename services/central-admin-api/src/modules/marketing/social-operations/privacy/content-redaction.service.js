const { prisma } = require("../../../../shared/config/database");
const { hmacContent } = require("../security/content-hash.service");
const { encryptJson } = require("../security/encryption.service");
const { writeSocialAudit } = require("../security/social-audit.service");

const REDACTION_AUDIT_OPERATION = "SOCIAL_PRIVATE_CONTENT_REDACTED";
const WEBHOOK_TOMBSTONE_PURPOSE = "SOCIAL_WEBHOOK_PAYLOAD_TOMBSTONE";

function redactedAttachmentValue(value) {
  if (!value) return value;
  if (Array.isArray(value)) {
    return value.map(() => ({ redacted: true }));
  }
  if (typeof value === "object") {
    return { redacted: true };
  }
  return null;
}

async function safeRedactionAudit({
  entityType,
  entityId,
  actorId,
  auditWriter,
} = {}) {
  await writeSocialAudit({
    actorId,
    operation: REDACTION_AUDIT_OPERATION,
    targetId: entityId,
    targetType: entityType,
    metadata: { entityType, entityId },
    auditWriter,
  });
}

async function redactMessageContent({
  id,
  db = prisma,
  hashKey,
  now = () => new Date(),
  actorId,
  auditWriter,
} = {}) {
  const row = await db.socialMessage.findUnique({ where: { id } });
  if (!row || row.redactedAt) return { redacted: false, row };
  const updated = await db.socialMessage.update({
    where: { id },
    data: {
      contentHash: row.contentHash || (row.content ? hmacContent(row.content, { key: hashKey }) : row.contentHash),
      content: null,
      attachmentsJson: redactedAttachmentValue(row.attachmentsJson),
      sensitiveDataState: "REDACTED",
      redactedAt: now(),
    },
  });
  await safeRedactionAudit({
    entityType: "SOCIAL_MESSAGE",
    entityId: id,
    actorId,
    auditWriter,
  });
  return { redacted: true, row: updated };
}

async function redactCommentContent({
  id,
  db = prisma,
  hashKey,
  now = () => new Date(),
  actorId,
  auditWriter,
} = {}) {
  const row = await db.socialComment.findUnique({ where: { id } });
  if (!row || row.redactedAt) return { redacted: false, row };
  const updated = await db.socialComment.update({
    where: { id },
    data: {
      contentHash: row.contentHash || (row.text ? hmacContent(row.text, { key: hashKey }) : row.contentHash),
      text: null,
      sensitiveDataState: "REDACTED",
      redactedAt: now(),
    },
  });
  await safeRedactionAudit({
    entityType: "SOCIAL_COMMENT",
    entityId: id,
    actorId,
    auditWriter,
  });
  return { redacted: true, row: updated };
}

async function redactInternalNoteContent({
  id,
  db = prisma,
  hashKey,
  now = () => new Date(),
  actorId,
  auditWriter,
} = {}) {
  const row = await db.socialInternalNote.findUnique({ where: { id } });
  if (!row || row.redactedAt) return { redacted: false, row };
  const updated = await db.socialInternalNote.update({
    where: { id },
    data: {
      contentHash: row.contentHash || (row.text ? hmacContent(row.text, { key: hashKey }) : row.contentHash),
      text: null,
      sensitiveDataState: "REDACTED",
      redactedAt: now(),
    },
  });
  await safeRedactionAudit({
    entityType: "SOCIAL_INTERNAL_NOTE",
    entityId: id,
    actorId,
    auditWriter,
  });
  return { redacted: true, row: updated };
}

async function redactWebhookPayload({
  id,
  db = prisma,
  keyring,
  now = () => new Date(),
  actorId,
  auditWriter,
} = {}) {
  const row = await db.socialWebhookEvent.findUnique({ where: { id } });
  if (!row || row.redactedAt) return { redacted: false, row };
  const tombstone = encryptJson(
    {
      redacted: true,
      redactedAt: now().toISOString(),
      payloadHash: row.payloadHash,
    },
    { purpose: WEBHOOK_TOMBSTONE_PURPOSE, keyring },
  );
  const updated = await db.socialWebhookEvent.update({
    where: { id },
    data: {
      encryptedRawPayload: tombstone,
      redactedAt: now(),
    },
  });
  await safeRedactionAudit({
    entityType: "SOCIAL_WEBHOOK_EVENT",
    entityId: id,
    actorId,
    auditWriter,
  });
  return { redacted: true, row: updated };
}

module.exports = {
  REDACTION_AUDIT_OPERATION,
  WEBHOOK_TOMBSTONE_PURPOSE,
  redactMessageContent,
  redactCommentContent,
  redactInternalNoteContent,
  redactWebhookPayload,
};
