"use strict";

// Composition root for CosmicForge Mail. Everything is injectable so tests run
// against an isolated database, an offline provider and in-memory storage.

const { loadMailConfig, infrastructureViolations } = require("./mail.config");
const { createProviderAdapter } = require("./adapters");
const { withTransportContract, withMarketingContract } = require("./adapters/provider-contract");
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
const { createMailRulesService } = require("./services/mail-rules.service");
const { createSearchIndex } = require("./services/search-index.service");
const { createForwardingService } = require("./services/forwarding.service");
const { createMessageArchive } = require("./services/message-archive.service");
const { createAttachmentReviewService } = require("./services/attachment-review.service");
const { createDsarService } = require("./services/dsar.service");
const { createPreferencesService } = require("./services/preferences.service");
const { createMarketingService } = require("./marketing/marketing.service");
const { createStepUpService } = require("./authz/step-up.service");
const { createBreakGlassService } = require("./authz/break-glass.service");
const { createMailJobRepository } = require("./jobs/mail-job.repository");
const { createMailWorker } = require("./jobs/mail-worker");
const { createInboundProcessor } = require("./pipelines/inbound.processor");
const { loadSenderAuthPolicy } = require("./security/sender-auth");
const { createOutboundProcessor } = require("./pipelines/outbound.processor");
const { createDeliveryEventProcessor } = require("./pipelines/delivery-event.processor");
const { createResendWebhookHandler } = require("./webhooks/resend-webhook.controller");
const { createMarketingProviderResolver } = require("./adapters/marketing");
const { createBroadcastService } = require("./marketing/broadcast.service");
const { createBroadcastProcessor } = require("./marketing/broadcast.processor");
const { createAutomationService } = require("./marketing/automation/automation.service");
const { createAutomationProcessor } = require("./marketing/automation/automation.processor");
// Final gap 4: automation test mode and replay / recovery.
const { createAutomationTestService } = require("./marketing/automation/automation-test.service");
const { createAutomationReplayService } = require("./marketing/automation/automation-replay.service");
const { createConfirmationService } = require("./marketing/confirmation.service");
const { createTestSendService } = require("./marketing/test-send.service");
// Final gaps 1 + 7: template classification policy and deliverability preflight.
const { createTemplatePolicy, registerTemplatePolicy } = require("./marketing/template-policy");
const { registerDeliverability } = require("./marketing/preflight");
const { createCampaignReplies } = require("./marketing/campaign-replies");
const { createMarketingEventsProcessor } = require("./marketing/marketing-events.processor");
const { createPublicPreferencesService } = require("./marketing/public-preferences.service");
const { createIntegrationService } = require("./integrations/integration.service");
const { createRuntimeControls } = require("./ops/runtime-controls");
const { createUsageService } = require("./ops/usage.service");
// Final gaps 2/3: provider re-subscription, provider quota, approved pricing.
const { createResubscriptionService } = require("./marketing/resubscription.service");
const { createProviderQuotaService } = require("./ops/provider-quota.service");
const { createPricingService } = require("./ops/pricing.service");
const { createRetentionService } = require("./ops/retention.service");
const { createRetentionProcessor } = require("./ops/retention.processor");
// Final gaps 5/6: durable storage deletions and IT quarantine management.
const { createStorageDeletionService } = require("./ops/storage-deletion.service");
const { createQuarantineService } = require("./services/quarantine.service");
const { createOpsMonitor } = require("./ops/ops-monitor.service");
const { createRolloutService } = require("./ops/rollout.service");
const { createReadiness } = require("./ops/readiness");
const { createDependencyReadiness } = require("./ops/dependency-readiness");
const { assessMailSession } = require("./security/session-assessment");
const { createRuntimeMetrics } = require("./ops/runtime-metrics");
const { createInboundReconciler } = require("./pipelines/inbound-reconciler");
const { createDeliveryStatusPoller } = require("./pipelines/delivery-status-poller");
const { createSharedRateLimiter } = require("./ops/shared-rate-limit");
const { createMailSchemaReadiness, MAIL_FEATURE_REQUIREMENTS, MAIL_PREFERENCES_REQUIREMENTS, MAIL_FINAL_GAP_REQUIREMENTS } = require("./schema-readiness");

// MAIL_KMS_PROVIDER=file: the self-hosted keyring file is read once at
// startup (read-only mount, root-only, bound to this environment).
async function loadFileKeyring({ config, encryption, logger }) {
  if (infrastructureViolations(config).some((problem) => /MAIL_KMS|MAIL_ENCRYPTION/.test(problem))) {
    encryption.fail({ code: "MAIL_KMS_CONFIG" });
    return;
  }
  try {
    const { readKeyringFile } = require("./security/file-keyring");
    const keyring = readKeyringFile(config.kms.keyringFile, { environment: config.deploymentEnvironment, strictPermissions: config.deploymentEnvironment === "staging" || config.deploymentEnvironment === "production" });
    encryption.load(keyring);
    logger.info?.(`[Mail] keyring loaded from file (${keyring.keys.size} key version(s), active ${keyring.active})`);
  } catch (error) {
    encryption.fail(error);
    // Never log key material; the code and message are safe.
    if (config.enabled) logger.error?.(`[Mail] keyring file unavailable (${error.code || "error"}): ${error.message}`);
  }
}

async function unwrapKeyring({ config, encryption, logger, kmsClient }) {
  if (config.kms.provider === "file") return loadFileKeyring({ config, encryption, logger });
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
  const schema = createMailSchemaReadiness({ client, logger });
  // Migration 35 (gap-closure features). Core Mail never waits for it.
  const features = createMailSchemaReadiness({
    client,
    logger,
    requirements: MAIL_FEATURE_REQUIREMENTS,
    label: "Mail gap-closure feature",
    missingMessage: "[Mail] Gap-closure tables not present: body search, forwarding, message archives, shared rate limits and campaign reply attribution stay off until migration 20261101_mail_spec_gap_closure.sql is applied",
  });
  // Migration 36 (per-user preferences). Probed on its own so a database at
  // migration 35 keeps the gap-closure features; core Mail never waits for it.
  const preferencesFeature = createMailSchemaReadiness({
    client,
    logger,
    requirements: MAIL_PREFERENCES_REQUIREMENTS,
    label: "Mail preferences",
    missingMessage: "[Mail] Preferences table not present: GET /me/preferences answers the defaults, saving preferences answers 503 and no notification is suppressed until migration 20261102_mail_user_preferences.sql is applied",
  });
  // Migration 37 (final gap closure: template classification, provider
  // subscription state, pricing/quota, automation replay, durable storage
  // deletions, quarantine decisions, provider Message-IDs). Probed on its own;
  // each feature answers 503 MAIL_FEATURE_NOT_READY or keeps its pre-37
  // behaviour until the migration is applied.
  const finalGapFeature = createMailSchemaReadiness({
    client,
    logger,
    requirements: MAIL_FINAL_GAP_REQUIREMENTS,
    label: "Mail final gap-closure",
    missingMessage: "[Mail] Final gap-closure tables not present: template classification, re-subscription, pricing and quota reporting, automation replay, the durable deletion queue, quarantine decisions and provider Message-ID aliases stay off until migration 20261103_mail_final_gap_closure.sql is applied",
  });
  const keyProvider = encryption ? "injected" : config.kms?.provider === "aws-kms" || config.kms?.provider === "file" ? config.kms.provider : "env";
  const useKms = keyProvider === "aws-kms" || keyProvider === "file";
  const resolvedEncryption = encryption || createMailEncryption(useKms ? { deferred: true } : config.encryption);
  // KMS-wrapped data keys / the keyring file are loaded once, asynchronously.
  // Until then (or if it fails) the keyring is unavailable and every content
  // operation fails closed.
  const keyringReady = useKms ? unwrapKeyring({ config, encryption: resolvedEncryption, logger, kmsClient }) : Promise.resolve();
  const metrics = createRuntimeMetrics();
  const rateLimiter = createSharedRateLimiter({ client, features, metrics, logger, clock: () => clock().getTime() });
  // §18: every provider call goes through the provider-neutral contract
  // (input validation, normalized results and error categories), then the
  // metrics wrapper (provider errors by kind/category/status).
  // Shared Resend account: test-recipient allowlist + cf_app/cf_env tags on every send.
  const sharedAccountGuards = { recipientPolicy: config.testRecipients, providerTags: config.providerTags };
  const resolvedAdapter = metrics.instrumentProvider(withTransportContract(adapter || createProviderAdapter({ config }), sharedAccountGuards), "transactional");
  // Gap 3: provider quota observations (non-blocking hook; migration 37).
  const providerQuota = createProviderQuotaService({ client, config, env, features: finalGapFeature, clock, logger });
  resolvedAdapter.setQuotaObserver?.(providerQuota.observer("account", resolvedAdapter.name === "fake" ? "fake" : "resend"));
  const storage = createMailStorage({ config, encryption: resolvedEncryption, backend: storageBackend, logger });
  const resolvedScanner = createAttachmentScanner({ config, scanner, logger });
  const audit = createMailAudit({ client });
  const notifications = createMailNotifications({ client, logger, preferencesReady: preferencesFeature.isReady });
  const preferences = createPreferencesService({ client, feature: preferencesFeature, audit, clock, logger });
  // GAP 8: a refused MAIL_MIXED_RECIPIENT_MODE is reported once; Mail keeps
  // the safe external-only behaviour.
  if (config.mixedRecipients?.refusedReason) logger.warn?.(`[Mail] MAIL_MIXED_RECIPIENT_MODE=${config.mixedRecipients.requestedMode} refused (${config.mixedRecipients.refusedReason}); sending stays external-only`);
  // GAP 8: features.finalGap gates provider Message-ID alias lookups.
  const store = createMessageStore({ client, storage, config, encryption: resolvedEncryption, features: { finalGap: finalGapFeature } });
  const searchIndex = createSearchIndex({ client, config, features, store, audit, logger, clock });
  store.useSearchIndex(searchIndex);
  const jobs = createMailJobRepository({ client, clock });
  const stepUp = createStepUpService({ client, config, clock, audit, mfa, authSchema, env, logger });
  // Gap 5: every object deletion goes through mail_storage_deletions (migration 37; inline before).
  const storageDeletions = createStorageDeletionService({ client, config, storage, audit, stepUp, feature: finalGapFeature, archiveFeature: features, clock, logger });
  store.useStorageDeletions(storageDeletions);
  const breakGlass = createBreakGlassService({ client, stepUp, audit, clock });
  const mailbox = createMailboxService({ client, config, store, audit, searchIndex });
  // M9: kill switch and usage/quota accounting shared by every send path.
  const runtime = createRuntimeControls({ config });
  // M10: database-backed rollout rules, cohorts and operator emergency stops.
  const rollout = createRolloutService({ client, config, audit, stepUp, clock });
  runtime.use(rollout.resolver);
  const usage = createUsageService({ client, audit, env, clock });
  const providerReady = () => resolvedAdapter.name !== "unconfigured";
  const compose = createComposeService({ client, config, store, encryption: resolvedEncryption, scanner: resolvedScanner, jobs, audit, notifications, preferences, providerReady, runtime, usage, deletions: storageDeletions, clock });
  const forwarding = createForwardingService({ client, config, features, store, jobs, audit, stepUp, notifications, providerReady, runtime, usage, clock, logger });
  const archive = createMessageArchive({ client, config, storage, features, audit, logger });
  const admin = createMailAdminService({ client, config, adapter: resolvedAdapter, audit, notifications, jobs, stepUp, forwarding, clock });
  const rules = createMailRulesService({ client, audit });
  const support = createSupportService({ client, mailboxService: mailbox, audit, notifications, encryption: resolvedEncryption, clock });
  // M7: per-brand marketing provider accounts, broadcasts and automation.
  const resolveMarketingProvider = createMarketingProviderResolver({ config, env, adapter: marketingAdapter, adapters: marketingAdapters, quotaObserver: providerQuota.observer });
  const marketingProviders = (organization) => metrics.instrumentProvider(withMarketingContract(resolveMarketingProvider(organization), sharedAccountGuards), "marketing");
  // Gaps 2/3: re-subscription workflow and pricing (503 before migration 37).
  const resubscriptions = createResubscriptionService({ client, config, env, features: finalGapFeature, audit, stepUp, jobs, marketingProviders, clock, logger });
  const pricing = createPricingService({ client, features: finalGapFeature, audit, stepUp, clock, logger });
  const confirmation = createConfirmationService({ client, config, audit, jobs, encryption: resolvedEncryption, marketingProviders, runtime, usage, resubscriptions, clock });
  // Gaps 1 + 7: one template policy (gated on migration 37) shared by every
  // marketing send path; preflight reads provider domain state through the
  // transactional adapter (read-only GET; UNKNOWN when unreachable).
  const templatePolicy = registerTemplatePolicy(client, createTemplatePolicy({ client, feature: finalGapFeature, logger }));
  const validateDomain = (providerDomainId) => resolvedAdapter.validateDomain(providerDomainId);
  // --- re-audit (marketing preflight) ----------------------------------------
  // Broadcasts and automations send with the brand's marketing key, which may
  // be another provider account: verify the domain there (adapter
  // getDomainByName), else report UNKNOWN. The offline fake provider is one
  // account for both. Quota state uses the scope of the account that sends.
  const marketingAccount = async (organizationId) => {
    const organization = await client.mailOrganization.findUnique({ where: { id: organizationId }, select: { id: true, slug: true } });
    const provider = marketingProviders(organization);
    if (typeof provider.getDomainByName === "function") return { separate: true, lookup: (name) => provider.getDomainByName(name) };
    if (config.provider === "fake") return { separate: false };
    return { separate: true, lookup: null, reason: provider.configured === false ? "MARKETING_PROVIDER_NOT_CONFIGURED" : "NO_DOMAIN_LOOKUP" };
  };
  const quotaState = async (organizationId) => {
    if (!(await providerQuota.ready())) return { status: "UNAVAILABLE", reason: "Provider quota is not available until the final gap-closure migration is applied" };
    const organization = await client.mailOrganization.findUnique({ where: { id: organizationId }, select: { slug: true } });
    if (config.provider === "fake") return providerQuota.snapshot("account", "fake");
    const { resolveBrandApiKey, quotaScopeFor } = require("./adapters/marketing");
    const scope = quotaScopeFor(organization.slug, resolveBrandApiKey(organization.slug, { env, config }).source);
    return scope ? providerQuota.snapshot(scope, "resend") : { status: "UNAVAILABLE", reason: "No marketing provider account is configured for this brand" };
  };
  registerDeliverability(client, { validateDomain, marketingAccount, quotaState });
  // --- end re-audit ------------------------------------------------------------
  const testSends = createTestSendService({ client, config, audit, jobs, marketingProviders, runtime, usage, clock, templatePolicy });
  const marketing = createMarketingService({ client, config, audit, stepUp, clock, templatePolicy, hooks: { onConfirmationRequired: confirmation.onConfirmationRequired, quotaCheck: (organizationId, count) => usage.check(organizationId, "MARKETING_BROADCAST", count), validateDomain } });
  // Gap 2: a verified double opt-in may open a provider re-subscription request.
  marketing.confirmConsent = confirmation.withResubscriptionHook(marketing.confirmConsent);
  const campaignReplies = createCampaignReplies({ client, config, features, audit, clock });
  const broadcasts = createBroadcastService({ client, config, audit, jobs, stepUp, env, replies: campaignReplies, pricing, providerQuota, clock });
  const automations = createAutomationService({ client, config, audit, stepUp, clock });
  // Final gap 4: test mode writes nothing but audit (works before migration
  // 37); replay needs marketing_automation_replays (503 before migration 37).
  const automationTests = createAutomationTestService({ client, config, audit, clock });
  const automationReplays = createAutomationReplayService({ client, config, audit, stepUp, jobs, feature: finalGapFeature, clock });
  const publicPreferences = createPublicPreferencesService({ client, config, audit, marketing, clock });
  const integrations = createIntegrationService({ client, config, audit, stepUp, automations, notifications, rollout, rateLimiter, env, clock, logger });
  // Re-audit fix 3: with migration 37 a rescan never releases (release is an IT quarantine decision).
  const attachmentReview = createAttachmentReviewService({ client, config, store, scanner: resolvedScanner, audit, feature: finalGapFeature });

  const inbound = createInboundProcessor({ client, config, adapter: resolvedAdapter, store, scanner: resolvedScanner, audit, notifications, jobs, usage, archive, forwarding, campaignReplies, senderAuth: loadSenderAuthPolicy(env), clock, logger });
  const outbound = createOutboundProcessor({ client, config, adapter: resolvedAdapter, store, audit, notifications, runtime, usage, forwarding, features: { finalGap: finalGapFeature }, clock });
  const marketingEvents = createMarketingEventsProcessor({ client, audit, resubscriptions, clock });
  const deliveryEvents = createDeliveryEventProcessor({ client, audit, notifications, marketingEvents, features: { finalGap: finalGapFeature } });
  const broadcastProcessor = createBroadcastProcessor({ client, config, audit, jobs, marketingProviders, eligibility: marketing.eligibleContacts, notifications, runtime, usage, resubscriptions, pricing, providerQuota, clock, logger });
  const automationProcessor = createAutomationProcessor({ client, config, audit, jobs, marketingProviders, eligibility: marketing.eligibleContacts, runtime, usage, clock, logger });

  const retention = createRetentionService({ client, config, audit, jobs, stepUp, clock });
  const retentionProcessor = createRetentionProcessor({ client, config, audit, storage, features, deletions: storageDeletions, clock, logger });
  const dsar = createDsarService({ client, audit, stepUp, storage, features, finalGap: finalGapFeature, deletions: storageDeletions, clock });
  // Gap 6: IT quarantine (list read-only before migration 37; actions 503).
  const quarantine = createQuarantineService({ client, audit, stepUp, feature: finalGapFeature, archiveFeature: features, deletions: storageDeletions, attachmentReview, notifications, clock, logger });
  // `health` is a hoisted function declaration below.
  const ops = createOpsMonitor({ client, config, notifications, health: () => health(), runtime, metrics, searchIndex, features, storageDeletions, clock, logger });
  const readiness = createReadiness({ client, config, ops, health: () => health() });
  const dependencyReadiness = createDependencyReadiness({ config, schema, encryption: resolvedEncryption, storage, scanner: resolvedScanner, provider: resolvedAdapter, jobs, infrastructureViolations, sessionAssessment: () => assessMailSession({ env, config }), clock: () => clock().getTime() });
  const inboundReconciler = createInboundReconciler({ client, config, adapter: resolvedAdapter, jobs, audit, clock });
  const deliveryStatusPoller = createDeliveryStatusPoller({ client, config, adapter: resolvedAdapter, audit, notifications, features: { finalGap: finalGapFeature }, clock, logger });

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
        // Gap 5: executes due storage deletions; continues while batches are full.
        STORAGE_DELETION_RUN: async () => {
          const result = await storageDeletions.processDue();
          if (result.claimed >= storageDeletions.settings.batchSize) return { defer: { seconds: 1, code: "STORAGE_DELETION_IN_PROGRESS" } };
          return result;
        },
        OPS_EVALUATE: ops.processEvaluate,
        RECONCILE_INBOUND: inboundReconciler.process,
        POLL_DELIVERY_STATUS: deliveryStatusPoller.process,
        MARKETING_TEST_SEND: testSends.process,
        // Gap 2: provider re-subscription retries.
        MARKETING_RESUBSCRIBE: resubscriptions.process,
        // Re-enqueues itself while more messages need (re)indexing.
        SEARCH_INDEX_BACKFILL: async () => {
          const result = await searchIndex.backfill();
          if (result.more) await jobs.enqueue(null, { queue: "EVENTS", kind: "SEARCH_INDEX_BACKFILL", idempotencyKey: `search-backfill:cont:${clock().getTime()}`, maxAttempts: 3 });
          return result;
        },
      },
      onDeadLetter: { SEND_MESSAGE: outbound.onDeadLetter, BROADCAST_DISPATCH: broadcastProcessor.onDeadLetter, BROADCAST_RECONCILE: broadcastProcessor.onDeadLetter, AUTOMATION_STEP: automationProcessor.onDeadLetter, RETENTION_RUN: retentionProcessor.onDeadLetter },
      // Non-retryable FAILED outbound jobs get the same terminal cleanup.
      onFailed: { SEND_MESSAGE: outbound.onTerminalFailure },
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
        // Inbound reconciliation (§10.8): one run per interval bucket.
        if (queues.includes("INBOUND") && config.receivingEnabled && config.reconciliation.enabled && config.inbound?.ownedHere !== false) {
          const bucket = Math.floor(clock().getTime() / (config.reconciliation.inboundIntervalSeconds * 1000));
          await once({ queue: "INBOUND", kind: "RECONCILE_INBOUND", idempotencyKey: `inbound-reconcile:${bucket}`, maxAttempts: 3 });
        }
        // Delivery status for a deployment that does not own the webhook: one
        // provider status poll per interval bucket.
        if (queues.includes("EVENTS") && config.deliveryPolling?.enabled) {
          const bucket = Math.floor(clock().getTime() / (config.deliveryPolling.intervalSeconds * 1000));
          await once({ queue: "EVENTS", kind: "POLL_DELIVERY_STATUS", idempotencyKey: `delivery-poll:${bucket}`, maxAttempts: 3 });
        }
        // M9: one ops evaluation per interval bucket across all EVENTS workers.
        // Gap 5: one storage deletion run per interval bucket, only when work is due.
        if (queues.includes("EVENTS") && (await storageDeletions.hasDue().catch(() => false))) {
          const bucket = Math.floor(clock().getTime() / (storageDeletions.settings.intervalSeconds * 1000));
          await once({ queue: "EVENTS", kind: "STORAGE_DELETION_RUN", idempotencyKey: `storage-deletion:${bucket}`, maxAttempts: 3 });
        }
        if (queues.includes("EVENTS") && config.ops.alertsEnabled) {
          const bucket = Math.floor(clock().getTime() / (config.ops.evaluateIntervalSeconds * 1000));
          await once({ queue: "EVENTS", kind: "OPS_EVALUATE", idempotencyKey: `ops-evaluate:${bucket}`, maxAttempts: 2 });
        }
      },
      schemaReady: schema.isReady,
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
      encryption: { available: resolvedEncryption.available, provider: keyProvider === "injected" ? "env" : keyProvider, keyVersions: resolvedEncryption.versions?.length ?? null, activeVersion: resolvedEncryption.activeVersion || null, error: resolvedEncryption.loadError || null },
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
    searchIndex,
    rateLimiter,
    jobs,
    services: { mailbox, compose, admin, rules, forwarding, archive, support, marketing, stepUp, breakGlass, attachmentReview, broadcasts, automations, automationTests, automationReplays, publicPreferences, confirmation, testSends, integrations, usage, retention, dsar, ops, rollout, readiness, preferences, storageDeletions, quarantine, resubscriptions, pricing, providerQuota },
    finalGapFeature,
    runtime,
    metrics,
    processors: { inbound, outbound, deliveryEvents, marketingEvents, broadcasts: broadcastProcessor, automations: automationProcessor, retention: retentionProcessor, inboundReconciler, deliveryStatusPoller },
    marketingProviders,
    webhookHandler: createResendWebhookHandler({ client, config, jobs, audit, logger, clock: () => clock().getTime(), env, schemaReady: schema.isReady }),
    brandWebhookHandler: createResendWebhookHandler({ client, config, jobs, audit, logger, clock: () => clock().getTime(), env, brandMode: true, schemaReady: schema.isReady }),
    // POST /api/mail/v1/integrations/v1/events (raw body, service HMAC).
    // Not acknowledged while the schema is missing: the product retries.
    integrationHandler: async (req, res) => {
      if (config.enabled && config.integrations.enabled && !(await schema.isReady())) {
        return res.status(503).json({ success: false, code: "MAIL_SCHEMA_NOT_READY", retryable: true, message: "Mail is not ready" });
      }
      const result = await integrations.ingest(req);
      res.status(result.status).json(result.body);
    },
    createWorker,
    health,
    schema,
    features,
    preferencesFeature,
    // Public readiness (booleans only; never secrets or migration names).
    // §20: dependency-specific; a disabled Mail is reported DISABLED, never
    // "ready"; §17.1: the session mode is reported and, when required, gates.
    readiness: async () => {
      const state = await dependencyReadiness.evaluate();
      if (state.enabled && state.session?.status === "BLOCKING") return { ...state, ready: false, state: "NOT_READY" };
      return state;
    },
    ready: () => keyringReady,
  };
}

module.exports = { createMailApplication };
