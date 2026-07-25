const ApiError = require("../../../shared/utils/ApiError");
const { assertUuid } = require("./validation-security");

async function requireActiveActor(client, actor, { minimumTier } = {}) {
  if (!actor?.id) throw new ApiError(401, "Actor context is required", [{ code: "FORBIDDEN" }]);
  assertUuid(actor.id, "adminUserId");
  if (!client.adminUser?.findUnique) return actor;
  const admin = await client.adminUser.findUnique({ where: { id: actor.id } });
  if (!admin || admin.status !== "ACTIVE") throw new ApiError(403, "Active actor is required", [{ code: "FORBIDDEN" }]);
  if (minimumTier) {
    const rank = { EMPLOYEE: 1, ADMIN: 2, EXECUTIVE: 3, SUPER: 4 };
    if ((rank[admin.tier] || 0) < rank[minimumTier]) throw new ApiError(403, "Elevated administrative role is required", [{ code: "FORBIDDEN" }]);
  }
  return admin;
}

async function requireOperationActor(client, { trigger, requestedByAdminUserId } = {}) {
  if (String(trigger || "").trim().toLowerCase() !== "manual-api") return null;
  return requireActiveActor(client, { id: requestedByAdminUserId });
}

module.exports = { requireActiveActor, requireOperationActor };
