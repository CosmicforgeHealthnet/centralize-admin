const { PrismaClient } = require("../../generated/main-client");
const { PrismaPg } = require("@prisma/adapter-pg");
const logger = require("../utils/logger");

const getConnectionString = () => {
  const env = process.env.MAIN_DB_ENV || "dev";

  if (env === "prod") {
    logger.info("Main DB — connecting to PRODUCTION");
    return process.env.MAIN_DATABASE_URL_PROD;
  }

  logger.info("Main DB — connecting to DEV");
  return process.env.MAIN_DATABASE_URL_DEV;
};

const adapter = new PrismaPg({
  connectionString: getConnectionString(),
  max: 2,
  idleTimeoutMillis: 300000,
  // Keep optional HealthNet dependency outages from holding API workers for 30s.
  connectionTimeoutMillis: 7000,
});

const mainPrisma = new PrismaClient({
  adapter,
  log: ["error", "warn"],
  errorFormat: "pretty",
});

// Single-flight connect: only one attempt per retry tick, not five overlapping
// connections with exponential waits. The server owns the retry schedule.
let connectionInFlight = null;
const connectMainDatabase = () => {
  if (connectionInFlight) return connectionInFlight;
  connectionInFlight = (async () => {
    await mainPrisma.$connect();
    const userCount = await mainPrisma.users.count();
    logger.info(`Main DB connection verified — users count: ${userCount}`);
  })().finally(() => {
    connectionInFlight = null;
  });
  return connectionInFlight;
};

let keepAliveInterval;

const startKeepAlive = () => {
  if (keepAliveInterval) clearInterval(keepAliveInterval);

  keepAliveInterval = setInterval(async () => {
    try {
      await mainPrisma.users.count();
      logger.debug("Database keep-alive ping successful");
    } catch (error) {
      logger.error("Database keep-alive ping failed:", error.message);
      try {
        await mainPrisma.$connect();
        logger.info("Database reconnected after ping failure");
      } catch (reconnectError) {
        logger.error("Failed to reconnect:", reconnectError.message);
      }
    }
  }, 60000);
};

const initDatabase = async () => {
  await connectMainDatabase();
  startKeepAlive();
};

module.exports = {
  mainPrisma,
  connectMainDatabase: initDatabase,
};
