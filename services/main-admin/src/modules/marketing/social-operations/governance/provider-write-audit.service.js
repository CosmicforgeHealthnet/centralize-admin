const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /authorization/i,
  /credential/i,
  /secret/i,
  /password/i,
  /rawBody/i,
  /rawPayload/i,
];

const PRIVATE_CONTENT_KEYS = new Set([
  "text",
  "message",
  "comment",
  "body",
  "content",
  "rawText",
]);

function sanitizeAuditMetadata(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditMetadata(item));
  if (!value || typeof value !== "object") return value;

  const sanitized = {};
  for (const [key, nested] of Object.entries(value)) {
    if (
      SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key)) ||
      PRIVATE_CONTENT_KEYS.has(key)
    ) {
      sanitized[key] = "[REDACTED]";
      continue;
    }
    sanitized[key] = sanitizeAuditMetadata(nested);
  }
  return sanitized;
}

async function defaultAuditWriter(event) {
  const { createAuditLog } = require("../../../../shared/middlewares/audit.middleware");
  await createAuditLog({
    adminUserId: event.adminUserId,
    action: event.auditAction || "EMERGENCY_OVERRIDE_USED",
    targetId: event.targetId,
    targetType: event.targetType || "SOCIAL_PROVIDER_WRITE",
    metadata: event.metadata,
    req: event.req,
  });
}

async function recordProviderWriteAudit({ auditWriter = defaultAuditWriter, ...event }) {
  await auditWriter({
    ...event,
    metadata: sanitizeAuditMetadata(event.metadata || {}),
  });
}

async function withProviderWriteAudit({
  auditWriter = defaultAuditWriter,
  adminUserId,
  operation,
  platform,
  targetId,
  targetType,
  metadata,
  providerCallback,
  req,
}) {
  await recordProviderWriteAudit({
    auditWriter,
    adminUserId,
    targetId,
    targetType,
    req,
    metadata: {
      ...metadata,
      phase: "INTENT",
      operation,
      platform,
    },
  });

  try {
    const result = await providerCallback();
    await recordProviderWriteAudit({
      auditWriter,
      adminUserId,
      targetId,
      targetType,
      req,
      metadata: {
        ...metadata,
        phase: "SUCCESS",
        operation,
        platform,
      },
    });
    return result;
  } catch (error) {
    await recordProviderWriteAudit({
      auditWriter,
      adminUserId,
      targetId,
      targetType,
      req,
      metadata: {
        ...metadata,
        phase: "FAILURE",
        operation,
        platform,
        errorName: error?.name || "Error",
      },
    });
    throw error;
  }
}

module.exports = {
  sanitizeAuditMetadata,
  recordProviderWriteAudit,
  withProviderWriteAudit,
};
