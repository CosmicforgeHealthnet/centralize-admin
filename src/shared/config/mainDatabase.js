const { PrismaClient } = require("../../generated/main-client");
const { PrismaPg } = require("@prisma/adapter-pg");
const logger = require("../utils/logger");

const adapter = new PrismaPg({
  connectionString: process.env.MAIN_DATABASE_URL,
});

const mainPrisma = new PrismaClient({ adapter });

const connectMainDatabase = async () => {
  try {
    await mainPrisma.$connect();
    logger.info("Main database connected");

    // Test query
    const count = await mainPrisma.users.count();
    logger.info(`Main DB test — users count: ${count}`);
  } catch (error) {
    logger.error("Main database connection failed:", error);
    process.exit(1);
  }
};

module.exports = { mainPrisma, connectMainDatabase };
