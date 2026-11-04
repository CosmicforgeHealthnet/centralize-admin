"use strict";

// Who may list a department's employees.
// - HR (Admin tier + hrm/departments VIEW, or Super): any department, as before.
// - Every active employee: their own department only ("mine" or its name),
//   basic work information of active colleagues. Team Leads and Managers
//   also see inactive/pending members and each member's role (roster).
// - Anything else, including another department: 403.

const ApiError = require("../../../shared/utils/ApiError");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const { hasSectionAccess } = require("../../../shared/middlewares/rbac.middleware");

const HR_TIERS = new Set(["ADMIN", "EXECUTIVE", "SUPER"]);

function createDepartmentDirectoryAccess({ hasAccess = hasSectionAccess } = {}) {
  return asyncHandler(async (req, _res, next) => {
    const user = req.adminUser;
    if (!user) throw new ApiError(401, "Unauthorized");
    const requested = String(req.params.dept || "").trim();
    const own = requested.toLowerCase() === "mine" ? user.department : null;

    if (!own && (user.tier === "SUPER" || (HR_TIERS.has(user.tier) && (await hasAccess(user, "hrm", "departments", "VIEW"))))) {
      req.directoryScope = null; // full HR view
      return next();
    }

    const department = own || requested.toUpperCase().replace(/[\s-]+/g, "_");
    if (!user.department || department !== user.department || !(await hasAccess(user, "department", "directory", "VIEW"))) {
      throw new ApiError(403, "You can only view colleagues in your own department");
    }
    req.directoryScope = { department, roster: await hasAccess(user, "department", "roster", "VIEW") };
    return next();
  });
}

// Department Managers: read-only leave requests of their own department.
function createDepartmentLeavesAccess({ hasAccess = hasSectionAccess } = {}) {
  return asyncHandler(async (req, _res, next) => {
    const user = req.adminUser;
    if (!user) throw new ApiError(401, "Unauthorized");
    if (!user.department || !(await hasAccess(user, "department", "leaves", "VIEW"))) {
      throw new ApiError(403, "Only Department Managers can view their department's leave requests");
    }
    req.directoryScope = { department: user.department };
    return next();
  });
}

module.exports = { createDepartmentDirectoryAccess, createDepartmentLeavesAccess };
