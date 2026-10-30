const adminSettingsService = require("./admin-settings.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");
const ApiError = require("../../shared/utils/ApiError");

/**
 * Get all settings (grouped by category)
 */
const getAllSettings = asyncHandler(async (req, res) => {
  const data = await adminSettingsService.getAllSettings();
  return ApiResponse.success(res, 200, "Settings retrieved successfully", data);
});

/**
 * Get settings by category
 */
const getSettingsByCategory = asyncHandler(async (req, res) => {
  const { category } = req.params;
  const data = await adminSettingsService.getSettingsByCategory(category);
  return ApiResponse.success(
    res,
    200,
    `${category} settings retrieved successfully`,
    data,
  );
});

/**
 * Get a single setting
 */
const getSetting = asyncHandler(async (req, res) => {
  const { category, key } = req.params;
  const data = await adminSettingsService.getSetting(category, key);

  if (!data) {
    throw new ApiError(404, `Setting ${category}.${key} not found`);
  }

  return ApiResponse.success(res, 200, "Setting retrieved successfully", data);
});

/**
 * Create or update a single setting
 */
const upsertSetting = asyncHandler(async (req, res) => {
  const { category, key } = req.params;
  const { value } = req.body;

  // Get the main app user ID from the admin user record
  const mainAppUserId = req.adminUser?.mainAppUserId;

  if (!mainAppUserId) {
    throw new ApiError(401, "Admin user not linked to main app user");
  }

  if (value === undefined) {
    throw new ApiError(400, "Value is required");
  }

  const data = await adminSettingsService.upsertSetting(
    category,
    key,
    value,
    mainAppUserId,
  );
  return ApiResponse.success(res, 200, "Setting saved successfully", data);
});

/**
 * Update multiple settings at once
 */
const batchUpdateSettings = asyncHandler(async (req, res) => {
  const { updates } = req.body;

  // DEBUG: Log the value
  console.log("=== DEBUG batchUpdateSettings ===");
  console.log("req.adminUser:", req.adminUser);
  console.log("req.adminUser?.mainAppUserId:", req.adminUser?.mainAppUserId);
  console.log("req.adminUser?.id:", req.adminUser?.id);

  const mainAppUserId = req.adminUser?.mainAppUserId;

  console.log("mainAppUserId to use:", mainAppUserId);
  console.log("Type of mainAppUserId:", typeof mainAppUserId);
  console.log(
    "Is valid UUID?",
    mainAppUserId?.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    ),
  );

  if (!mainAppUserId) {
    throw new ApiError(
      401,
      `Admin user not linked to main app user. Admin user ID: ${req.adminUser?.id}, Has mainAppUserId: ${!!req.adminUser?.mainAppUserId}`,
    );
  }

  if (!updates || !Array.isArray(updates) || updates.length === 0) {
    throw new ApiError(400, "Updates array is required");
  }

  const data = await adminSettingsService.batchUpdateSettings(
    updates,
    mainAppUserId,
  );
  return ApiResponse.success(
    res,
    200,
    `${data.length} settings saved successfully`,
    data,
  );
});

/**
 * Get history for a specific setting
 */
const getSettingHistory = asyncHandler(async (req, res) => {
  const { settingId } = req.params;
  const { page, limit } = req.query;

  const data = await adminSettingsService.getSettingHistory(settingId, {
    page: page ? parseInt(page) : 1,
    limit: limit ? parseInt(limit) : 20,
  });

  return ApiResponse.success(
    res,
    200,
    "Setting history retrieved successfully",
    data,
  );
});

/**
 * Get all history (audit trail)
 */
const getAllHistory = asyncHandler(async (req, res) => {
  const { category, key, changedBy, page, limit } = req.query;

  const data = await adminSettingsService.getAllHistory({
    category,
    key,
    changedBy,
    page: page ? parseInt(page) : 1,
    limit: limit ? parseInt(limit) : 50,
  });

  return ApiResponse.success(
    res,
    200,
    "Audit history retrieved successfully",
    data,
  );
});

module.exports = {
  getAllSettings,
  getSettingsByCategory,
  getSetting,
  upsertSetting,
  batchUpdateSettings,
  getSettingHistory,
  getAllHistory,
};
