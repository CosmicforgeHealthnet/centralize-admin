const { z } = require("zod");

const createUserSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  position: z.string().optional(),
  department: z
    .enum([
      "FINANCE",
      "DEVELOPMENT",
      "CUSTOMER_CARE",
      "MARKETING",
      "SOCIAL_MEDIA",
      "EXECUTIVE",
      "MANAGEMENT",
    ])
    .optional(),
  tier: z.enum(["SUPER", "EXECUTIVE", "ADMIN", "EMPLOYEE"]).default("EMPLOYEE"),
  isTeamLead: z.boolean().default(false),
  password: z
    .string()
    .min(8)
    .regex(/[A-Z]/, "Must contain uppercase")
    .regex(/[a-z]/, "Must contain lowercase")
    .regex(/[0-9]/, "Must contain number")
    .regex(
      /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/,
      "Must contain special character",
    ),
});

const updateUserSchema = z
  .object({
    name: z.string().min(2).optional(),
    position: z.string().optional(),
    department: z
      .enum([
        "FINANCE",
        "DEVELOPMENT",
        "CUSTOMER_CARE",
        "MARKETING",
        "SOCIAL_MEDIA",
        "EXECUTIVE",
        "MANAGEMENT",
      ])
      .optional(),
    tier: z.enum(["SUPER", "EXECUTIVE", "ADMIN", "EMPLOYEE"]).optional(),
    isTeamLead: z.boolean().optional(),
  })
  .strict();

const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const errors = result.error.errors.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return res
      .status(400)
      .json({ success: false, message: "Validation failed", errors });
  }
  req.body = result.data;
  next();
};

module.exports = { createUserSchema, updateUserSchema, validate };
