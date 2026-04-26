const { z } = require("zod");

const createNotificationSchema = z.object({
  icon: z.enum(["alert", "xcircle", "settings", "check", "bell"]),
  title: z.string().min(1).max(255),
  subtitle: z.string().max(500).optional().default(""),
});

const notificationIdParamSchema = z.object({
  id: z.string().uuid("Invalid notification ID format"),
});

const validate =
  (schema, type = "body") =>
  (req, res, next) => {
    const data = type === "body" ? req.body : req.params;
    const result = schema.safeParse(data);

    if (!result.success) {
      const errors = result.error.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      }));
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors,
      });
    }

    if (type === "body") {
      req.body = result.data;
    } else {
      req.params = result.data;
    }

    next();
  };

module.exports = {
  createNotificationSchema,
  notificationIdParamSchema,
  validate,
};
