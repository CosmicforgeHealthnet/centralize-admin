const { prisma } = require("../../../shared/config/database");
const { resolveStoredCredentials } = require("../intelligence/utils/credential-envelope");
const { readExecutionConfig } = require("./execution.config");
const { executionError } = require("./execution.errors");
const { createAuditAdapter } = require("./integrations/audit.adapter");
const { createExecutionEventsAdapter } = require("./integrations/execution-events.adapter");
const { createExecutionMetrics } = require("./execution.observability");
const { PolicyRepository } = require("./policy/policy.repository");
const { CreativePublicationRepository } = require("./creatives/creative-publication.repository");
const { createCreativePublicationService } = require("./creatives/creative-publication.service");
const { createMalwareScanner } = require("./creatives/malware-scanner.adapter");
const { createProviderReviewSyncService } = require("./creatives/provider-review-sync.service");
const { createProviderReadRegistry } = require("./targeting/provider-read-adapter.registry");
const { TargetingDiscoveryRepository } = require("./targeting/targeting-discovery.repository");
const { createTargetingDiscoveryService } = require("./targeting/targeting-discovery.service");
const { createExecutionAdapterRegistry } = require("./adapters/execution-adapter.registry");
const { createCapabilityDiscoveryService } = require("./capabilities/capability-discovery.service");
const { createProductionValidators } = require("./validation/production-validation.service");
const { runValidationPipeline } = require("./validation/execution-validation-pipeline");
const { ExecutionRunRepository } = require("./runs/execution-run.repository");
const { ExecutionJobRepository } = require("./jobs/execution-job.repository");
const { AccountLockRepository } = require("./jobs/account-lock.repository");
const { OperationRepository } = require("./operations/operation.repository");
const { ReconciliationRepository } = require("./reconciliation/reconciliation.repository");
const { createReconciliationService } = require("./reconciliation/reconciliation.service");
const { createFinalMutationGate } = require("./validation/final-mutation-gate.service");
const { createOperationRunner } = require("./operations/operation-runner.service");
const { createExecutionWorker } = require("./jobs/execution-worker");
const { createReconciliationWorker } = require("./jobs/reconciliation-worker");
const { createRecommendationExecutionBridge } = require("./recommendations/recommendation-execution-bridge.service");
const { createExecutionQueueService } = require("./jobs/execution-queue.service");
const { createDeadLetterReviewService } = require("./jobs/dead-letter-review.service");
const { createKillSwitchService } = require("./policy/kill-switch.service");
const { createRetryReviewService } = require("./operations/retry-review.service");
const { createEmergencyOverrideService } = require("./policy/emergency-override.service");
const notificationService = require("../../notifications/notifications.service");

function createAdvertisingExecutionApplication({ env = process.env, client = prisma, providerClients = {}, httpClient, realtime } = {}) {
  const audit = createAuditAdapter({ client }); const metrics = createExecutionMetrics();
  const events = createExecutionEventsAdapter({ realtime, metrics, notificationService: { createNotification: async (payload) => { try { return await notificationService.createNotificationWithClient(client, payload); } catch (_error) { return null; } } } }); const policyRepository = new PolicyRepository({ client });
  const connectionPolicyResolver = async ({ platform, connectionId }) => {
    const policy = await policyRepository.resolveEffective({ key: "execution.write.enabled", platform, connectionId });
    return policy?.enabled === true && policy.value === true;
  };
  const providerReadRegistry = createProviderReadRegistry({ env, clients: { ...providerClients.read, ...(httpClient ? { httpClient } : {}) }, connectionLoader: (id) => client.marketing_ad_platform_connections.findUnique({ where: { id } }) });
  const targetingRepository = new TargetingDiscoveryRepository({ client });
  const targetingDiscoveryService = createTargetingDiscoveryService({ client, repository: targetingRepository, providerReadRegistry, events });
  const creativeRepository = new CreativePublicationRepository({ client });
  const malwareScanner = createMalwareScanner({ endpoint: env.MARKETING_AD_MALWARE_SCANNER_URL, allowedHosts: String(env.MARKETING_AD_MALWARE_SCANNER_ALLOWED_HOSTS || "").split(",").map((item) => item.trim()).filter(Boolean), apiKey: env.MARKETING_AD_MALWARE_SCANNER_API_KEY, httpClient });
  const creativeService = createCreativePublicationService({ client, repository: creativeRepository, malwareScanner, audit, events, metrics });
  const reviewSyncService = createProviderReviewSyncService({ repository: creativeRepository, providerReadRegistry, audit, events });
  const adapterRegistry = createExecutionAdapterRegistry({ env, dependencies: {
    clientFactories: providerClients.write || {}, credentialResolver: resolveStoredCredentials,
    targetingResolver: (scope) => targetingDiscoveryService.resolve(scope),
    creativePublicationResolver: (id) => creativeRepository.findById(id), allowProviderValidation: true,
  } });
  const capabilityDiscovery = createCapabilityDiscoveryService({ client, env, registry: adapterRegistry });
  const validators = createProductionValidators({ adapterRegistry, providerReadRegistry, targetingDiscoveryService, connectionPolicyResolver });
  const validationPipeline = (input, options) => runValidationPipeline(input, validators, options);
  const runRepository = new ExecutionRunRepository({ client }); const jobRepository = new ExecutionJobRepository({ client });
  const accountLockRepository = new AccountLockRepository({ client }); const operationRepository = new OperationRepository({ client });
  const reconciliationRepository = new ReconciliationRepository({ client });
  const reconciliationService = createReconciliationService({ client, audit, events });
  const finalMutationGate = createFinalMutationGate({ env, connectionPolicyResolver, accountLockRepository, jobRepository });
  const operationRunner = createOperationRunner({ operationRepository, adapterResolver: ({ provider }) => adapterRegistry.get(provider), providerReadRegistry, finalMutationGate, reconciliationRepository, audit, events, metrics });
  const executionWorker = createExecutionWorker({ env, jobRepository, accountLockRepository, connectionGate: connectionPolicyResolver, executeBundle: operationRunner.run, recoverExpiredLeases: async () => { const recovered = await jobRepository.recoverExpiredLeases({ reconciliationRepository, audit }); for (const job of recovered) await events.emit("LEASE_RECOVERED", { jobId: job.id, recoveryOutcome: job.recoveryOutcome }); return recovered; }, audit, events, metrics });
  const reconciliationEnabled = readExecutionConfig(env).reconciliationWorkerEnabled;
  const reconciliationWorker = createReconciliationWorker({ enabled: reconciliationEnabled, repository: reconciliationRepository, reconciliationService, providerReadRegistry, events });
  const recommendationBridge = createRecommendationExecutionBridge({ client, capabilityResolver: (scope) => capabilityDiscovery.resolve(scope), liveStateResolver: ({ recommendation, connection }) => providerReadRegistry.resolve(recommendation.platform).readResource({ recommendation, connection, mutation: false }), audit, events });
  const queueService = createExecutionQueueService({ client, audit, events, metrics });
  const deadLetterReviewService = createDeadLetterReviewService({ client, jobRepository, reconciliationRepository, reconciliationService, audit, events });
  const killSwitchService = createKillSwitchService({ client, policyRepository, audit, events, metrics });
  const retryReviewService = createRetryReviewService({ client, env, adapterRegistry, providerReadRegistry, connectionPolicyResolver, audit, events, metrics });
  const emergencyOverrideService = createEmergencyOverrideService({ client, events });

  function startWorkers() {
    const config = readExecutionConfig(env); const enabledProviders = Object.entries(config.providers).filter(([, enabled]) => enabled).map(([provider]) => provider);
    if (config.workerEnabled && !config.dryRun) {
      for (const provider of enabledProviders) if (typeof providerClients.write?.[provider] !== "function") throw executionError("INVALID_EXECUTION_CONFIG", { reasonCode: "PROVIDER_WRITE_CLIENT_FACTORY_REQUIRED", provider });
      executionWorker.start();
    }
    if (reconciliationEnabled) reconciliationWorker.start();
    return { executionWorkerStarted: executionWorker.isStarted(), reconciliationWorkerStarted: reconciliationWorker.isStarted() };
  }
  async function shutdownWorkers() { return { execution: await executionWorker.shutdown(), reconciliation: await reconciliationWorker.shutdown() }; }
  return Object.freeze({ client, audit, events, metrics, creativeService, creativeRepository, reviewSyncService, targetingDiscoveryService, providerReadRegistry, adapterRegistry, capabilityDiscovery, validationPipeline, recommendationBridge, queueService, retryReviewService, emergencyOverrideService, jobRepository, runRepository, operationRepository, reconciliationRepository, reconciliationService, deadLetterReviewService, killSwitchService, executionWorker, reconciliationWorker, connectionPolicyResolver, startWorkers, shutdownWorkers });
}
module.exports = { createAdvertisingExecutionApplication };
