const http = require("http"); // ← ADD
const app = require("./app");
const { connectDatabase } = require("./shared/config/database");
const {
  connectMainDatabase,
  mainPrisma,
} = require("./shared/config/mainDatabase");
const { initializeWebSocket } = require("./websocket"); 
const bootstrap = require("./shared/events/bootstrap");
const logger = require("./shared/utils/logger");

const PORT = process.env.PORT || 4000;

const startServer = async () => {
  try {
    await connectDatabase();
    await connectMainDatabase();
    bootstrap();

    const server = http.createServer(app); // ← CHANGE (was app.listen)
    initializeWebSocket(server); // ← ADD

    server.listen(PORT, () => {
      logger.info(
        `Admin server running on port ${PORT} [${process.env.NODE_ENV}]`,
      );
    });


    // everything below stays exactly the same...
    const shutdown = async (signal) => {
      logger.info(`${signal} received — shutting down gracefully`);
      server.close(async () => {
        const { prisma } = require("./shared/config/database");
        const { mainPrisma } = require("./shared/config/mainDatabase");
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
