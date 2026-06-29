const express = require("express");
const { requireTier } = require("../../../shared/middlewares/rbac.middleware");
const hiringController = require("./hiring.controller");
const {
  applicantStageSchema,
  vacancySchema,
  vacancyStatusSchema,
  validateBody,
} = require("./hiring.validator");

const router = express.Router();

router.get("/stats", requireTier("ADMIN"), hiringController.getStats);
router.get("/vacancies", requireTier("ADMIN"), hiringController.listVacancies);
router.post(
  "/vacancies",
  requireTier("ADMIN"),
  validateBody(vacancySchema),
  hiringController.createVacancy,
);
router.get("/vacancies/:id/applicants", requireTier("ADMIN"), hiringController.listApplicants);
router.get("/vacancies/:id", requireTier("ADMIN"), hiringController.getVacancy);
router.put(
  "/vacancies/:id",
  requireTier("ADMIN"),
  validateBody(vacancySchema.partial().strict()),
  hiringController.updateVacancy,
);
router.patch(
  "/vacancies/:id/status",
  requireTier("ADMIN"),
  validateBody(vacancyStatusSchema),
  hiringController.updateVacancyStatus,
);
router.delete("/vacancies/:id", requireTier("ADMIN"), hiringController.deleteVacancy);
router.get("/applicants/:id", requireTier("ADMIN"), hiringController.getApplicant);
router.patch(
  "/applicants/:id/stage",
  requireTier("ADMIN"),
  validateBody(applicantStageSchema),
  hiringController.updateApplicantStage,
);

module.exports = router;
