const router = require("./intelligence.routes");
const internalRouter = require("./internal.routes");
const intelligenceService = require("./intelligence.service");
const aggregationService = require("./aggregation/aggregation.service");
const { registerMarketingIntelligenceCron } = require("./aggregation/aggregation.cron");
const { registerIntelligenceSchedulers } = require("./scheduling/intelligence-scheduler.registry");
const funnelEventListener = require("./listeners/funnel-event.listener");

module.exports = {
  router,
  internalRouter,
  intelligenceService,
  aggregationService,
  registerMarketingIntelligenceCron,
  registerIntelligenceSchedulers,
  funnelEventListener,
};
