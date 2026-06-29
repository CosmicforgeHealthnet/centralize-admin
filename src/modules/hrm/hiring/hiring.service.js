const { unsupportedEndpoint } = require("../hrm.utils");

const MISSING_MODELS = ["JobVacancy", "JobApplicant"];

class HiringService {
  getStats() {
    unsupportedEndpoint("Hiring stats", MISSING_MODELS);
  }

  listVacancies() {
    unsupportedEndpoint("Hiring vacancies", MISSING_MODELS);
  }

  createVacancy() {
    unsupportedEndpoint("Hiring vacancy create", MISSING_MODELS);
  }

  getVacancy() {
    unsupportedEndpoint("Hiring vacancy detail", MISSING_MODELS);
  }

  updateVacancy() {
    unsupportedEndpoint("Hiring vacancy update", MISSING_MODELS);
  }

  updateVacancyStatus() {
    unsupportedEndpoint("Hiring vacancy status update", MISSING_MODELS);
  }

  deleteVacancy() {
    unsupportedEndpoint("Hiring vacancy delete", MISSING_MODELS);
  }

  listApplicants() {
    unsupportedEndpoint("Hiring vacancy applicants", MISSING_MODELS);
  }

  getApplicant() {
    unsupportedEndpoint("Hiring applicant detail", MISSING_MODELS);
  }

  updateApplicantStage() {
    unsupportedEndpoint("Hiring applicant stage update", MISSING_MODELS);
  }
}

module.exports = new HiringService();
