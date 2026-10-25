"use strict";

// Append-only Mail audit trail (mail_audit_events is protected by a database
// trigger against UPDATE/DELETE). Metadata must never contain message bodies,
// attachment content, tokens or secrets.

const FORBIDDEN_KEYS = /(body|html|text|content|secret|token|password|code|apikey|api_key)/i;

function scrub(value, depth = 0) {
  if (value == null || depth > 4) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => scrub(entry, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.test(key)) continue;
      output[key] = scrub(entry, depth + 1);
    }
    return output;
  }
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "bigint") return value.toString();
  return value;
}

function createMailAudit({ client }) {
  async function record(event, context = {}, tx = client) {
    return tx.mailAuditEvent.create({
      data: {
        actorAdminUserId: event.actorAdminUserId || null,
        action: String(event.action).slice(0, 80),
        targetType: String(event.targetType || "unknown").slice(0, 64),
        targetId: event.targetId ? String(event.targetId).slice(0, 128) : null,
        mailboxId: event.mailboxId || null,
        organizationId: event.organizationId || null,
        outcome: event.outcome || "SUCCESS",
        metadata: scrub(event.metadata || null),
        requestId: context.requestId ? String(context.requestId).slice(0, 128) : null,
        ipAddress: context.ipAddress ? String(context.ipAddress).slice(0, 64) : null,
      },
    });
  }

  async function list({ mailboxId, targetType, targetId, limit = 50 }) {
    return client.mailAuditEvent.findMany({
      where: { ...(mailboxId ? { mailboxId } : {}), ...(targetType ? { targetType } : {}), ...(targetId ? { targetId } : {}) },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(Number(limit) || 50, 1), 200),
    });
  }

  return { record, list, scrub };
}

module.exports = { createMailAudit, scrub };
