const asyncHandler = require("../../shared/utils/asyncHandler");
const ApiResponse = require("../../shared/utils/ApiResponse");
const auditService = require("./audit.service");

class AuditController {
  getMyActivityLogs = asyncHandler(async (req, res) => {
    const { page = 1, limit = 50 } = req.query;
    const result = await auditService.getMyActivityLogs(
      req.adminUser.id,
      parseInt(page),
      parseInt(limit),
    );
    return ApiResponse.success(
      res,
      200,
      "Activity logs retrieved successfully",
      result,
    );
  });

  getAllActivityLogs = asyncHandler(async (req, res) => {
    const { page = 1, limit = 50 } = req.query;
    const result = await auditService.getAllActivityLogs(
      req.adminUser.id,
      req.adminUser.tier,
      parseInt(page),
      parseInt(limit),
    );
    return ApiResponse.success(
      res,
      200,
      "All activity logs retrieved successfully",
      result,
    );
  });
}

module.exports = new AuditController();
