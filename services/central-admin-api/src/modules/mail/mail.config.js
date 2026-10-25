"use strict";

// Centralised, validated Mail configuration. Every live capability defaults to
// OFF. Secrets are read here only and never exposed through the API.

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function flag(value) {
  return TRUE_VALUES.has(String(value ?? "").trim().toLowerCase());
}

function intInRange(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function list(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

const DEPLOYMENT_ENVIRONMENTS = new Set(["development", "test", "staging", "production"]);
// Tokens that must appear in bucket names / KMS aliases for each environment
// (and must not appear for the other one) so staging can never point at
// production storage or keys and vice versa.
const ENVIRONMENT_MARKERS = Object.freeze({ staging: ["staging", "stg"], production: ["production", "prod"] });

function deploymentEnvironment(env) {
  const declared = String(env.MAIL_DEPLOYMENT_ENV || "").trim().toLowerCase();
  if (DEPLOYMENT_ENVIRONMENTS.has(declared)) return declared;
  // Undeclared + NODE_ENV=production is treated as production (strictest).
  if (String(env.NODE_ENV || "").toLowerCase() === "production") return "production";
  return String(env.NODE_ENV || "").toLowerCase() === "test" ? "test" : "development";
}

function loadMailConfig(env = process.env) {
  const enabled = flag(env.MAIL_ENABLED);
  const config = {
    deploymentEnvironment: deploymentEnvironment(env),
    enabled,
    sendingEnabled: enabled && flag(env.MAIL_SENDING_ENABLED),
    receivingEnabled: enabled && flag(env.MAIL_RECEIVING_ENABLED),
    marketingEnabled: enabled && flag(env.MAIL_MARKETING_ENABLED),
    workerEnabled: enabled && flag(env.MAIL_WORKER_ENABLED),
    provider: String(env.MAIL_PROVIDER || "resend").trim().toLowerCase(),
    domainAllowlist: list(env.MAIL_DOMAIN_ALLOWLIST),
    resend: {
      apiKey: String(env.RESEND_API_KEY || ""),
      webhookSecret: String(env.RESEND_WEBHOOK_SECRET || ""),
      baseUrl: String(env.RESEND_API_BASE_URL || "https://api.resend.com").replace(/\/+$/, ""),
      timeoutMs: intInRange(env.RESEND_TIMEOUT_MS, 15000, 1000, 60000),
      attachmentHostAllowlist: list(
        env.RESEND_ATTACHMENT_HOST_ALLOWLIST || "resend.com,resend.app,resend-attachments.com",
      ),
    },
    webhook: {
      toleranceSeconds: intInRange(env.MAIL_WEBHOOK_TOLERANCE_SECONDS, 300, 30, 900),
      maxBodyBytes: intInRange(env.MAIL_WEBHOOK_MAX_BODY_BYTES, 262144, 1024, 1048576),
    },
    storage: {
      provider: String(env.MAIL_STORAGE_PROVIDER || "unavailable").trim().toLowerCase(),
      localDirectory: String(env.MAIL_STORAGE_LOCAL_DIR || ""),
      s3: {
        endpoint: String(env.MAIL_S3_ENDPOINT || ""),
        region: String(env.MAIL_S3_REGION || "us-east-1"),
        bucket: String(env.MAIL_S3_BUCKET || ""),
        prefix: String(env.MAIL_S3_PREFIX || "mail"),
        forcePathStyle: String(env.MAIL_S3_FORCE_PATH_STYLE ?? "true").toLowerCase() !== "false",
        accessKeyId: String(env.MAIL_S3_ACCESS_KEY_ID || ""),
        secretAccessKey: String(env.MAIL_S3_SECRET_ACCESS_KEY || ""),
        sessionToken: String(env.MAIL_S3_SESSION_TOKEN || ""),
        sse: String(env.MAIL_S3_SSE || "").trim().toUpperCase(),
        sseKmsKeyId: String(env.MAIL_S3_SSE_KMS_KEY_ID || ""),
        sendPrivateAcl: String(env.MAIL_S3_SEND_PRIVATE_ACL ?? "true").toLowerCase() !== "false",
        conditionalWrites: String(env.MAIL_S3_CONDITIONAL_WRITES ?? "true").toLowerCase() !== "false",
        checksumHeader: String(env.MAIL_S3_CHECKSUM_HEADER ?? "true").toLowerCase() !== "false",
        timeoutMs: intInRange(env.MAIL_S3_TIMEOUT_MS, 10000, 1000, 60000),
        maxRetries: intInRange(env.MAIL_S3_MAX_RETRIES, 2, 0, 5),
        healthCacheMs: intInRange(env.MAIL_S3_HEALTH_CACHE_MS, 60000, 0, 3600000),
        healthCanary: String(env.MAIL_S3_HEALTH_CANARY ?? "true").toLowerCase() !== "false",
      },
    },
    kms: {
      provider: String(env.MAIL_KMS_PROVIDER || "env").trim().toLowerCase(),
      region: String(env.MAIL_KMS_REGION || env.MAIL_S3_REGION || "us-east-1"),
      endpoint: String(env.MAIL_KMS_ENDPOINT || ""),
      keyId: String(env.MAIL_KMS_KEY_ID || ""),
      keyEnvironment: String(env.MAIL_KMS_KEY_ENVIRONMENT || "").trim().toLowerCase(),
      accessKeyId: String(env.MAIL_KMS_ACCESS_KEY_ID || env.MAIL_S3_ACCESS_KEY_ID || ""),
      secretAccessKey: String(env.MAIL_KMS_SECRET_ACCESS_KEY || env.MAIL_S3_SECRET_ACCESS_KEY || ""),
      sessionToken: String(env.MAIL_KMS_SESSION_TOKEN || ""),
      timeoutMs: intInRange(env.MAIL_KMS_TIMEOUT_MS, 5000, 1000, 30000),
    },
    encryption: {
      // Format: "v1:<base64 32 bytes>,v2:<base64 32 bytes>"; active = MAIL_ENCRYPTION_ACTIVE_KEY
      keys: String(env.MAIL_ENCRYPTION_KEYS || ""),
      activeKey: String(env.MAIL_ENCRYPTION_ACTIVE_KEY || ""),
    },
    scanning: {
      provider: String(env.MAIL_SCANNER_PROVIDER || "unavailable").trim().toLowerCase(),
      clamdHost: String(env.MAIL_CLAMD_HOST || "127.0.0.1"),
      clamdPort: intInRange(env.MAIL_CLAMD_PORT, 3310, 1, 65535),
      timeoutMs: intInRange(env.MAIL_SCANNER_TIMEOUT_MS, 15000, 1000, 120000),
      connectTimeoutMs: intInRange(env.MAIL_SCANNER_CONNECT_TIMEOUT_MS, 3000, 200, 30000),
      // Must not exceed clamd's StreamMaxLength (default 25M in the provided
      // clamd.conf). Larger attachments are quarantined without scanning.
      maxStreamBytes: intInRange(env.MAIL_SCANNER_MAX_STREAM_BYTES, 25 * 1024 * 1024, 1024, 100 * 1024 * 1024),
      healthCacheMs: intInRange(env.MAIL_SCANNER_HEALTH_CACHE_MS, 30000, 0, 600000),
    },
    limits: {
      attachmentMaxBytes: intInRange(env.MAIL_ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024, 1024, 25 * 1024 * 1024),
      messageMaxBytes: intInRange(env.MAIL_MESSAGE_MAX_BYTES, 25 * 1024 * 1024, 1024, 40 * 1024 * 1024),
      maxAttachmentsPerMessage: intInRange(env.MAIL_MAX_ATTACHMENTS, 10, 1, 50),
      // Resend accepts at most 50 addresses per field; keep the total within it.
      maxRecipients: intInRange(env.MAIL_MAX_RECIPIENTS, 50, 1, 50),
      bodyMaxBytes: intInRange(env.MAIL_BODY_MAX_BYTES, 1024 * 1024, 1024, 5 * 1024 * 1024),
      sendsPerMinutePerUser: intInRange(env.MAIL_SENDS_PER_MINUTE_PER_USER, 20, 1, 600),
      csvImportMaxRows: intInRange(env.MAIL_MARKETING_CSV_MAX_ROWS, 5000, 1, 50000),
    },
    search: {
      // Body search is intentionally unavailable: bodies are stored only as
      // ciphertext. There is no flag that turns plaintext body indexing on;
      // a legacy MAIL_SEARCH_INDEX_BODIES=true is refused and reported.
      bodies: false,
      bodyIndexingRequestRefused: flag(env.MAIL_SEARCH_INDEX_BODIES),
    },
    archive: {
      storeRawMime: flag(env.MAIL_ARCHIVE_RAW_MIME),
    },
    reconciliation: {
      enabled: flag(env.MAIL_RECONCILIATION_ENABLED),
      // Resend keeps idempotency keys for 24h. A send whose first attempt is
      // older than this window is never retried; it becomes OUTCOME_UNKNOWN.
      idempotencyWindowHours: intInRange(env.MAIL_PROVIDER_IDEMPOTENCY_WINDOW_HOURS, 23, 1, 23),
    },
    worker: {
      pollIntervalMs: intInRange(env.MAIL_WORKER_POLL_INTERVAL_MS, 2000, 200, 60000),
      concurrency: intInRange(env.MAIL_WORKER_CONCURRENCY, 4, 1, 32),
      leaseSeconds: intInRange(env.MAIL_WORKER_LEASE_SECONDS, 120, 15, 900),
      maxAttempts: intInRange(env.MAIL_WORKER_MAX_ATTEMPTS, 6, 1, 20),
    },
    unknownRecipientPolicy:
      String(env.MAIL_UNKNOWN_RECIPIENT_POLICY || "reject").trim().toLowerCase() === "quarantine"
        ? "quarantine"
        : "reject",
    stepUpTtlSeconds: intInRange(env.MAIL_STEP_UP_TTL_SECONDS, 300, 60, 900),
    publicAppUrl: String(env.MAIL_PUBLIC_APP_URL || env.FRONTEND_URL || ""),
    // Public base for unsubscribe / preference links (the API origin).
    publicApiUrl: String(env.MAIL_PUBLIC_API_URL || "").replace(/\/+$/, ""),
    // M7: each live capability has its own flag and requires Mail + Marketing.
    broadcastDispatchEnabled: enabled && flag(env.MAIL_MARKETING_ENABLED) && flag(env.MAIL_BROADCAST_DISPATCH_ENABLED),
    automationEnabled: enabled && flag(env.MAIL_MARKETING_ENABLED) && flag(env.MAIL_AUTOMATION_ENABLED),
    confirmationEmailsEnabled: enabled && flag(env.MAIL_MARKETING_ENABLED) && flag(env.MAIL_MARKETING_CONFIRMATION_EMAILS_ENABLED),
    // Queues served by this worker process. MARKETING is opt-in so the
    // transactional worker never runs marketing jobs unless deployed to.
    workerQueues: (() => {
      const requested = list(env.MAIL_WORKER_QUEUES || "outbound,inbound,events").map((entry) => entry.toUpperCase());
      return requested.filter((entry) => ["OUTBOUND", "INBOUND", "EVENTS", "MARKETING"].includes(entry));
    })(),
    broadcast: {
      // Hard ceiling regardless of brand settings.
      maxRecipients: intInRange(env.MAIL_BROADCAST_MAX_RECIPIENTS, 1000, 1, 100000),
      providerRequestsPerSecond: intInRange(env.MAIL_BROADCAST_PROVIDER_RPS, 5, 1, 10),
      syncBatchSize: intInRange(env.MAIL_BROADCAST_SYNC_BATCH, 100, 10, 1000),
      approvalTtlDays: intInRange(env.MAIL_CAMPAIGN_APPROVAL_TTL_DAYS, 14, 1, 90),
      reconcileIntervalSeconds: intInRange(env.MAIL_BROADCAST_RECONCILE_SECONDS, 60, 10, 3600),
      reconcileMaxHours: intInRange(env.MAIL_BROADCAST_RECONCILE_MAX_HOURS, 48, 1, 168),
      allowSharedProviderAccount: flag(env.MAIL_BROADCAST_ALLOW_SHARED_PROVIDER_ACCOUNT),
      minLeadSeconds: intInRange(env.MAIL_BROADCAST_MIN_LEAD_SECONDS, 300, 0, 86400),
    },
    automation: {
      tickBatch: intInRange(env.MAIL_AUTOMATION_TICK_BATCH, 100, 1, 1000),
      maxStepsPerEnrollment: intInRange(env.MAIL_AUTOMATION_MAX_STEPS, 50, 5, 200),
      scheduleMaxEnrollmentsPerRun: intInRange(env.MAIL_AUTOMATION_SCHEDULE_MAX_PER_RUN, 1000, 1, 50000),
    },
    unsubscribe: {
      secret: String(env.MAIL_MARKETING_UNSUBSCRIBE_SECRET || ""),
      previousSecret: String(env.MAIL_MARKETING_UNSUBSCRIBE_PREVIOUS_SECRET || ""),
    },
    // M8 product integrations (service-to-service, HMAC; secrets in env only).
    integrations: {
      enabled: enabled && flag(env.MAIL_INTEGRATIONS_ENABLED),
      hashSecret: String(env.MAIL_INTEGRATION_HASH_SECRET || ""),
      maxSkewSeconds: intInRange(env.MAIL_INTEGRATION_MAX_SKEW_SECONDS, 300, 30, 900),
      ratePerMinute: intInRange(env.MAIL_INTEGRATION_RATE_PER_MINUTE, 600, 10, 100000),
      maxBodyBytes: intInRange(env.MAIL_INTEGRATION_MAX_BODY_BYTES, 16384, 1024, 262144),
    },
    // M9 retention. Execution (destructive) is OFF by default; dry runs are
    // always available to mail admins. No retention durations are defaulted:
    // system categories are purgeable only when an operator sets a period.
    retention: {
      executionEnabled: enabled && flag(env.MAIL_RETENTION_EXECUTION_ENABLED),
      batchSize: intInRange(env.MAIL_RETENTION_BATCH_SIZE, 100, 1, 1000),
      dryRunValidHours: intInRange(env.MAIL_RETENTION_DRY_RUN_VALID_HOURS, 24, 1, 168),
      systemDays: {
        WEBHOOK_PAYLOADS: optionalDays(env.MAIL_RETENTION_WEBHOOK_PAYLOAD_DAYS),
        INTEGRATION_EVENTS: optionalDays(env.MAIL_RETENTION_INTEGRATION_EVENT_DAYS),
        PRODUCT_DELIVERY_EVENTS: optionalDays(env.MAIL_RETENTION_PRODUCT_DELIVERY_EVENT_DAYS),
      },
    },
    // M9 operations: alert evaluation and the token-protected metrics endpoint.
    ops: {
      alertsEnabled: env.MAIL_OPS_ALERTS_ENABLED === undefined ? true : flag(env.MAIL_OPS_ALERTS_ENABLED),
      evaluateIntervalSeconds: intInRange(env.MAIL_OPS_EVALUATE_SECONDS, 300, 60, 3600),
      metricsToken: String(env.MAIL_METRICS_TOKEN || ""),
      // Initial thresholds; tune from pilot observations (no stability data yet).
      thresholds: {
        queueOldestPendingSeconds: intInRange(env.MAIL_ALERT_QUEUE_OLDEST_SECONDS, 900, 60, 86400),
        deadLetters24h: intInRange(env.MAIL_ALERT_DEAD_LETTERS_24H, 1, 1, 100000),
        webhookBacklogSeconds: intInRange(env.MAIL_ALERT_WEBHOOK_BACKLOG_SECONDS, 600, 60, 86400),
        scanBacklogSeconds: intInRange(env.MAIL_ALERT_SCAN_BACKLOG_SECONDS, 1800, 60, 86400),
        outcomeUnknown24h: intInRange(env.MAIL_ALERT_OUTCOME_UNKNOWN_24H, 1, 1, 100000),
        bounceRatePercent: intInRange(env.MAIL_ALERT_BOUNCE_RATE_PERCENT, 5, 1, 100),
        complaintRatePerThousand: intInRange(env.MAIL_ALERT_COMPLAINT_RATE_PER_THOUSAND, 1, 1, 1000),
        minSampleForRates: intInRange(env.MAIL_ALERT_MIN_SAMPLE, 100, 1, 100000),
        integrationRejections1h: intInRange(env.MAIL_ALERT_INTEGRATION_REJECTIONS_1H, 20, 1, 100000),
      },
    },
    // Emergency stop (M9/M10). Blocks provider calls without deleting queued records.
    emergencyStop: {
      all: flag(env.MAIL_EMERGENCY_STOP_ALL),
      marketing: flag(env.MAIL_EMERGENCY_STOP_ALL) || flag(env.MAIL_EMERGENCY_STOP_MARKETING),
    },
  };
  return Object.freeze(config);
}

function optionalDays(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= 36500 ? days : null;
}

function hostIsLocal(url) {
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function markerCheck(value, environment, label) {
  const own = ENVIRONMENT_MARKERS[environment];
  if (!own) return [];
  const other = ENVIRONMENT_MARKERS[environment === "staging" ? "production" : "staging"];
  const tokens = String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const problems = [];
  if (!tokens.some((token) => own.includes(token))) problems.push(`${label} must carry the ${environment} marker (${own.join("/")})`);
  if (tokens.some((token) => other.includes(token))) problems.push(`${label} carries another environment's marker`);
  return problems;
}

/**
 * Deployment-safety rules for storage, keys and scanning. Any violation makes
 * private storage unavailable (fail closed). Staging and production must use
 * distinct, marked buckets and KMS keys.
 */
function infrastructureViolations(config) {
  const environment = config.deploymentEnvironment;
  const problems = [];
  const storage = config.storage;
  const strict = environment === "production" || environment === "staging";
  if (environment === "production") {
    if (storage.provider !== "s3") problems.push("production requires MAIL_STORAGE_PROVIDER=s3");
    if (config.kms.provider !== "aws-kms") problems.push("production requires MAIL_KMS_PROVIDER=aws-kms");
    if (config.scanning.provider !== "clamd") problems.push("production requires MAIL_SCANNER_PROVIDER=clamd");
  }
  if (strict && storage.provider === "memory") problems.push(`${environment} refuses memory storage`);
  if (storage.provider === "s3") {
    const endpoint = storage.s3.endpoint;
    if (endpoint && !/^https:\/\//i.test(endpoint) && !(hostIsLocal(endpoint) && !strict)) problems.push("MAIL_S3_ENDPOINT must use https");
    if (strict) problems.push(...markerCheck(storage.s3.bucket, environment, "MAIL_S3_BUCKET"));
    if (environment === "production" && !storage.s3.sse) problems.push("production requires MAIL_S3_SSE (AES256 or AWS:KMS)");
  }
  if (!["env", "aws-kms"].includes(config.kms.provider)) problems.push("MAIL_KMS_PROVIDER must be env or aws-kms");
  if (config.kms.provider === "aws-kms") {
    if (!config.kms.keyId) problems.push("MAIL_KMS_KEY_ID is required with aws-kms");
    if (config.kms.endpoint && !/^https:\/\//i.test(config.kms.endpoint) && !(hostIsLocal(config.kms.endpoint) && !strict)) problems.push("MAIL_KMS_ENDPOINT must use https");
    if (strict && config.kms.keyId) {
      if (/^alias\//.test(config.kms.keyId) || /:alias\//.test(config.kms.keyId)) problems.push(...markerCheck(config.kms.keyId.split("alias/").pop(), environment, "MAIL_KMS_KEY_ID alias"));
      else if (config.kms.keyEnvironment !== environment) problems.push(`MAIL_KMS_KEY_ENVIRONMENT must be declared as ${environment} for a key ARN/id`);
    }
  }
  return problems;
}

function providerConfigured(config) {
  return config.provider === "resend" && Boolean(config.resend.apiKey);
}

function publicStatus(config) {
  return {
    enabled: config.enabled,
    sendingEnabled: config.sendingEnabled,
    receivingEnabled: config.receivingEnabled,
    marketingEnabled: config.marketingEnabled,
    workerEnabled: config.workerEnabled,
    provider: config.provider,
    providerConfigured: providerConfigured(config),
    webhookSecretConfigured: Boolean(config.resend.webhookSecret),
    storageProvider: config.storage.provider,
    scannerProvider: config.scanning.provider,
    kmsProvider: config.kms.provider,
    deploymentEnvironment: config.deploymentEnvironment,
    unknownRecipientPolicy: config.unknownRecipientPolicy,
    search: { metadataOnly: true, bodySearch: "disabled", bodyIndexingRequestRefused: config.search.bodyIndexingRequestRefused },
    broadcastDispatchEnabled: config.broadcastDispatchEnabled,
    automationEnabled: config.automationEnabled,
    confirmationEmailsEnabled: config.confirmationEmailsEnabled,
    workerQueues: config.workerQueues,
    unsubscribeConfigured: config.unsubscribe.secret.length >= 32 && Boolean(config.publicApiUrl),
    emergencyStop: { ...config.emergencyStop },
    integrationsEnabled: config.integrations.enabled,
    integrationsConfigured: config.integrations.hashSecret.length >= 32,
    retentionExecutionEnabled: config.retention.executionEnabled,
    retentionSystemDays: { ...config.retention.systemDays },
    opsAlertsEnabled: config.ops.alertsEnabled,
    metricsEndpointEnabled: config.ops.metricsToken.length >= 32,
    broadcastLimits: { maxRecipients: config.broadcast.maxRecipients, providerRequestsPerSecond: config.broadcast.providerRequestsPerSecond, approvalTtlDays: config.broadcast.approvalTtlDays, sharedProviderAccountAllowed: config.broadcast.allowSharedProviderAccount },
  };
}

module.exports = { loadMailConfig, providerConfigured, publicStatus, flag, infrastructureViolations, ENVIRONMENT_MARKERS };
