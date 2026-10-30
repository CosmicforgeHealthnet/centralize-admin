const { z } = require("zod");

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Must contain uppercase letter")
      .regex(/[a-z]/, "Must contain lowercase letter")
      .regex(/[0-9]/, "Must contain a number")
      .regex(
        /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/,
        "Must contain a special character",
      ),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

const requestPasswordResetSchema = z.object({
  name: z.string().min(1, "Full name is required"),
  email: z.string().email("Invalid email address"),
  position: z.string().optional(),
});

const approveRejectPasswordResetSchema = z.object({
  targetUserId: z.string().min(1, "Target user ID is required"),
  reason: z.string().optional(),
});

// MFA: a 6-digit TOTP or a recovery code (XXXXX-XXXXX), never both required.
const totpCode = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code");
const recoveryCode = z.string().trim().min(10).max(16);
const factor = { code: totpCode.optional(), recoveryCode: recoveryCode.optional() };
const oneFactor = (data) => Boolean(data.code || data.recoveryCode);
const factorMessage = { message: "Enter an authenticator code or a recovery code", path: ["code"] };

const mfaLoginSchema = z
  .object({ challengeToken: z.string().min(20).max(200).optional(), ...factor })
  .refine(oneFactor, factorMessage);

const mfaCodeSchema = z.object(factor).refine(oneFactor, factorMessage);

const mfaPasswordSchema = z.object({ password: z.string().min(1, "Password is required") });

const mfaDisableSchema = z
  .object({ password: z.string().min(1, "Password is required"), ...factor })
  .refine(oneFactor, factorMessage);

const mfaAdminResetSchema = z.object({
  targetUserId: z.string().min(1, "Target user ID is required"),
  reason: z.string().trim().min(10, "Give a reason (at least 10 characters)").max(500),
});

const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
  const errors = result.error.issues.map((e) => ({
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

module.exports = {
  loginSchema,
  changePasswordSchema,
  refreshTokenSchema,
  requestPasswordResetSchema,
  approveRejectPasswordResetSchema,
  mfaLoginSchema,
  mfaCodeSchema,
  mfaPasswordSchema,
  mfaDisableSchema,
  mfaAdminResetSchema,
  validate,
};