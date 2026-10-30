const dispatchService = require("./dispatch.service");
const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");

const listProviders = asyncHandler(async (req, res) => {
  const { status, page, limit } = req.query;
  const data = await dispatchService.listProviders({
    status,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Providers retrieved", data);
});

const getProvider = asyncHandler(async (req, res) => {
  const data = await dispatchService.getProvider(req.params.id);
  return ApiResponse.success(res, 200, "Provider retrieved", data);
});

const approveVerificationStep = asyncHandler(async (req, res) => {
  const { step, notes } = req.body;
  await dispatchService.approveVerificationStep(
    req.params.id,
    step,
    req.adminUser.id,
    notes,
  );
  return ApiResponse.success(res, 200, "Verification step approved");
});

const rejectVerificationStep = asyncHandler(async (req, res) => {
  const { step, reason } = req.body;
  await dispatchService.rejectVerificationStep(
    req.params.id,
    step,
    req.adminUser.id,
    reason,
  );
  return ApiResponse.success(res, 200, "Verification step rejected");
});

const suspendProvider = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  await dispatchService.suspendProvider(
    req.params.id,
    req.adminUser.id,
    reason,
  );
  return ApiResponse.success(res, 200, "Provider suspended");
});

const unsuspendProvider = asyncHandler(async (req, res) => {
  await dispatchService.unsuspendProvider(req.params.id, req.adminUser.id);
  return ApiResponse.success(res, 200, "Provider unsuspended");
});

const listTrips = asyncHandler(async (req, res) => {
  const { status, providerId, page, limit } = req.query;
  const data = await dispatchService.listTrips({
    status,
    providerId,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Trips retrieved", data);
});

const getTrip = asyncHandler(async (req, res) => {
  const data = await dispatchService.getTrip(req.params.id);
  return ApiResponse.success(res, 200, "Trip retrieved", data);
});

const listBikes = asyncHandler(async (req, res) => {
  const { status, providerId, page, limit } = req.query;
  const data = await dispatchService.listBikes({
    status,
    providerId,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Bikes retrieved", data);
});

const getBike = asyncHandler(async (req, res) => {
  const data = await dispatchService.getBike(req.params.id);
  return ApiResponse.success(res, 200, "Bike retrieved", data);
});

const approveBike = asyncHandler(async (req, res) => {
  await dispatchService.approveBike(req.params.id, req.adminUser.id);
  return ApiResponse.success(res, 200, "Bike approved");
});

const rejectBike = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  await dispatchService.rejectBike(req.params.id, req.adminUser.id, reason);
  return ApiResponse.success(res, 200, "Bike rejected");
});

module.exports = {
  listProviders,
  getProvider,
  approveVerificationStep,
  rejectVerificationStep,
  suspendProvider,
  unsuspendProvider,
  listTrips,
  getTrip,
  listBikes,
  getBike,
  approveBike,
  rejectBike,
};
