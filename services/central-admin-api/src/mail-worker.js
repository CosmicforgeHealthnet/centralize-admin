"use strict";

// CosmicForge Mail worker process. Start separately (one replica per queue
// set) with `npm run mail:worker`; it is never registered inside API replicas.
// Depends only on the Admin database (not on the HealthNet Main DB).

require("dotenv").config();
const logger = require("./shared/utils/logger");
const { loadMailConfig, publicStatus } = require("./modules/mail/mail.config");

async function main() {
  const config = loadMailConfig(process.env);
  if (!config.enabled || !config.workerEnabled) {
    logger.info("[MailWorker] MAIL_ENABLED and MAIL_WORKER_ENABLED must both be true; exiting without processing.");
    return 0;
  }
  const { prisma, connectDatabase } = require("./shared/config/database");
  await connectDatabase();
  const { createMailApplication } = require("./modules/mail/application");
  const mail = createMailApplication({ client: prisma, config, logger });
  // With MAIL_KMS_PROVIDER=aws-kms the keyring is unwrapped asynchronously;
  // wait for it so the first jobs do not fail closed needlessly.
  await mail.ready();
  if (!mail.storage.available) logger.warn("[MailWorker] Private storage is unavailable; inbound/outbound jobs will retry until configured.");
  const queues = String(process.env.MAIL_WORKER_QUEUES || "OUTBOUND,INBOUND,EVENTS").split(",").map((queue) => queue.trim().toUpperCase()).filter((queue) => ["OUTBOUND", "INBOUND", "EVENTS"].includes(queue));
  const worker = mail.createWorker({ queues });
  logger.info(`[MailWorker] starting ${JSON.stringify({ ...publicStatus(config), queues, leaseOwner: worker.leaseOwner })}`);
  worker.start();

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`[MailWorker] ${signal} received; draining in-flight jobs`);
    const result = await worker.stop({ timeoutMs: 30000 });
    logger.info(`[MailWorker] stopped ${JSON.stringify({ ...result, metrics: worker.metrics })}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  return null;
}

if (require.main === module) {
  main().then((code) => {
    if (code === 0) process.exit(0);
  }).catch((error) => {
    logger.error(`[MailWorker] fatal: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
