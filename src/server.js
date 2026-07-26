const http = require("http");
const app = require("./app");
const { connectDatabase } = require("./shared/config/database");
const {
  connectMainDatabase,
  mainPrisma,
} = require("./shared/config/mainDatabase");
const { initializeWebSocket } = require("./websocket");
const bootstrap = require("./shared/events/bootstrap");
const {
  registerMarketingIntelligenceCron,
} = require("./modules/marketing/intelligence/aggregation/aggregation.cron");
const {
  registerIntelligenceSchedulers,
} = require("./modules/marketing/intelligence/scheduling/intelligence-scheduler.registry");
const {
  registerSocialWorkers,
} = require("./modules/marketing/social-operations/workers/social-worker-runner");
const {
  validateSocialOperationsEnvironment,
} = require("./modules/marketing/social-operations/config/social-operations-env.validator");
const providerConnectionsService = require("./modules/marketing/intelligence/provider-connections.service");
const logger = require("./shared/utils/logger");
const { getAdvertisingExecutionApplication } = require("./modules/marketing/advertising-execution/runtime");

const PORT = process.env.PORT || 4000;

const startServer = async () => {
  let socialWorkers = null;
  let marketingSyncCron = null;
  let intelligenceSchedulers = null;
  let advertisingExecution = null;
  try {
    const socialConfig = validateSocialOperationsEnvironment();
    logger.info(
      `[SocialOperations] Configuration validated: ${JSON.stringify({
        mode: socialConfig.mode,
        storageProvider: socialConfig.storageProvider,
        enabledProviders: socialConfig.enabledProviders,
        phaseDEnabled: socialConfig.phaseDEnabled,
        inboxEnabled: socialConfig.inboxEnabled,
      })}`,
    );
    await connectDatabase();
    await connectMainDatabase();
    logger.info(
      `[MarketingIntelligence] Provider env summary: ${JSON.stringify(providerConnectionsService.configuredEnvStatus())}`,
    );
    if (String(process.env.MARKETING_INTELLIGENCE_BOOTSTRAP_CONNECTIONS).toLowerCase() === "true") {
      const summary = await providerConnectionsService.bootstrapAllFromEnv();
      logger.info(`[MarketingIntelligence] Provider bootstrap checked: ${JSON.stringify(summary)}`);
    }
    bootstrap();
    marketingSyncCron = registerMarketingIntelligenceCron();
    intelligenceSchedulers = registerIntelligenceSchedulers();
    socialWorkers = registerSocialWorkers();
    advertisingExecution = getAdvertisingExecutionApplication();
    const advertisingWorkerStatus = advertisingExecution.startWorkers();
    logger.info(`[AdvertisingExecution] Worker lifecycle initialized: ${JSON.stringify(advertisingWorkerStatus)}`);

    const server = http.createServer(app);
    initializeWebSocket(server);

    server.listen(PORT, () => {
      logger.info(
        `Admin server running on port ${PORT} [${process.env.NODE_ENV}]`,
      );
    });


    // everything below stays exactly the same...
    const shutdown = async (signal) => {
      logger.info(`${signal} received - shutting down gracefully`);
      server.close(async () => {
        const { prisma } = require("./shared/config/database");
        const { mainPrisma } = require("./shared/config/mainDatabase");
        if (socialWorkers?.shutdown) {
          await socialWorkers.shutdown();
        }
        await advertisingExecution?.shutdownWorkers();
        await intelligenceSchedulers?.stop();
        await marketingSyncCron?.stop();
        await prisma.$disconnect();
        await mainPrisma.$disconnect();
        logger.info("Databases disconnected");
        process.exit(0);
      });

      setTimeout(() => {
        logger.error("Forced shutdown after timeout");
        process.exit(1);
      }, 10000);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    process.on("unhandledRejection", (reason) => {
      logger.error("Unhandled Rejection:", reason);
    });

    process.on("uncaughtException", (error) => {
      logger.error("Uncaught Exception:", error);
      process.exit(1);
    });
  } catch (error) {
    logger.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
