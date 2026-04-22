const supportService = require("./support.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const getStats = asyncHandler(async (req, res) => {
  const data = await supportService.getStats();
  return ApiResponse.success(res, 200, "Support stats retrieved", data);
});

const getMergedTickets = asyncHandler(async (req, res) => {
  const { category, status, page, limit } = req.query;
  const data = await supportService.getMergedTickets({
    category,
    status,
    page,
    limit,
  });
  return ApiResponse.success(res, 200, "Tickets retrieved", data);
});

// const getStaffActivity = asyncHandler(async (req, res) => {
//   const data = await supportService.getStaffActivity();
//   return ApiResponse.success(res, 200, "Staff activity retrieved", data);
// });

const getUserTraffic = asyncHandler(async (req, res) => {
  const data = await supportService.getUserTraffic();
  return ApiResponse.success(res, 200, "User traffic retrieved", data);
});

const getSupportChats = asyncHandler(async (req, res) => {
  const data = await supportService.getSupportChats();
  return ApiResponse.success(res, 200, "Support chats retrieved", data);
});

const getChatMessages = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const data = await supportService.getChatMessages(roomId);
  return ApiResponse.success(res, 200, "Messages retrieved", data);
});

// claimChat
const claimChat = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const data = await supportService.claimChat(roomId, req.adminUser); // ✅
  return ApiResponse.success(res, 200, data.message, data);
});

// sendChatMessage
const sendChatMessage = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const { content } = req.body;
  if (!content || !content.trim()) {
    return ApiResponse.error(res, 400, "Message content is required");
  }
  const data = await supportService.sendChatMessage(
    roomId,
    req.adminUser, // ✅
    content.trim(),
  );
  return ApiResponse.success(res, 201, "Message sent", data);
});

// Add to module.exports:
module.exports = {
  getStats,
  getMergedTickets,
  getUserTraffic,
  getSupportChats,
  getChatMessages,
  claimChat,
  sendChatMessage,
};


