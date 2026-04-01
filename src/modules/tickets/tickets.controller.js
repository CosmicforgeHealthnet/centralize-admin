const ticketsService = require("./tickets.service");
const { createAuditLog } = require("../../shared/middlewares/audit.middleware");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");
const ApiError = require("../../shared/utils/ApiError");

// ── Tickets ──────────────────────────────────────────

const getAllTickets = asyncHandler(async (req, res) => {
  const { status, issueType, priority, assignedTo } = req.query;
  const result = await ticketsService.getAllTickets({
    status,
    issueType,
    priority,
    assignedTo,
  });
  return ApiResponse.success(res, 200, "Tickets retrieved", result);
});

const getTicketById = asyncHandler(async (req, res) => {
  const result = await ticketsService.getTicketById(req.params.id);
  return ApiResponse.success(res, 200, "Ticket retrieved", result);
});

const updateTicket = asyncHandler(async (req, res) => {
  const result = await ticketsService.updateTicket(req.params.id, req.body);

  await createAuditLog({
    adminUserId: req.adminUser.id,
    action: "TICKET_UPDATED",
    targetId: req.params.id,
    targetType: "ticket",
    metadata: { changes: req.body },
    req,
  });

  return ApiResponse.success(res, 200, "Ticket updated", result);
});

const assignTicket = asyncHandler(async (req, res) => {
  const { assignedTo } = req.body;
  if (!assignedTo) throw new ApiError(400, "assignedTo is required");

  const result = await ticketsService.assignTicket(req.params.id, assignedTo);

  await createAuditLog({
    adminUserId: req.adminUser.id,
    action: "TICKET_ASSIGNED",
    targetId: req.params.id,
    targetType: "ticket",
    metadata: { assignedTo },
    req,
  });

  return ApiResponse.success(res, 200, "Ticket assigned", result);
});

const resolveTicket = asyncHandler(async (req, res) => {
  const { resolutionNotes } = req.body;
  const result = await ticketsService.resolveTicket(
    req.params.id,
    resolutionNotes,
  );

  await createAuditLog({
    adminUserId: req.adminUser.id,
    action: "TICKET_RESOLVED",
    targetId: req.params.id,
    targetType: "ticket",
    metadata: { resolutionNotes },
    req,
  });

  return ApiResponse.success(res, 200, "Ticket resolved", result);
});

// ── Disputes ─────────────────────────────────────────

const getAllDisputes = asyncHandler(async (req, res) => {
  const { status, disputeType } = req.query;
  const result = await ticketsService.getAllDisputes({ status, disputeType });
  return ApiResponse.success(res, 200, "Disputes retrieved", result);
});

const getDisputeById = asyncHandler(async (req, res) => {
  const result = await ticketsService.getDisputeById(req.params.id);
  return ApiResponse.success(res, 200, "Dispute retrieved", result);
});

const updateDispute = asyncHandler(async (req, res) => {
  const result = await ticketsService.updateDispute(req.params.id, req.body);
  return ApiResponse.success(res, 200, "Dispute updated", result);
});

module.exports = {
  getAllTickets,
  getTicketById,
  updateTicket,
  assignTicket,
  resolveTicket,
  getAllDisputes,
  getDisputeById,
  updateDispute,
};
