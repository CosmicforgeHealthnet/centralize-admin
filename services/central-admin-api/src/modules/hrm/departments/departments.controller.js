const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const departmentsService = require("./departments.service");

const getDepartments = asyncHandler(async (req, res) => {
  const data = await departmentsService.getDepartments();
  return ApiResponse.success(res, 200, "HRM departments retrieved", data);
});

const getDepartmentEmployees = asyncHandler(async (req, res) => {
  const data = await departmentsService.getDepartmentEmployees({
    dept: req.directoryScope?.department || req.params.dept,
    query: req.query,
    scope: req.directoryScope || null,
  });
  return ApiResponse.success(res, 200, "HRM department employees retrieved", data);
});

module.exports = {
  getDepartmentEmployees,
  getDepartments,
};
