require("dotenv").config();
const { PrismaClient } = require("../../generated/dispatch-client");
const { PrismaPg } = require("@prisma/adapter-pg");
const logger = require("../utils/logger");

const adapter = new PrismaPg({
  connectionString: process.env.DISPATCH_DATABASE_URL,
  max: 2,
  idleTimeoutMillis: 300000,
  connectionTimeoutMillis: 30000,
});

const dispatchPrisma = new PrismaClient({
  adapter,
  log: ["error", "warn"],
  errorFormat: "pretty",
});

const connectDispatchDatabase = async () => {
  let retries = 5;
  let delay = 3000;

  for (let i = 0; i < retries; i++) {
    try {
      await dispatchPrisma.$connect();
      logger.info("Dispatch database connected");

      const providerCount = await dispatchPrisma.providers.count();
      logger.info(
        `Dispatch DB connection verified — providers count: ${providerCount}`,
      );

      return;
    } catch (error) {
      logger.error(
        `Dispatch DB connection attempt ${i + 1} failed:`,
        error.message,
      );

      if (i === retries - 1) {
        logger.error("All dispatch DB connection attempts failed");
        process.exit(1);
      }

      logger.info(`Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
};

module.exports = { dispatchPrisma, connectDispatchDatabase };
