const express = require("express");
const multer = require("multer");
const ApiError = require("../../../shared/utils/ApiError");
const { requireTier } = require("../../../shared/middlewares/rbac.middleware");
const { multerSingle } = require("../hrm.utils");
const employeesController = require("./employees.controller");
const {
  employeeContactSchema,
  employeeEducationSchema,
  employeeEmergencySchema,
  employeeEmploymentSchema,
  employeePersonalSchema,
  employeeSensitiveSchema,
  employeeSocialSchema,
  validateBody,
} = require("./employees.validator");

const router = express.Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    return cb(new ApiError(400, "Only JPG, PNG, and WEBP images are allowed for avatars"));
  },
});

router.get("/", requireTier("EMPLOYEE"), employeesController.listEmployees);
router.get("/:id", requireTier("EMPLOYEE"), employeesController.getEmployee);
router.put(
  "/:id/personal",
  requireTier("EMPLOYEE"),
  validateBody(employeePersonalSchema),
  employeesController.updatePersonal,
);
router.put(
  "/:id/contact",
  requireTier("EMPLOYEE"),
  validateBody(employeeContactSchema),
  employeesController.updateContact,
);
router.put(
  "/:id/employment",
  requireTier("EXECUTIVE"),
  validateBody(employeeEmploymentSchema),
  employeesController.updateEmployment,
);
router.put(
  "/:id/emergency",
  requireTier("EMPLOYEE"),
  validateBody(employeeEmergencySchema),
  employeesController.updateEmergency,
);
router.put(
  "/:id/social",
  requireTier("EMPLOYEE"),
  validateBody(employeeSocialSchema),
  employeesController.updateSocial,
);
router.put(
  "/:id/sensitive",
  requireTier("EXECUTIVE"),
  validateBody(employeeSensitiveSchema),
  employeesController.updateSensitive,
);
router.put(
  "/:id/avatar",
  requireTier("EMPLOYEE"),
  multerSingle(avatarUpload, "avatar"),
  employeesController.updateAvatar,
);
router.get("/:id/education", requireTier("EMPLOYEE"), employeesController.listEducation);
router.post(
  "/:id/education",
  requireTier("EMPLOYEE"),
  validateBody(employeeEducationSchema),
  employeesController.createEducation,
);
router.put(
  "/:id/education/:eid",
  requireTier("EMPLOYEE"),
  validateBody(employeeEducationSchema),
  employeesController.updateEducation,
);
router.delete(
  "/:id/education/:eid",
  requireTier("EMPLOYEE"),
  employeesController.deleteEducation,
);

module.exports = router;
