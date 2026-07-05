const express = require("express");
const {
  requireTier,
  requireSection,
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
  requireTier("ADMIN"),
  requireSection("hrm", "hiring", "VIEW"),
  hiringController.getStats,
);
router.get(
  "/vacancies",
  requireTier("ADMIN"),
  requireSection("hrm", "hiring", "VIEW"),
  validateQuery(vacanciesQuerySchema),
  hiringController.listVacancies,
);
router.post(
  "/vacancies",
  requireTier("ADMIN"),
  requireSection("hrm", "hiring", "EDIT"),
  validateBody(vacancySchema),
  hiringController.createVacancy,
);
router.get(
  "/vacancies/:id/applicants",
  requireTier("ADMIN"),
  requireSection("hrm", "hiring", "VIEW"),
  validateQuery(applicantsQuerySchema),
  hiringController.listApplicants,
);
router.get(
  "/vacancies/:id",
  requireTier("ADMIN"),
  requireSection("hrm", "hiring", "VIEW"),
  hiringController.getVacancy,
);
router.put(
  "/vacancies/:id",
  requireTier("ADMIN"),
  requireSection("hrm", "hiring", "EDIT"),
  validateBody(vacancySchema.partial().strict()),
  hiringController.updateVacancy,
);
router.patch(
  "/vacancies/:id/status",
  requireTier("ADMIN"),
  requireSection("hrm", "hiring", "EDIT"),
  validateBody(vacancyStatusSchema),
  hiringController.updateVacancyStatus,
);
router.delete(
  "/vacancies/:id",
  requireTier("ADMIN"),
  requireSection("hrm", "hiring", "EDIT"),
  hiringController.deleteVacancy,
);
router.get(
  "/applicants/:id",
  requireTier("ADMIN"),
  requireSection("hrm", "hiring", "VIEW"),
  hiringController.getApplicant,
);
router.patch(
  "/applicants/:id/stage",
  requireTier("ADMIN"),
  requireSection("hrm", "hiring", "EDIT"),
  validateBody(applicantStageSchema),
  hiringController.updateApplicantStage,
);

module.exports = router;
