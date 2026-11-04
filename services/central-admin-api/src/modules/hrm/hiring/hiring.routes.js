const express = require("express");
const {
  requireTier,
  requireSection,
  requireTierOrDepartment,
} = require("../../../shared/middlewares/rbac.middleware");
const hiringController = require("./hiring.controller");
const {
  applicantStageSchema,
  applicantsQuerySchema,
  vacanciesQuerySchema,
  vacancySchema,
  vacancyStatusSchema,
  validateBody,
  validateQuery,
} = require("./hiring.validator");

const router = express.Router();

router.get(
  "/stats",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "hiring", "VIEW"),
  hiringController.getStats,
);
router.get(
  "/vacancies",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "hiring", "VIEW"),
  validateQuery(vacanciesQuerySchema),
  hiringController.listVacancies,
);
router.post(
  "/vacancies",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "hiring", "EDIT"),
  validateBody(vacancySchema),
  hiringController.createVacancy,
);
router.get(
  "/vacancies/:id/applicants",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "hiring", "VIEW"),
  validateQuery(applicantsQuerySchema),
  hiringController.listApplicants,
);
router.get(
  "/vacancies/:id",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "hiring", "VIEW"),
  hiringController.getVacancy,
);
router.put(
  "/vacancies/:id",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "hiring", "EDIT"),
  validateBody(vacancySchema.partial().strict()),
  hiringController.updateVacancy,
);
router.patch(
  "/vacancies/:id/status",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "hiring", "EDIT"),
  validateBody(vacancyStatusSchema),
  hiringController.updateVacancyStatus,
);
router.delete(
  "/vacancies/:id",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "hiring", "EDIT"),
  hiringController.deleteVacancy,
);
router.get(
  "/applicants/:id",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "hiring", "VIEW"),
  hiringController.getApplicant,
);
router.patch(
  "/applicants/:id/stage",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "hiring", "EDIT"),
  validateBody(applicantStageSchema),
  hiringController.updateApplicantStage,
);

module.exports = router;
