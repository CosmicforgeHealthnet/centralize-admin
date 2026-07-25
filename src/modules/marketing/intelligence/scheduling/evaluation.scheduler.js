const logger = require("../../../../shared/utils/logger");
const { sanitizeProviderText } = require("../connectors/provider-http");
const { structuredLogger } = require("../observability");

function createEvaluationScheduler({ name, config, cronLib, evaluationService, input = {}, log = logger }) {
  log = structuredLogger(log, "marketing.scheduler.operation");
  let task = null;
  const inFlight = new Set();

  function start() {
    if (task) return task;
    if (!config.enabled) {
      log.info(`[MarketingIntelligence] ${name} scheduler disabled`);
      return null;
    }

    task = cronLib.schedule(
      config.expression,
      () => {
        const execution = (async () => {
        try {
          const result = await evaluationService.evaluate({ ...input, trigger: "SCHEDULED" });
          if (result?.skipped) {
            log.info(`[MarketingIntelligence] Scheduled ${name} evaluation skipped: ${result.reason || "LOCKED"}`);
          } else {
            log.info(`[MarketingIntelligence] Scheduled ${name} evaluation completed: ${result?.status || "SUCCEEDED"}`);
          }
          return result;
        } catch (error) {
          const message = sanitizeProviderText(error?.message || "scheduled evaluation failed").slice(0, 500);
          log.error(`[MarketingIntelligence] Scheduled ${name} evaluation failed: ${message}`);
          return { status: "FAILED", sanitizedError: message };
        }
        })();
        inFlight.add(execution);
        execution.finally(() => inFlight.delete(execution));
        return execution;
      },
      { timezone: config.timezone },
    );
    log.info(`[MarketingIntelligence] ${name} scheduler registered (cron="${config.expression}", timezone=${config.timezone})`);
    return task;
  }

  async function stop() {
    if (!task) return false;
    await task.stop();
    task = null;
    await Promise.allSettled([...inFlight]);
    return true;
  }

  return { start, stop, getTask: () => task };
}

module.exports = { createEvaluationScheduler };
