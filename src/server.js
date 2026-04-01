const app = require("./app");
const { connectDatabase } = require("./shared/config/database");
const logger = require("./shared/utils/logger");

const PORT = process.env.PORT || 4000;

const startServer = async () => {
  try {
    // Connect to DB first — fail fast if DB is unreachable
    await connectDatabase();

    const server = app.listen(PORT, () => {
      logger.info(
        `Admin server running on port ${PORT} [${process.env.NODE_ENV}]`,
      );
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`${signal} received — shutting down gracefully`);
      server.close(async () => {
        const { prisma } = require("./shared/config/database");
        await prisma.$disconnect();
        logger.info("Database disconnected");
        process.exit(0);
      });

      // Force shutdown if graceful takes too long
      setTimeout(() => {
        logger.error("Forced shutdown after timeout");
        process.exit(1);
      }, 10000);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    // Catch unhandled promise rejections
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
