const rtcService = require("./rtc.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const getSession = asyncHandler(async (req, res) => {
  const data = await rtcService.getSession(req.params.id);
  return ApiResponse.success(res, 200, "Session retrieved", data);
});

const listSessions = asyncHandler(async (req, res) => {
  const { status, page, limit } = req.query;
  const data = await rtcService.listSessions({
    status,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Sessions retrieved", data);
});

const transitionSession = asyncHandler(async (req, res) => {
  const data = await rtcService.transitionSession(
    req.params.id,
    req.body.status,
  );
  return ApiResponse.success(res, 200, "Session updated", data);
});

const getSessionStats = asyncHandler(async (req, res) => {
  const data = await rtcService.getSessionStats();
  return ApiResponse.success(res, 200, "Session stats retrieved", data);
});

module.exports = {
  getSession,
  listSessions,
  transitionSession,
  getSessionStats,
};
