const { mainPrisma } = require("../../shared/config/mainDatabase");
const ApiError = require("../../shared/utils/ApiError");
const logger = require("../../shared/utils/logger");

class AdminSettingsService {
  /**
   * Get a single setting by category and key
   */
  async getSetting(category, key) {
    try {
      const setting = await mainPrisma.admin_settings.findUnique({
        where: {
          category_key: {
            category,
            key,
          },
        },
      });

      if (!setting) {
        return null;
      }

      return setting;
    } catch (err) {
      logger.error(
        `[AdminSettings] getSetting error for ${category}.${key}:`,
        err.message,
      );
      throw err;
    }
  }

  /**
   * Get all settings in a category
   */
  async getSettingsByCategory(category) {
    try {
      const settings = await mainPrisma.admin_settings.findMany({
        where: { category },
        orderBy: { key: "asc" },
      });

      return settings;
    } catch (err) {
      logger.error(
        `[AdminSettings] getSettingsByCategory error for ${category}:`,
        err.message,
      );
      throw err;
    }
  }

  /**
   * Get all settings (for admin panel)
   */
  async getAllSettings() {
    try {
      const settings = await mainPrisma.admin_settings.findMany({
        orderBy: [{ category: "asc" }, { key: "asc" }],
      });

      // Group by category
      const grouped = {};
      for (const setting of settings) {
        if (!grouped[setting.category]) {
          grouped[setting.category] = [];
        }
        grouped[setting.category].push(setting);
      }

      return grouped;
    } catch (err) {
      logger.error("[AdminSettings] getAllSettings error:", err.message);
      throw err;
    }
  }

  /**
   * Create or update a setting
   */
  async upsertSetting(category, key, value, updatedBy) {
    try {
      // Get old value for history
      const oldSetting = await mainPrisma.admin_settings.findUnique({
        where: {
          category_key: {
            category,
            key,
          },
        },
      });

      const oldValue = oldSetting?.value || null;

      // Upsert the setting
      const result = await mainPrisma.admin_settings.upsert({
        where: {
          category_key: {
            category,
            key,
          },
        },
        update: {
          value,
          updatedBy,
          updatedAt: new Date(),
        },
        create: {
          category,
          key,
          value,
          updatedBy,
        },
      });

      // Create history entry
      await mainPrisma.admin_settings_history.create({
        data: {
          settingId: result.id,
          category,
          key,
          oldValue,
          newValue: value,
          changedBy: updatedBy,
          changedAt: new Date(),
        },
      });

      logger.info(
        `[AdminSettings] Setting updated: ${category}.${key} by ${updatedBy}`,
      );
      return result;
    } catch (err) {
      // LOG THE FULL ERROR
      console.error("=== FULL ERROR ===");
      console.error("Error message:", err.message);
      console.error("Error code:", err.code);
      console.error("Error meta:", err.meta);
      console.error("Full error object:", JSON.stringify(err, null, 2));

      logger.error(
        `[AdminSettings] upsertSetting error for ${category}.${key}:`,
        err.message,
      );
      logger.error(`[AdminSettings] Error details:`, {
        code: err.code,
        meta: err.meta,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Update multiple settings at once
   */
  async batchUpdateSettings(updates, updatedBy) {
    const errors = [];
    const validUpdates = [];

    for (const update of updates) {
      const { category, key, value } = update;
      if (category && key && value !== undefined) {
        validUpdates.push({ category, key, value });
      } else {
        errors.push({
          category: update.category,
          key: update.key,
          error: "Missing fields",
        });
      }
    }

    if (errors.length > 0) {
      throw new ApiError(400, "Some settings failed to update", { errors });
    }

    const now = new Date();

    // Fetch all existing in ONE query
    const existingSettings = await mainPrisma.admin_settings.findMany({
      where: {
        OR: validUpdates.map(({ category, key }) => ({ category, key })),
      },
    });

    const existingMap = {};
    for (const s of existingSettings) {
      existingMap[`${s.category}.${s.key}`] = s;
    }

    // Only keep settings that actually changed
    const changedUpdates = validUpdates.filter(({ category, key, value }) => {
      const existing = existingMap[`${category}.${key}`];
      if (!existing) return true;

      const existingStr =
        typeof existing.value === "object"
          ? JSON.stringify(existing.value)
          : String(existing.value);

      const newStr =
        typeof value === "object" ? JSON.stringify(value) : String(value);

      return existingStr !== newStr;
    });

    // Nothing changed, skip all writes
    if (changedUpdates.length === 0) {
      logger.info(`[AdminSettings] No changes detected, skipping update`);
      return [];
    }

    logger.info(
      `[AdminSettings] ${validUpdates.length} submitted, ${changedUpdates.length} actually changed`,
    );

    const results = await mainPrisma.$transaction(
      changedUpdates.map(({ category, key, value }) =>
        mainPrisma.admin_settings.upsert({
          where: { category_key: { category, key } },
          update: { value, updatedBy, updatedAt: now },
          create: { category, key, value, updatedBy },
        }),
      ),
    );

    await mainPrisma.admin_settings_history.createMany({
      data: results.map((result) => ({
        settingId: result.id,
        category: result.category,
        key: result.key,
        oldValue:
          existingMap[`${result.category}.${result.key}`]?.value ?? null,
        newValue: result.value,
        changedBy: updatedBy,
        changedAt: now,
      })),
    });

    logger.info(
      `[AdminSettings] Batch updated ${results.length} settings by ${updatedBy}`,
    );
    return results;
  }

  /**
   * Get history for a specific setting
   */
  async getSettingHistory(settingId, { page = 1, limit = 20 }) {
    try {
      const skip = (page - 1) * limit;

      const [data, total] = await Promise.all([
        mainPrisma.admin_settings_history.findMany({
          where: { settingId },
          orderBy: { changedAt: "desc" },
          skip,
          take: limit,
        }),
        mainPrisma.admin_settings_history.count({ where: { settingId } }),
      ]);

      return { data, total, page, limit };
    } catch (err) {
      logger.error(
        `[AdminSettings] getSettingHistory error for ${settingId}:`,
        err.message,
      );
      throw err;
    }
  }

  /**
   * Get all history (audit trail) with filters
   */
  async getAllHistory({ category, key, changedBy, page = 1, limit = 50 } = {}) {
    try {
      const where = {};
      if (category) where.category = category;
      if (key) where.key = key;
      if (changedBy) where.changedBy = changedBy;

      const skip = (page - 1) * limit;

      const [data, total] = await Promise.all([
        mainPrisma.admin_settings_history.findMany({
          where,
          orderBy: { changedAt: "desc" },
          skip,
          take: limit,
        }),
        mainPrisma.admin_settings_history.count({ where }),
      ]);

      return { data, total, page, limit };
    } catch (err) {
      logger.error("[AdminSettings] getAllHistory error:", err.message);
      throw err;
    }
  }
}

module.exports = new AdminSettingsService();
