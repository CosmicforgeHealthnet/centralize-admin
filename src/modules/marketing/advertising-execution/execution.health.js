const { readExecutionConfig } = require("./execution.config");
const { sanitizeExecutionEvent } = require("./execution.observability");
const { createExecutionSchemaAssertion } = require("./execution-schema-assertion.service");

const FAILURE_CATEGORIES = new Set(["DATABASE", "SCHEMA", "CAPABILITY", "PROVIDER_PERMISSION", "PROVIDER_RATE_LIMIT", "WORKER", "RECONCILIATION", "AUDIT", "NOTIFICATION", "METRICS"]);
function functional(value, method) { return Boolean(value && typeof value[method] === "function"); }
function boundedFailure(value) { const category = String(value || "").toUpperCase(); return FAILURE_CATEGORIES.has(category) ? category : null; }

function createExecutionHealthService({ app, env = process.env, schemaAssertion = createExecutionSchemaAssertion({ client: app?.client }) } = {}) {
  async function snapshot(context = {}) {
    const config = readExecutionConfig(env);
    const schema = await schemaAssertion.inspect();
    let databaseReady = schema.category !== "DATABASE"; let queueDepth = null; let oldestPendingJobAgeSeconds = null; let reconciliationQueueDepth = null; let oldestReconciliationAgeSeconds = null;
    try {
      const [pendingJobs, oldestJob, reconciliationJobs, oldestReconciliation] = await Promise.all([
        app.client.marketingExecutionJob.count({ where: { status: { in: ["PENDING", "RETRY_SCHEDULED"] } } }),
        app.client.marketingExecutionJob.findFirst({ where: { status: { in: ["PENDING", "RETRY_SCHEDULED"] } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
        app.client.marketingExecutionReconciliationJob.count({ where: { status: { in: ["PENDING", "RETRY_SCHEDULED"] } } }),
        app.client.marketingExecutionReconciliationJob.findFirst({ where: { status: { in: ["PENDING", "RETRY_SCHEDULED"] } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
      ]);
      queueDepth = pendingJobs; reconciliationQueueDepth = reconciliationJobs;
      oldestPendingJobAgeSeconds = oldestJob ? Math.max(0, Math.floor((Date.now() - oldestJob.createdAt.getTime()) / 1000)) : 0;
      oldestReconciliationAgeSeconds = oldestReconciliation ? Math.max(0, Math.floor((Date.now() - oldestReconciliation.createdAt.getTime()) / 1000)) : 0;
    } catch (_error) { databaseReady = false; }
    const executionWorkerRunning = app.executionWorker?.isStarted?.() === true;
    const reconciliationWorkerRunning = app.reconciliationWorker?.isStarted?.() === true;
    const providers = app.adapterRegistry.capabilities().map((provider) => ({ provider: provider.provider, apiVersion: provider.apiVersion, configured: provider.configurationReady === true || provider.configured === true, writeEnabled: config.enabled && config.providers[provider.provider], blockers: provider.configurationReady === true || provider.configured === true ? [] : ["PROVIDER_NOT_CONFIGURED"] }));
    let accountReadiness = null;
    if (context.connectionId && context.provider) {
      const connection = await app.client.marketing_ad_platform_connections.findFirst({ where: { id: context.connectionId, platform: context.provider }, select: { id: true, platform: true, accountId: true, accessToken: true, encryptedCredentials: true, status: true, requiresReauthorization: true, validationStatus: true, lastConnectionTestAt: true, lastSuccessfulFetchAt: true, sanitizedValidationError: true } });
      const gate = connection ? await app.connectionPolicyResolver({ platform: connection.platform, connectionId: connection.id, accountExternalId: connection.accountId }) : false;
      const failure = boundedFailure(connection?.sanitizedValidationError?.split(":")[0]);
      accountReadiness = { provider: context.provider, apiVersion: providers.find((item) => item.provider === context.provider)?.apiVersion || null, connectionExists: Boolean(connection), credentialPresent: Boolean(connection?.accessToken || connection?.encryptedCredentials), readCapability: connection?.status === "ACTIVE" && !connection?.requiresReauthorization, writeCapability: Boolean(connection && config.enabled && config.providers[context.provider] && gate), effectiveConnectionWriteGate: gate, lastSuccessfulCapabilityCheck: connection?.lastConnectionTestAt || connection?.lastSuccessfulFetchAt || null, recentFailureCategory: failure, reviewDiscoveryReady: Boolean(connection && connection.validationStatus !== "FAILED") };
    }
    const adapters = { metrics: { registered: Boolean(app.metrics), functional: functional(app.metrics, "increment") && functional(app.metrics, "snapshot"), recentFailureCategory: null }, audit: { registered: Boolean(app.audit), functional: functional(app.audit, "event"), recentFailureCategory: null }, notification: { registered: Boolean(app.events), functional: functional(app.events, "emit"), recentFailureCategory: null }, realtime: { registered: Boolean(app.events), functional: functional(app.events, "emit"), recentFailureCategory: null } };
    const state = !databaseReady || !schema.ready ? "unavailable" : !config.enabled ? "disabled" : config.workerEnabled && !executionWorkerRunning ? "degraded" : "ready";
    return sanitizeExecutionEvent({ state, ready: databaseReady && schema.ready && ["ready", "disabled"].includes(state), moduleRegistered: true, masterEnabled: config.enabled, dryRun: config.dryRun, recentFailureCategories: [schema.category, !databaseReady ? "DATABASE" : null, config.workerEnabled && !executionWorkerRunning ? "WORKER" : null].filter(Boolean), worker: { enabled: config.workerEnabled, registered: Boolean(app.executionWorker), running: executionWorkerRunning }, reconciliationWorker: { enabled: config.reconciliationWorkerEnabled, registered: Boolean(app.reconciliationWorker), running: reconciliationWorkerRunning }, queue: { depth: queueDepth, oldestPendingAgeSeconds: oldestPendingJobAgeSeconds }, reconciliationQueue: { depth: reconciliationQueueDepth, oldestPendingAgeSeconds: oldestReconciliationAgeSeconds }, providers, accountReadiness, database: { ready: databaseReady, schemaAssertion: schema }, adapters });
  }
  return Object.freeze({ snapshot, invalidateSchemaCache: schemaAssertion.invalidate });
}

module.exports = { FAILURE_CATEGORIES, boundedFailure, createExecutionHealthService };
