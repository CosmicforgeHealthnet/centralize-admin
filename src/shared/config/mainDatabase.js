const { PrismaClient } = require("../../generated/main-client");
const { PrismaPg } = require("@prisma/adapter-pg");
const logger = require("../utils/logger");

const adapter = new PrismaPg({
  connectionString: process.env.MAIN_DATABASE_URL,
  // Add connection pool settings
  max: 10, // Max connections in pool
  idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
  connectionTimeoutMillis: 5000, // Timeout for getting connection from pool
});

const mainPrisma = new PrismaClient({
  adapter,
  // Add Prisma client options
  log: ["error", "warn"],
  errorFormat: "pretty",
});

const connectMainDatabase = async () => {
  let retries = 3;
  let delay = 2000;

  for (let i = 0; i < retries; i++) {
    try {
      await mainPrisma.$connect();
      logger.info("Main database connected");

      // Test query with timeout
      const count = await mainPrisma.$queryRaw`SELECT 1 as connected`;
      logger.info(`Main DB connection verified`);

      // Optional: Get actual user count with error handling
      try {
        const userCount = await mainPrisma.users.count();
        logger.info(`Main DB — users count: ${userCount}`);
      } catch (countError) {
        logger.warn(`Could not get user count: ${countError.message}`);
      }

      return; // Success, exit function
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
      delay *= 2; // Exponential backoff: 2s, 4s, 8s
    }
  }
};

// Add keep-alive ping every 30 seconds to prevent idle disconnection
let keepAliveInterval;

const startKeepAlive = () => {
  if (keepAliveInterval) clearInterval(keepAliveInterval);

  keepAliveInterval = setInterval(async () => {
    try {
      await mainPrisma.$queryRaw`SELECT 1`;
      logger.debug("Database keep-alive ping successful");
    } catch (error) {
      logger.error("Database keep-alive ping failed:", error.message);
      // Attempt to reconnect
      try {
        await mainPrisma.$connect();
        logger.info("Database reconnected after ping failure");
      } catch (reconnectError) {
        logger.error("Failed to reconnect:", reconnectError.message);
      }
    }
  }, 30000); // Every 30 seconds
};

// Call this after successful connection
const initDatabase = async () => {
  await connectMainDatabase();
  startKeepAlive();
};

module.exports = {
  mainPrisma,
  connectMainDatabase: initDatabase,
};
