"use strict";

// Access to the Marketing workspace API (/api/marketing, not Intelligence or
// Email Marketing, which keep their own checks).
//
// - Admin tier and above: unchanged (full access, as before).
// - Everyone else needs effective marketing access (department defaults or an
//   explicit grant): "workspace" VIEW to read, EDIT to create/update, and
//   "workspace-manage" EDIT to delete, change status or manage social
//   accounts (Marketing Team Leads and Managers by default).
// - Customer search and automated notification/recipient settings stay
//   Admin-tier only: they expose customer data or switch on sending.

const ApiError = require("../../shared/utils/ApiError");
const asyncHandler = require("../../shared/utils/asyncHandler");
const { hasSectionAccess } = require("../../shared/middlewares/rbac.middleware");

const ADMIN_TIERS = new Set(["ADMIN", "EXECUTIVE", "SUPER"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ADMIN_ONLY = [/^\/email-templates\/customers\/search\/?$/, /^\/email-templates\/[^/]+\/(notification|recipients)\/?$/];

function requiredAccess(method, path) {
  if (ADMIN_ONLY.some((pattern) => pattern.test(path))) return null;
  const read = READ_METHODS.has(method);
  const manage = method === "DELETE" || /\/status\/?$/.test(path) || (!read && /^\/social\/accounts(\/|$)/.test(path));
  if (manage) return { section: "workspace-manage", mode: "EDIT" };
  return { section: "workspace", mode: read ? "VIEW" : "EDIT" };
}

function createMarketingWorkspaceGuard({ hasAccess = hasSectionAccess } = {}) {
  return asyncHandler(async (req, _res, next) => {
    const user = req.adminUser;
    if (!user?.tier) throw new ApiError(401, "Unauthorized");
    if (ADMIN_TIERS.has(user.tier)) return next();
    const need = requiredAccess(req.method, req.path);
    if (!need || !(await hasAccess(user, "marketing", need.section, need.mode))) {
      throw new ApiError(403, "You do not have permission to perform this action");
    }
    return next();
  });
}

module.exports = { createMarketingWorkspaceGuard, requiredAccess };
