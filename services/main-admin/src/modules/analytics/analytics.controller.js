const analyticsService = require("./analytics.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const trackEvent = asyncHandler(async (req, res) => {
  const event = await analyticsService.trackEvent(req.body);
  return ApiResponse.success(res, 201, "Event tracked", { id: event.id });
});

const listEvents = asyncHandler(async (req, res) => {
  const { session_id, event_type, page, limit } = req.query;
  const data = await analyticsService.listEvents({
    session_id,
    event_type,
    page: page ? parseInt(page) : 1,
    limit: limit ? parseInt(limit) : 50,
  });
  return ApiResponse.success(res, 200, "Events retrieved", data);
});

const getStats = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const data = await analyticsService.getStats({ from, to });
  return ApiResponse.success(res, 200, "Analytics stats retrieved", data);
});

const getVisitors = asyncHandler(async (req, res) => {
  const { page, limit, country, user_type_intent, converted } = req.query;
  const data = await analyticsService.getVisitors({
    page: page ? parseInt(page) : 1,
    limit: limit ? parseInt(limit) : 50,
    country,
    user_type_intent,
    converted,
  });
  return ApiResponse.success(res, 200, "Visitor sessions retrieved", data);
});

const getWaitlist = asyncHandler(async (req, res) => {
  const { page, limit, role, country } = req.query;
  const data = await analyticsService.getWaitlist({
    page: page ? parseInt(page) : 1,
    limit: limit ? parseInt(limit) : 50,
    role,
    country,
  });
  return ApiResponse.success(res, 200, "Waitlist retrieved", data);
});

module.exports = { trackEvent, listEvents, getStats, getVisitors, getWaitlist };
