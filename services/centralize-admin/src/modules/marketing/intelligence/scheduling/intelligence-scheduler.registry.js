const logger = require("../../../../shared/utils/logger");
const { validateIntelligenceSchedulerEnvironment } = require("./scheduler-config");
const { createRecommendationScheduler } = require("./recommendation.scheduler");
const { createAlertScheduler } = require("./alert.scheduler");
const { createEvaluationScheduler } = require("./evaluation.scheduler");

let registry = null;

function registerIntelligenceSchedulers({
  env = process.env,
  cronLib,
  recommendationEvaluationService,
  alertEvaluationService,
  creativeSyncService,
  creativeScoringService,
  recommendationExpiryService,
  fullEvaluationService,
  log = logger,
  force = false,
} = {}) {
  if (registry) return registry;
  if (env.NODE_ENV === "test" && !force) return null;

  const cron = cronLib || require("node-cron");
  const config = validateIntelligenceSchedulerEnvironment({ env, cronLib: cron });
  const gated = (job) => config.phase2.enabled
    ? job
    : { ...job, enabled: false, disabledReason: "MARKETING_INTELLIGENCE_PHASE2_DISABLED" };
  const recommendation = createRecommendationScheduler({
    config: gated(config.recommendation),
    cronLib: cron,
    evaluationService: recommendationEvaluationService,
    log,
  });
  const alertPerformance = createAlertScheduler({
    config: gated(config.alertPerformance),
    cronLib: cron,
    evaluationService: alertEvaluationService,
    input: { ruleGroup: "performance", types: ["CPA_TARGET_BREACH", "SPEND_WITHOUT_CONVERSION", "CONVERSION_RATE_DROP", "CREATIVE_FATIGUE", "CAMPAIGN_PERFORMANCE_DROP", "HIGH_PERFORMING_CAMPAIGN"] },
    log,
  });
  const alertHealth = createEvaluationScheduler({ name: "alert-health", config: gated(config.alertHealth), cronLib: cron, evaluationService: alertEvaluationService || require("../alerts/alert-evaluation.service"), input: { ruleGroup: "health", types: ["SYNC_STALE", "TOKEN_REFRESH_FAILED", "CONNECTION_DEGRADED", "PLATFORM_PERMISSION_ERROR"] }, log });
  const creativeSyncImplementation = creativeSyncService || require("../creative/creative-sync.service");
  const creativeSync = createEvaluationScheduler({ name: "creative-sync", config: gated(config.creativeSync), cronLib: cron, evaluationService: { evaluate: creativeSyncImplementation.syncCreatives }, log });
  const creativeScoringImplementation = creativeScoringService || require("../creative/creative-scoring.service");
  const creativeScore = createEvaluationScheduler({ name: "creative-score", config: gated(config.creativeScore), cronLib: cron, evaluationService: { evaluate: creativeScoringImplementation.scoreCreatives }, log });
  const recommendationExpiry = createEvaluationScheduler({ name: "recommendation-expiry", config: gated(config.recommendationExpiry), cronLib: cron, evaluationService: recommendationExpiryService || require("../recommendations/recommendation-expiry.service"), log });
  const fullEvaluation = createEvaluationScheduler({ name: "full-evaluation", config: gated(config.fullEvaluation), cronLib: cron, evaluationService: fullEvaluationService || require("../full-evaluation.service"), log });

  recommendation.start();
  alertPerformance.start();
  alertHealth.start();
  creativeSync.start();
  creativeScore.start();
  recommendationExpiry.start();
  fullEvaluation.start();

  registry = {
    config,
    recommendation,
    alert: alertPerformance,
    alertPerformance,
    alertHealth,
    creativeSync,
    creativeScore,
    recommendationExpiry,
    fullEvaluation,
    async stop() {
      const stopped = {};
      for (const [name, scheduler] of Object.entries({ recommendation, alertPerformance, alertHealth, creativeSync, creativeScore, recommendationExpiry, fullEvaluation })) stopped[name] = await scheduler.stop();
      registry = null;
      return stopped;
    },
  };
  return registry;
}

async function resetForTests() {
  await registry?.stop();
  registry = null;
}

module.exports = { registerIntelligenceSchedulers, resetForTests };
