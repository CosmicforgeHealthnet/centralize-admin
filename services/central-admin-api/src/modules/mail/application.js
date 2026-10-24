"use strict";

// Composition root for CosmicForge Mail. Everything is injectable so tests run
// against an isolated database, an offline provider and in-memory storage.

const { loadMailConfig } = require("./mail.config");
const { createProviderAdapter } = require("./adapters");
const { createMailEncryption } = require("./security/mail-encryption.service");
const { createMailStorage } = require("./storage/mail-storage");
const { createAttachmentScanner } = require("./scanning/attachment-scanner");
const { createMailAudit } = require("./services/mail-audit.service");
const { createMailNotifications } = require("./services/mail-notifications.adapter");
const { createMessageStore } = require("./services/message-store.service");
const { createMailboxService } = require("./services/mailbox.service");
const { createComposeService } = require("./services/compose.service");
const { createMailAdminService } = require("./services/mail-admin.service");
const { createSupportService } = require("./services/support.service");
const { createMarketingService } = require("./marketing/marketing.service");
const { createStepUpService } = require("./authz/step-up.service");
const { createBreakGlassService } = require("./authz/break-glass.service");
const { createMailJobRepository } = require("./jobs/mail-job.repository");
const { createMailWorker } = require("./jobs/mail-worker");
const { createInboundProcessor } = require("./pipelines/inbound.processor");
const { createOutboundProcessor } = require("./pipelines/outbound.processor");
const { createDeliveryEventProcessor } = require("./pipelines/delivery-event.processor");
const { createResendWebhookHandler } = require("./webhooks/resend-webhook.controller");

function createMailApplication({ client, env = process.env, config = loadMailConfig(env), adapter, storageBackend, scanner, encryption, logger = console, clock = () => new Date() } = {}) {
  if (!client) client = require("../../shared/config/database").prisma;
  const resolvedEncryption = encryption || createMailEncryption(config.encryption);
  const resolvedAdapter = adapter || createProviderAdapter({ config });
  const storage = createMailStorage({ config, encryption: resolvedEncryption, backend: storageBackend });
  const resolvedScanner = createAttachmentScanner({ config, scanner });
  const audit = createMailAudit({ client });
  const notifications = createMailNotifications({ client, logger });
  const store = createMessageStore({ client, storage, config });
  const jobs = createMailJobRepository({ client, clock });
  const stepUp = createStepUpService({ client, config, clock, audit });
  const breakGlass = createBreakGlassService({ client, stepUp, audit, clock });
  const mailbox = createMailboxService({ client, config, store, audit });
  const compose = createComposeService({ client, config, store, encryption: resolvedEncryption, scanner: resolvedScanner, jobs, audit, notifications, clock });
  const admin = createMailAdminService({ client, config, adapter: resolvedAdapter, audit, notifications, clock });
  const support = createSupportService({ client, mailboxService: mailbox, audit, notifications, clock });
  const marketing = createMarketingService({ client, config, audit, stepUp, clock });

  const inbound = createInboundProcessor({ client, config, adapter: resolvedAdapter, store, scanner: resolvedScanner, audit, notifications, clock });
  const outbound = createOutboundProcessor({ client, config, adapter: resolvedAdapter, store, audit, notifications, clock });
  const deliveryEvents = createDeliveryEventProcessor({ client, audit, notifications });

  function createWorker(options = {}) {
    return createMailWorker({
      jobs,
      config,
      logger,
      handlers: { SEND_MESSAGE: outbound.process, PROCESS_INBOUND: inbound.process, PROCESS_DELIVERY_EVENT: deliveryEvents.process },
      onDeadLetter: { SEND_MESSAGE: outbound.onDeadLetter },
      ...options,
    });
  }

  async function health() {
    const [storageHealth, provider, queue] = await Promise.all([
      storage.health().catch(() => ({ ok: false, detail: "error" })),
      config.enabled ? resolvedAdapter.healthProbe().catch(() => ({ ok: false, detail: "error" })) : { ok: false, detail: "mail disabled" },
      jobs.stats().catch(() => []),
    ]);
    return { storage: storageHealth, provider: { ok: provider.ok, detail: provider.detail }, scanner: { name: resolvedScanner.name, available: resolvedScanner.available }, encryption: { available: resolvedEncryption.available }, queue };
  }

  return {
    client,
    config,
    adapter: resolvedAdapter,
    storage,
    scanner: resolvedScanner,
    encryption: resolvedEncryption,
    audit,
    store,
    jobs,
    services: { mailbox, compose, admin, support, marketing, stepUp, breakGlass },
    processors: { inbound, outbound, deliveryEvents },
    webhookHandler: createResendWebhookHandler({ client, config, jobs, audit, logger, clock: () => clock().getTime() }),
    createWorker,
    health,
  };
}

module.exports = { createMailApplication };
