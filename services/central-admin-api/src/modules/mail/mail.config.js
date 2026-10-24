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

function loadMailConfig(env = process.env) {
  const enabled = flag(env.MAIL_ENABLED);
  const config = {
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
    },
    limits: {
      attachmentMaxBytes: intInRange(env.MAIL_ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024, 1024, 25 * 1024 * 1024),
      messageMaxBytes: intInRange(env.MAIL_MESSAGE_MAX_BYTES, 25 * 1024 * 1024, 1024, 40 * 1024 * 1024),
      maxAttachmentsPerMessage: intInRange(env.MAIL_MAX_ATTACHMENTS, 10, 1, 50),
      maxRecipients: intInRange(env.MAIL_MAX_RECIPIENTS, 50, 1, 500),
      bodyMaxBytes: intInRange(env.MAIL_BODY_MAX_BYTES, 1024 * 1024, 1024, 5 * 1024 * 1024),
      sendsPerMinutePerUser: intInRange(env.MAIL_SENDS_PER_MINUTE_PER_USER, 20, 1, 600),
      csvImportMaxRows: intInRange(env.MAIL_MARKETING_CSV_MAX_ROWS, 5000, 1, 50000),
    },
    search: {
      indexBodies: flag(env.MAIL_SEARCH_INDEX_BODIES ?? "true"),
    },
    archive: {
      storeRawMime: flag(env.MAIL_ARCHIVE_RAW_MIME),
    },
    reconciliation: {
      enabled: flag(env.MAIL_RECONCILIATION_ENABLED),
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
  };
  return Object.freeze(config);
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
    unknownRecipientPolicy: config.unknownRecipientPolicy,
  };
}

module.exports = { loadMailConfig, providerConfigured, publicStatus, flag };
