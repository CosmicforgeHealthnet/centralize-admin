const { sanitizeExecutionJson } = require("../execution-json.validator");

function createReplacementPlanDraft({ oldResource, desiredResource, dependencyReplacements = [], retirementStrategy, spendExposure, activationPlan }) {
  return sanitizeExecutionJson({
    status: "DRAFT",
    oldResource,
    desiredResource: { ...desiredResource, status: "PAUSED" },
    dependencyReplacements,
    retirementStrategy,
    spendExposure,
    activationPlan: { ...activationPlan, separateApprovalRequired: true },
  }, "desiredState");
}

module.exports = { createReplacementPlanDraft };
