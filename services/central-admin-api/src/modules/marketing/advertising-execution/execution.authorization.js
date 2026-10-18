const { prisma } = require("../../../shared/config/database");
const { executionError } = require("./execution.errors");
const asyncHandler = require("../../../shared/utils/asyncHandler");

const ROLE_SECTIONS = Object.freeze({
  AUTHOR: "advertising-execution:author",
  APPROVER: "advertising-execution:approver",
  EXECUTION_ADMIN: "advertising-execution:execution-admin",
  EMERGENCY_OPERATOR: "advertising-execution:emergency-operator",
});

async function hasExecutionRole(actor, role, client = prisma) {
  if (!actor?.id) return false;
  if (actor.tier === "SUPER") return true;
  const section = ROLE_SECTIONS[role];
  if (!section) return false;
  const row = await client.adminSectionGrant.findFirst({ where: { adminUserId: actor.id, module: "marketing", section: { in: [section, "advertising-execution:*"] }, mode: "EDIT", revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { id: true } });
  return Boolean(row);
}

function requireExecutionRole(role, { client = prisma } = {}) {
  return asyncHandler(async (req, _res, next) => {
    if (!await hasExecutionRole(req.adminUser, role, client)) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: `${role}_ROLE_REQUIRED` });
    req.executionRole = role;
    next();
  });
}

module.exports = { ROLE_SECTIONS, hasExecutionRole, requireExecutionRole };
