"use strict";

// Composition root for CosmicForge Mail. Everything is injectable so tests run
// against an isolated database, an offline provider and in-memory storage.

const { loadMailConfig, infrastructureViolations } = require("./mail.config");
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
const { createAttachmentReviewService } = require("./services/attachment-review.service");
const { createMarketingService } = require("./marketing/marketing.service");
const { createStepUpService } = require("./authz/step-up.service");
const { createBreakGlassService } = require("./authz/break-glass.service");
const { createMailJobRepository } = require("./jobs/mail-job.repository");
const { createMailWorker } = require("./jobs/mail-worker");
const { createInboundProcessor } = require("./pipelines/inbound.processor");
const { createOutboundProcessor } = require("./pipelines/outbound.processor");
const { createDeliveryEventProcessor } = require("./pipelines/delivery-event.processor");
const { createResendWebhookHandler } = require("./webhooks/resend-webhook.controller");
const { createMarketingProviderResolver } = require("./adapters/marketing");
const { createBroadcastService } = require("./marketing/broadcast.service");
const { createBroadcastProcessor } = require("./marketing/broadcast.processor");
const { createAutomationService } = require("./marketing/automation/automation.service");
const { createAutomationProcessor } = require("./marketing/automation/automation.processor");
const { createConfirmationService } = require("./marketing/confirmation.service");
const { createMarketingEventsProcessor } = require("./marketing/marketing-events.processor");
const { createPublicPreferencesService } = require("./marketing/public-preferences.service");
const { createIntegrationService } = require("./integrations/integration.service");
const { createRuntimeControls } = require("./ops/runtime-controls");
const { createUsageService } = require("./ops/usage.service");
const { createRetentionService } = require("./ops/retention.service");
const { createRetentionProcessor } = require("./ops/retention.processor");
const { createOpsMonitor } = require("./ops/ops-monitor.service");
const { createRolloutService } = require("./ops/rollout.service");
const { createReadiness } = require("./ops/readiness");

async function unwrapKeyring({ config, encryption, logger, kmsClient }) {
  const { resolveMailKeyring, createAwsKmsClient } = require("./security/kms-keyring");
  if (infrastructureViolations(config).some((problem) => problem.startsWith("MAIL_KMS"))) {
    encryption.fail({ code: "MAIL_KMS_CONFIG" });
    return;
  }
  try {
    const client = kmsClient || createAwsKmsClient({
      region: config.kms.region,
      endpoint: config.kms.endpoint,
      keyId: config.kms.keyId,
      timeoutMs: config.kms.timeoutMs,
      credentials: { accessKeyId: config.kms.accessKeyId, secretAccessKey: config.kms.secretAccessKey, sessionToken: config.kms.sessionToken || undefined },
    });
    const keyring = await resolveMailKeyring({ provider: "aws-kms", keys: config.encryption.keys, activeKey: config.encryption.activeKey, environment: config.deploymentEnvironment, kmsClient: client });
    if (!keyring.active) throw Object.assign(new Error("No Mail data keys configured"), { code: "MAIL_KMS_CONFIG" });
    encryption.load(keyring);
    logger.info?.(`[Mail] keyring unwrapped via KMS (${keyring.keys.size} key version(s), active ${keyring.active})`);
  } catch (error) {
    encryption.fail(error);
    // Never log key material or ciphertext; the code and message are safe.
    if (config.enabled) logger.error?.(`[Mail] KMS keyring unavailable (${error.code || "error"}): ${error.message}`);
  }
}

function createMailApplication({ client, env = process.env, config = loadMailConfig(env), adapter, storageBackend, scanner, encryption, kmsClient, mfa, authSchema, marketingAdapter, marketingAdapters, logger = console, clock = () => new Date() } = {}) {
  if (!client) client = require("../../shared/config/database").prisma;
  const useKms = !encryption && config.kms?.provider === "aws-kms";
  const resolvedEncryption = encryption || createMailEncryption(useKms ? { deferred: true } : config.encryption);
  // KMS-wrapped data keys are unwrapped once, asynchronously. Until then (or if
  // it fails) the keyring is unavailable and every content operation fails closed.
  const keyringReady = useKms ? unwrapKeyring({ config, encryption: resolvedEncryption, logger, kmsClient }) : Promise.resolve();
  const resolvedAdapter = adapter || createProviderAdapter({ config });
  const storage = createMailStorage({ config, encryption: resolvedEncryption, backend: storageBackend, logger });
  const resolvedScanner = createAttachmentScanner({ config, scanner, logger });
  const audit = createMailAudit({ client });
  const notifications = createMailNotifications({ client, logger });
  const store = createMessageStore({ client, storage, config, encryption: resolvedEncryption });
  const jobs = createMailJobRepository({ client, clock });
  const stepUp = createStepUpService({ client, config, clock, audit, mfa, authSchema, env, logger });
  const breakGlass = createBreakGlassService({ client, stepUp, audit, clock });
  const mailbox = createMailboxService({ client, config, store, audit });
  // M9: kill switch and usage/quota accounting shared by every send path.
  const runtime = createRuntimeControls({ config });
  // M10: database-backed rollout rules, cohorts and operator emergency stops.
  const rollout = createRolloutService({ client, config, audit, stepUp, clock });
  runtime.use(rollout.resolver);
  const usage = createUsageService({ client, audit, env, clock });
  const providerReady = () => resolvedAdapter.name !== "unconfigured";
  const compose = createComposeService({ client, config, store, encryption: resolvedEncryption, scanner: resolvedScanner, jobs, audit, notifications, providerReady, runtime, usage, clock });
  const admin = createMailAdminService({ client, config, adapter: resolvedAdapter, audit, notifications, clock });
  const support = createSupportService({ client, mailboxService: mailbox, audit, notifications, encryption: resolvedEncryption, clock });
  // M7: per-brand marketing provider accounts, broadcasts and automation.
  const marketingProviders = createMarketingProviderResolver({ config, env, adapter: marketingAdapter, adapters: marketingAdapters });
  const confirmation = createConfirmationService({ client, config, audit, jobs, encryption: resolvedEncryption, marketingProviders, runtime, usage, clock });
  const marketing = createMarketingService({ client, config, audit, stepUp, clock, hooks: { onConfirmationRequired: confirmation.onConfirmationRequired } });
  const broadcasts = createBroadcastService({ client, config, audit, jobs, stepUp, env, clock });
  const automations = createAutomationService({ client, config, audit, stepUp, clock });
  const publicPreferences = createPublicPreferencesService({ client, config, audit, marketing, clock });
  const integrations = createIntegrationService({ client, config, audit, stepUp, automations, notifications, rollout, env, clock, logger });
  const attachmentReview = createAttachmentReviewService({ client, config, store, scanner: resolvedScanner, audit });

  const inbound = createInboundProcessor({ client, config, adapter: resolvedAdapter, store, scanner: resolvedScanner, audit, notifications, usage, clock });
  const outbound = createOutboundProcessor({ client, config, adapter: resolvedAdapter, store, audit, notifications, runtime, usage, clock });
  const marketingEvents = createMarketingEventsProcessor({ client, audit, clock });
  const deliveryEvents = createDeliveryEventProcessor({ client, audit, notifications, marketingEvents });
  const broadcastProcessor = createBroadcastProcessor({ client, config, audit, jobs, marketingProviders, eligibility: marketing.eligibleContacts, notifications, runtime, usage, clock, logger });
  const automationProcessor = createAutomationProcessor({ client, config, audit, jobs, marketingProviders, eligibility: marketing.eligibleContacts, runtime, usage, clock, logger });

  const retention = createRetentionService({ client, config, audit, jobs, stepUp, clock });
  const retentionProcessor = createRetentionProcessor({ client, config, audit, storage, clock, logger });
  // `health` is a hoisted function declaration below.
  const ops = createOpsMonitor({ client, config, notifications, health: () => health(), runtime, clock, logger });
  const readiness = createReadiness({ client, config, ops, health: () => health() });

  function createWorker(options = {}) {
    return createMailWorker({
      jobs,
      config,
      logger,
      handlers: {
        SEND_MESSAGE: outbound.process,
        PROCESS_INBOUND: inbound.process,
        PROCESS_DELIVERY_EVENT: deliveryEvents.process,
        BROADCAST_DISPATCH: broadcastProcessor.processDispatch,
        BROADCAST_RECONCILE: broadcastProcessor.processReconcile,
        AUTOMATION_TICK: automationProcessor.processTick,
        AUTOMATION_STEP: automationProcessor.processStep,
        MARKETING_CONFIRMATION_EMAIL: confirmation.process,
        RETENTION_RUN: retentionProcessor.processRun,
        OPS_EVALUATE: ops.processEvaluate,
      },
      onDeadLetter: { SEND_MESSAGE: outbound.onDeadLetter, BROADCAST_DISPATCH: broadcastProcessor.onDeadLetter, BROADCAST_RECONCILE: broadcastProcessor.onDeadLetter, AUTOMATION_STEP: automationProcessor.onDeadLetter, RETENTION_RUN: retentionProcessor.onDeadLetter },
      // A MARKETING worker schedules one automation tick per minute bucket;
      // the idempotency key makes concurrent workers enqueue it once.
      queueFilter: config.rollout.enforced ? rollout.workerQueuesAllowed : null,
      beforeTick: async ({ queues }) => {
        const once = (spec) => jobs.enqueue(null, spec).catch((error) => {
          if (error?.code !== "P2002") throw error;
        });
        if (queues.includes("MARKETING") && config.automationEnabled) {
          const bucket = Math.floor(clock().getTime() / 60000);
          await once({ queue: "MARKETING", kind: "AUTOMATION_TICK", idempotencyKey: `automation-tick:${bucket}`, maxAttempts: 2 });
        }
        // M9: one ops evaluation per interval bucket across all EVENTS workers.
        if (queues.includes("EVENTS") && config.ops.alertsEnabled) {
          const bucket = Math.floor(clock().getTime() / (config.ops.evaluateIntervalSeconds * 1000));
          await once({ queue: "EVENTS", kind: "OPS_EVALUATE", idempotencyKey: `ops-evaluate:${bucket}`, maxAttempts: 2 });
        }
      },
      ...options,
    });
  }

  async function health() {
    const [storageHealth, provider, queue, scannerHealth] = await Promise.all([
      storage.health().catch(() => ({ ok: false, detail: "error" })),
      config.enabled ? resolvedAdapter.healthProbe().catch(() => ({ ok: false, detail: "error" })) : { ok: false, detail: "mail disabled" },
      jobs.stats().catch(() => []),
      (resolvedScanner.health ? resolvedScanner.health() : Promise.resolve({ ok: resolvedScanner.available, detail: "no probe" })).catch(() => ({ ok: false, detail: "error" })),
    ]);
    return {
      storage: { ...storageHealth, backend: storage.name },
      provider: { ok: provider.ok, detail: provider.detail },
      scanner: { name: resolvedScanner.name, available: resolvedScanner.available, ok: Boolean(scannerHealth.ok), detail: scannerHealth.detail, version: scannerHealth.version || null, metrics: resolvedScanner.metrics || null },
      encryption: { available: resolvedEncryption.available, provider: useKms ? "aws-kms" : "env", keyVersions: resolvedEncryption.versions?.length ?? null, activeVersion: resolvedEncryption.activeVersion || null, error: resolvedEncryption.loadError || null },
      infrastructure: { deploymentEnvironment: config.deploymentEnvironment, violations: infrastructureViolations(config) },
      queue,
    };
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
    services: { mailbox, compose, admin, support, marketing, stepUp, breakGlass, attachmentReview, broadcasts, automations, publicPreferences, confirmation, integrations, usage, retention, ops, rollout, readiness },
    runtime,
    processors: { inbound, outbound, deliveryEvents, marketingEvents, broadcasts: broadcastProcessor, automations: automationProcessor, retention: retentionProcessor },
    marketingProviders,
    webhookHandler: createResendWebhookHandler({ client, config, jobs, audit, logger, clock: () => clock().getTime(), env }),
    brandWebhookHandler: createResendWebhookHandler({ client, config, jobs, audit, logger, clock: () => clock().getTime(), env, brandMode: true }),
    // POST /api/mail/v1/integrations/v1/events (raw body, service HMAC).
    integrationHandler: async (req, res) => {
      const result = await integrations.ingest(req);
      res.status(result.status).json(result.body);
    },
    createWorker,
    health,
    ready: () => keyringReady,
  };
}

module.exports = { createMailApplication };
