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
  max: 10,
  idleTimeoutMillis: 300000,
  connectionTimeoutMillis: 30000,
});

const mainPrisma = new PrismaClient({
  adapter,
  log: ["error", "warn"],
  errorFormat: "pretty",
});

const connectMainDatabase = async () => {
  let retries = 5;
  let delay = 3000;

  for (let i = 0; i < retries; i++) {
    try {
      await mainPrisma.$connect();
      logger.info("Main database connected");

      const userCount = await mainPrisma.users.count();
      logger.info(`Main DB connection verified — users count: ${userCount}`);

      return;
    } catch (error) {
      logger.error(
        `Database connection attempt ${i + 1} failed:`,
        error.message,
      );

      if (i === retries - 1) {
        logger.error("All connection attempts failed");
        process.exit(1);
      }

      logger.info(`Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
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
