const { createEvaluationScheduler } = require("./evaluation.scheduler");

function createRecommendationScheduler({ config, cronLib, evaluationService, log } = {}) {
  return createEvaluationScheduler({
    name: "recommendation",
    config,
    cronLib,
    evaluationService: evaluationService || require("../recommendations/recommendation-evaluation.service"),
    log,
  });
}

module.exports = { createRecommendationScheduler };
