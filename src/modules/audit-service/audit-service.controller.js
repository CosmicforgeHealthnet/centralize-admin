const auditService = require("./audit-service.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const getAuditLogs = asyncHandler(async (req, res) => {
  const { resourceType, resourceId, action, page, limit } = req.query;
  const data = await auditService.getAuditLogs({
    resourceType,
    resourceId,
    action,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Audit logs retrieved", data);
});

const getAuditStats = asyncHandler(async (req, res) => {
  const data = await auditService.getAuditStats();
  return ApiResponse.success(res, 200, "Audit stats retrieved", data);
});

module.exports = { getAuditLogs, getAuditStats };
