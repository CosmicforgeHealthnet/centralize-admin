const { prisma } = require("../../../../shared/config/database");
const { createAuditLog } = require("../../../../shared/middlewares/audit.middleware");
const { sanitizeSecretSafe } = require("./secret-safe-serializer");

async function writeSocialAudit({
  adminUserId,
  actorId,
  operation,
  targetId,
  targetType,
  metadata = {},
  req,
  auditWriter = createAuditLog,
} = {}) {
  return auditWriter({
    adminUserId: adminUserId || actorId || null,
    action: "PROFILE_UPDATED",
    targetId: targetId || null,
    targetType: targetType || "SOCIAL_OPERATIONS",
    metadata: sanitizeSecretSafe({
      operation,
      ...metadata,
      auditedAt: new Date().toISOString(),
    }),
    req,
  });
}

async function assertNoMutableSocialAuditUsage({ sourceRoot, fsModule } = {}) {
  const fs = fsModule || require("fs");
  const path = require("path");
  const root =
    sourceRoot ||
    path.resolve(__dirname, "..");
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith(".js")) {
        const source = fs.readFileSync(full, "utf8");
        if (/auditLog\.(update|updateMany|delete|deleteMany|upsert)\s*\(/.test(source)) {
          throw new Error(`Mutable audit operation found in ${full}`);
        }
      }
    }
  }
  return true;
}

module.exports = {
  prisma,
  writeSocialAudit,
  assertNoMutableSocialAuditUsage,
};
