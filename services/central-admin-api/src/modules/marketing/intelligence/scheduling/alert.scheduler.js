const { createEvaluationScheduler } = require("./evaluation.scheduler");

function createAlertScheduler({ config, cronLib, evaluationService, input, log } = {}) {
  return createEvaluationScheduler({
    name: "alert",
    config,
    cronLib,
    evaluationService: evaluationService || require("../alerts/alert-evaluation.service"),
    input,
    log,
  });
}

module.exports = { createAlertScheduler };
