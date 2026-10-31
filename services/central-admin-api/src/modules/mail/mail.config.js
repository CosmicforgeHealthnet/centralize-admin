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

// Unset or blank -> fallback; otherwise the usual true/false parsing.
function optionalFlag(value, fallback) {
  return value === undefined || value === null || String(value).trim() === "" ? fallback : flag(value);
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
    // Core Mail processing is backend-managed: with Mail enabled the worker
    // runs unless MAIL_WORKER_ENABLED=false (an explicit emergency shutdown).
    // No staff rollout rule, cohort or frontend switch is needed for it.
    workerEnabled: enabled && optionalFlag(env.MAIL_WORKER_ENABLED, true),
    provider: String(env.MAIL_PROVIDER || "resend").trim().toLowerCase(),
    domainAllowlist: list(env.MAIL_DOMAIN_ALLOWLIST),
    // Addresses on our domains that another system sends from directly
    // through the provider (e.g. the KarryGo Notification Service's
    // no-reply@karryam.com). CA never sends as them (staff, sender grants,
    // marketing), they never get a human mailbox, inbound mail to them is
    // discarded (audited, never held or stored) and provider events for mail
    // they sent are acknowledged without being stored. See
    // docs/cosmicforge-mail-karryam-resend-activation.md.
    ...reservedSenderConfig(env),
    // One Resend account and API key serve staging and production, so the
    // two deployments must never act on each other's traffic:
    // - testRecipients: when set, external delivery is limited to these
    //   addresses / domains (MAIL_TEST_RECIPIENT_ALLOWLIST; "a@b.com",
    //   "@b.com" or "b.com"). Required on staging when sending is enabled.
    // - inbound: only the deployment named by MAIL_INBOUND_ACTIVE_ENVIRONMENT
    //   (the one the single webhook points at) accepts or reconciles inbound
    //   mail. Required on staging/production when receiving is enabled.
    // - providerTags: every CA send carries cf_app/cf_env tags so delivery
    //   events for the other deployment's mail are ignored.
    testRecipients: testRecipientConfig(env),
    inbound: inboundOwnershipConfig(env),
    providerTags: Object.freeze({ app: "cosmicforge-mail", environment: deploymentEnvironment(env) }),
    // The single provider webhook points at the inbound owner; the other
    // deployment's delivery events are acknowledged there and dropped
    // (cf_env tag). A deployment that sends but does not own the webhook
    // therefore never hears about delivery. It instead asks the provider for
    // the status of its own recent sends (GET /emails/{id}) and records it
    // through the normal delivery-event pipeline. On by default only there;
    // MAIL_DELIVERY_STATUS_POLLING_ENABLED=true|false overrides.
    deliveryPolling: deliveryPollingConfig(env, enabled),
    // §18/§19.8: provider-side domain registration (POST /domains) and
    // verification triggers (POST /domains/{id}/verify) from the admin API.
    // Reading verification status never needs it. Never changes DNS.
    providerDomainManagementEnabled: enabled && flag(env.MAIL_PROVIDER_DOMAIN_MANAGEMENT_ENABLED),
    // Spec §19.7: organizations whose slug starts with one of these prefixes
    // never send through the provider. Lifting it needs the HealthNet owner's
    // and legal approval of a compliant provider (MAIL_RESTRICTED_HEALTH_PROVIDER_APPROVED).
    restrictedHealth: {
      organizations: list(env.MAIL_RESTRICTED_HEALTH_ORGANIZATIONS || "healthnet").map((entry) => entry.toLowerCase()),
      providerApproved: flag(env.MAIL_RESTRICTED_HEALTH_PROVIDER_APPROVED),
    },
    resend: {
      apiKey: String(env.RESEND_API_KEY || ""),
      webhookSecret: String(env.RESEND_WEBHOOK_SECRET || ""),
      // Accepted alongside the current secret during a rotation grace period.
      previousWebhookSecret: String(env.RESEND_WEBHOOK_SECRET_PREVIOUS || ""),
      baseUrl: String(env.RESEND_API_BASE_URL || "https://api.resend.com").replace(/\/+$/, ""),
      timeoutMs: intInRange(env.RESEND_TIMEOUT_MS, 15000, 1000, 60000),
      // Optional operator marker naming the environment the provider account
      // / API key belongs to (never the key itself); must match the
      // deployment environment when set.
      keyEnvironment: String(env.MAIL_PROVIDER_ENVIRONMENT_TAG || env.RESEND_API_KEY_ENVIRONMENT || "").trim().toLowerCase(),
      // Client-side pacing per worker process, below Resend's documented
      // default of 10 requests/s per team (0 disables pacing). Provider 429s
      // still defer jobs durably with retry-after.
      requestsPerSecond: intInRange(env.RESEND_REQUESTS_PER_SECOND, 8, 0, 100),
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
      // Filesystem storage: refuse writes and report unhealthy below this much
      // free space, and (staging/production) require the directory to be its
      // own mounted volume so a container recreate can never lose mail.
      minFreeBytes: intInRange(env.MAIL_STORAGE_MIN_FREE_MB, 1024, 0, 1024 * 1024) * 1024 * 1024,
      requireMount: env.MAIL_STORAGE_REQUIRE_MOUNT === undefined || String(env.MAIL_STORAGE_REQUIRE_MOUNT).trim() === "" ? ["staging", "production"].includes(deploymentEnvironment(env)) : flag(env.MAIL_STORAGE_REQUIRE_MOUNT),
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
      // MAIL_KMS_PROVIDER=file: self-hosted keyring file (security/file-keyring.js).
      keyringFile: String(env.MAIL_ENCRYPTION_KEYRING_FILE || "/run/secrets/cosmicforge-mail-keyring"),
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
      // Plaintext body indexing does not exist; a legacy
      // MAIL_SEARCH_INDEX_BODIES=true is refused and reported.
      bodyIndexingRequestRefused: flag(env.MAIL_SEARCH_INDEX_BODIES),
      // Keyed blind index (spec 5.1, 12): opt-in and only with a dedicated
      // search keyring ("s1:<base64 32 bytes>,..."). Leakage trade-off is
      // documented in docs/cosmicforge-mail-body-search.md.
      bodies: enabled && flag(env.MAIL_BODY_SEARCH_ENABLED) && Boolean(String(env.MAIL_SEARCH_INDEX_KEYS || "").trim()),
      bodyRequested: flag(env.MAIL_BODY_SEARCH_ENABLED),
      keys: String(env.MAIL_SEARCH_INDEX_KEYS || ""),
      activeKey: String(env.MAIL_SEARCH_INDEX_ACTIVE_KEY || ""),
      maxTermsPerMessage: intInRange(env.MAIL_SEARCH_MAX_TERMS_PER_MESSAGE, 2000, 100, 4000),
      backfillBatch: intInRange(env.MAIL_SEARCH_BACKFILL_BATCH, 100, 10, 1000),
    },
    archive: {
      // Original headers are archived (encrypted) whenever migration 35 is
      // present; raw MIME needs its own approval flag (spec 10.6).
      storeHeaders: env.MAIL_ARCHIVE_HEADERS === undefined ? true : flag(env.MAIL_ARCHIVE_HEADERS),
      storeRawMime: flag(env.MAIL_ARCHIVE_RAW_MIME),
      rawMimeMaxBytes: intInRange(env.MAIL_ARCHIVE_RAW_MAX_BYTES, 30 * 1024 * 1024, 1024, 40 * 1024 * 1024),
    },
    forwarding: {
      // External forwarding is denied unless the target domain is listed
      // here AND a mail administrator approves with MFA (spec 5.3, 10.5).
      externalAllowedDomains: list(env.MAIL_FORWARDING_EXTERNAL_ALLOWED_DOMAINS),
      maxRulesPerMailbox: intInRange(env.MAIL_FORWARDING_MAX_RULES, 3, 1, 10),
      maxHops: intInRange(env.MAIL_FORWARDING_MAX_HOPS, 3, 1, 5),
    },
    quota: {
      // Mailbox storage quota and the over-quota policy (spec 10.8):
      // accept (deliver + alert) or reject (do not deliver to that mailbox).
      mailboxStorageBytes: intInRange(env.MAIL_MAILBOX_STORAGE_QUOTA_MB, 10240, 1, 1024 * 1024) * 1024 * 1024,
      // Alert when a mailbox passes this share of its quota.
      warnPercent: intInRange(env.MAIL_MAILBOX_STORAGE_WARN_PERCENT, 90, 50, 100),
      overQuotaPolicy: String(env.MAIL_OVER_QUOTA_POLICY || "accept").trim().toLowerCase() === "reject" ? "reject" : "accept",
    },
    marketingReplies: {
      windowDays: intInRange(env.MAIL_MARKETING_REPLY_WINDOW_DAYS, 30, 1, 180),
    },
    reconciliation: {
      // Inbound reconciliation is the safety net for missed webhooks. On by
      // default for a staging/production deployment that receives and owns
      // inbound mail (MAIL_INBOUND_ACTIVE_ENVIRONMENT); the webhook stays the
      // primary low-latency path. MAIL_RECONCILIATION_ENABLED=true|false
      // overrides.
      enabled: optionalFlag(env.MAIL_RECONCILIATION_ENABLED, enabled && flag(env.MAIL_RECEIVING_ENABLED) && ["staging", "production"].includes(deploymentEnvironment(env)) && inboundOwnershipConfig(env).ownedHere),
      // Hard cap of reconciliation enqueues per run (provider rate limits).
      inboundMaxEnqueuePerRun: intInRange(env.MAIL_INBOUND_RECONCILE_MAX_ENQUEUE, 50, 1, 500),
      // Resend keeps idempotency keys for 24h. A send whose first attempt is
      // older than this window is never retried; it becomes OUTCOME_UNKNOWN.
      idempotencyWindowHours: intInRange(env.MAIL_PROVIDER_IDEMPOTENCY_WINDOW_HOURS, 23, 1, 23),
      // Inbound reconciliation (spec §10.8): list received emails and process
      // any whose webhook never arrived.
      inboundIntervalSeconds: intInRange(env.MAIL_INBOUND_RECONCILE_INTERVAL_SECONDS, 900, 60, 86400),
      inboundLookbackHours: intInRange(env.MAIL_INBOUND_RECONCILE_LOOKBACK_HOURS, 24, 1, 72),
      inboundGraceSeconds: intInRange(env.MAIL_INBOUND_RECONCILE_GRACE_SECONDS, 600, 60, 3600),
      inboundMaxPages: intInRange(env.MAIL_INBOUND_RECONCILE_MAX_PAGES, 5, 1, 50),
    },
    // §17.1 private-mail session hardening. When required, an enabled Mail
    // is not ready unless HQ sessions use httpOnly cookies (AUTH_SESSION_MODE
    // cookie, or dual while old tabs drain if MAIL_SESSION_ALLOW_DUAL=true).
    // Defaults: required in production, reported (not enforced) elsewhere.
    session: {
      requireHardened: env.MAIL_REQUIRE_HARDENED_SESSION === undefined || String(env.MAIL_REQUIRE_HARDENED_SESSION).trim() === "" ? deploymentEnvironment(env) === "production" : flag(env.MAIL_REQUIRE_HARDENED_SESSION),
      allowDual: flag(env.MAIL_SESSION_ALLOW_DUAL),
    },
    worker: {
      pollIntervalMs: intInRange(env.MAIL_WORKER_POLL_INTERVAL_MS, 2000, 200, 60000),
      concurrency: intInRange(env.MAIL_WORKER_CONCURRENCY, 4, 1, 32),
      // A lease must outlive one provider call plus a margin, otherwise a
      // slow (timed-out) request could be recovered and re-run by another
      // worker while still in flight: clamped up to RESEND_TIMEOUT_MS + 30s
      // (leaseClampedFrom reports the requested value when clamped).
      ...workerLease(env),
      maxAttempts: intInRange(env.MAIL_WORKER_MAX_ATTEMPTS, 6, 1, 20),
      // Graceful shutdown: how long stop() waits for in-flight jobs.
      drainTimeoutMs: intInRange(env.MAIL_WORKER_DRAIN_TIMEOUT_MS, 30000, 1000, 600000),
      // Durable heartbeat (worker-heartbeat.js): written every interval; a
      // worker silent for staleAfterSeconds is reported NOT_RUNNING.
      heartbeatIntervalSeconds: intInRange(env.MAIL_WORKER_HEARTBEAT_SECONDS, 30, 5, 600),
      staleAfterSeconds: intInRange(env.MAIL_WORKER_STALE_SECONDS, 180, 30, 3600),
      // Release identifier (image tag) recorded in the heartbeat; set by the
      // deploy scripts. Never a secret.
      release: String(env.MAIL_RELEASE_IMAGE || "").trim().slice(0, 200) || null,
    },
    unknownRecipientPolicy:
      String(env.MAIL_UNKNOWN_RECIPIENT_POLICY || "reject").trim().toLowerCase() === "quarantine"
        ? "quarantine"
        : "reject",
    // GAP 8 (spec 11.8) mixed internal/external recipients. See
    // docs/cosmicforge-mail-mixed-recipients.md. "external-only" (default)
    // gives the provider only external recipients; "full-headers" gives it the
    // complete visible To/Cc and drops the provider's echoes to our own
    // addresses. full-headers needs the receiving cutover + product/security
    // approval, and is refused (stays external-only) without an origin key.
    mixedRecipients: mixedRecipientConfig(env),
    stepUpTtlSeconds: intInRange(env.MAIL_STEP_UP_TTL_SECONDS, 300, 60, 900),
    publicAppUrl: String(env.MAIL_PUBLIC_APP_URL || env.FRONTEND_URL || ""),
    // Public base for unsubscribe / preference links (the API origin).
    publicApiUrl: String(env.MAIL_PUBLIC_API_URL || "").replace(/\/+$/, ""),
    // M7: each live capability has its own flag and requires Mail + Marketing.
    broadcastDispatchEnabled: enabled && flag(env.MAIL_MARKETING_ENABLED) && flag(env.MAIL_BROADCAST_DISPATCH_ENABLED),
    automationEnabled: enabled && flag(env.MAIL_MARKETING_ENABLED) && flag(env.MAIL_AUTOMATION_ENABLED),
    confirmationEmailsEnabled: enabled && flag(env.MAIL_MARKETING_ENABLED) && flag(env.MAIL_MARKETING_CONFIRMATION_EMAILS_ENABLED),
    // Campaign test sends (spec §5.5, §13.2 step 3): to active staff only.
    testSendsEnabled: enabled && flag(env.MAIL_MARKETING_ENABLED) && flag(env.MAIL_MARKETING_TEST_SENDS_ENABLED),
    testSend: {
      maxRecipients: intInRange(env.MAIL_MARKETING_TEST_SEND_MAX_RECIPIENTS, 5, 1, 10),
      perCampaignPerHour: intInRange(env.MAIL_MARKETING_TEST_SENDS_PER_HOUR, 10, 1, 50),
    },
    // ---- final gap 7: marketing deliverability preflight (reporting only;
    // nothing here enables sending). Rates in basis points (200 = 2%).
    // Click tracking is not readable through the adapters: "on"/"off" is an
    // operator declaration, anything else = UNKNOWN.
    marketingDeliverability: {
      windowDays: intInRange(env.MAIL_MARKETING_REPUTATION_WINDOW_DAYS, 30, 1, 365),
      minSample: intInRange(env.MAIL_MARKETING_REPUTATION_MIN_SAMPLE, 100, 1, 1000000),
      bounceWarnBps: intInRange(env.MAIL_MARKETING_BOUNCE_WARN_BPS, 200, 0, 10000),
      bounceBlockBps: intInRange(env.MAIL_MARKETING_BOUNCE_BLOCK_BPS, 500, 0, 10000),
      complaintWarnBps: intInRange(env.MAIL_MARKETING_COMPLAINT_WARN_BPS, 10, 0, 10000),
      complaintBlockBps: intInRange(env.MAIL_MARKETING_COMPLAINT_BLOCK_BPS, 30, 0, 10000),
      providerClickTracking: ["on", "off"].includes(String(env.MAIL_MARKETING_PROVIDER_CLICK_TRACKING || "").trim().toLowerCase()) ? String(env.MAIL_MARKETING_PROVIDER_CLICK_TRACKING).trim().toLowerCase() : null,
      // Extra link domains allowed in TRANSACTIONAL_SECURITY templates (the
      // brand's own mail domains are always allowed).
      securityLinkDomains: list(env.MAIL_MARKETING_SECURITY_LINK_DOMAINS),
      providerTimeoutMs: intInRange(env.MAIL_MARKETING_PREFLIGHT_PROVIDER_TIMEOUT_MS, 5000, 500, 30000),
    },
    // ---- end final gap 7
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
    // Final gap 5: durable storage deletion queue (migration 37). Retries use
    // bounded exponential backoff with full jitter; exhausted rows go DEAD.
    storageDeletion: {
      maxAttempts: intInRange(env.MAIL_STORAGE_DELETION_MAX_ATTEMPTS, 12, 1, 100),
      baseSeconds: intInRange(env.MAIL_STORAGE_DELETION_BACKOFF_BASE_SECONDS, 30, 1, 3600),
      capSeconds: intInRange(env.MAIL_STORAGE_DELETION_BACKOFF_CAP_SECONDS, 21600, 60, 604800),
      batchSize: intInRange(env.MAIL_STORAGE_DELETION_BATCH_SIZE, 100, 1, 1000),
      leaseSeconds: intInRange(env.MAIL_STORAGE_DELETION_LEASE_SECONDS, 300, 30, 3600),
      intervalSeconds: intInRange(env.MAIL_STORAGE_DELETION_INTERVAL_SECONDS, 300, 30, 86400),
    },
    // M9 operations: alert evaluation and the token-protected metrics endpoint.
    ops: {
      alertsEnabled: env.MAIL_OPS_ALERTS_ENABLED === undefined ? true : flag(env.MAIL_OPS_ALERTS_ENABLED),
      evaluateIntervalSeconds: intInRange(env.MAIL_OPS_EVALUATE_SECONDS, 300, 60, 3600),
      // The API process also evaluates alerts (watchdog), so a stopped or
      // stalled worker is still reported. MAIL_OPS_API_WATCHDOG_ENABLED=false
      // leaves evaluation to the worker only.
      apiWatchdogEnabled: optionalFlag(env.MAIL_OPS_API_WATCHDOG_ENABLED, true),
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
        // Jobs currently backing off on provider 429/5xx/timeouts.
        providerRetrying: intInRange(env.MAIL_ALERT_PROVIDER_RETRYING, 20, 1, 100000),
        webhookLagSeconds: intInRange(env.MAIL_ALERT_WEBHOOK_LAG_SECONDS, 300, 30, 86400),
        // Content reads/downloads by one person within an hour (attachments,
        // raw MIME, original headers, break-glass reads).
        exportsPerActorHour: intInRange(env.MAIL_ALERT_EXPORTS_PER_ACTOR_HOUR, 50, 5, 100000),
        scannerFailures24h: intInRange(env.MAIL_ALERT_SCANNER_FAILURES_24H, 1, 1, 100000),
        searchIndexStaleSeconds: intInRange(env.MAIL_ALERT_SEARCH_STALE_SECONDS, 3600, 60, 604800),
      },
    },
    // M10 rollout rules. Enforcement defaults ON in production (deny unless an
    // ALLOW rule matches) and OFF elsewhere; MAIL_ROLLOUT_ENFORCED overrides.
    rollout: {
      enforced: env.MAIL_ROLLOUT_ENFORCED === undefined || String(env.MAIL_ROLLOUT_ENFORCED).trim() === "" ? deploymentEnvironment(env) === "production" : flag(env.MAIL_ROLLOUT_ENFORCED),
    },
    // Emergency stop (M9/M10). Blocks provider calls without deleting queued records.
    emergencyStop: {
      all: flag(env.MAIL_EMERGENCY_STOP_ALL),
      marketing: flag(env.MAIL_EMERGENCY_STOP_ALL) || flag(env.MAIL_EMERGENCY_STOP_MARKETING),
    },
    // GAP 2/3 (final gap closure): provider re-subscription + provider quota.
    // Re-subscribing a contact at Resend (PATCH unsubscribed=false) is not
    // documented by Resend: OFF unless confirmed with Resend support.
    providerResubscribeEnabled: flag(env.MAIL_MARKETING_PROVIDER_RESUBSCRIBE_ENABLED),
    // Account plan sending limits (optional; UNKNOWN when unset).
    providerLimits: {
      monthly: /^\d{1,9}$/.test(String(env.MAIL_PROVIDER_MONTHLY_LIMIT ?? "").trim()) && Number(env.MAIL_PROVIDER_MONTHLY_LIMIT) > 0 ? Number(env.MAIL_PROVIDER_MONTHLY_LIMIT) : null,
      daily: /^\d{1,9}$/.test(String(env.MAIL_PROVIDER_DAILY_LIMIT ?? "").trim()) && Number(env.MAIL_PROVIDER_DAILY_LIMIT) > 0 ? Number(env.MAIL_PROVIDER_DAILY_LIMIT) : null,
    },
  };
  return Object.freeze(config);
}

function reservedSenderConfig(env) {
  const { parseReservedSenders } = require("./security/reserved-senders");
  const { addresses, invalid } = parseReservedSenders(env.MAIL_RESERVED_SENDER_ADDRESSES);
  return { reservedSenders: Object.freeze(addresses), reservedSendersInvalid: Object.freeze(invalid) };
}

function testRecipientConfig(env) {
  const { normalizeAddress, normalizeDomain } = require("./security/address.util");
  const addresses = [];
  const domains = [];
  const invalid = [];
  for (const raw of String(env.MAIL_TEST_RECIPIENT_ALLOWLIST ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
    if (raw.includes("@") && !raw.startsWith("@")) {
      const address = normalizeAddress(raw);
      if (address) addresses.push(address);
      else invalid.push(raw.slice(0, 80));
    } else {
      const domain = normalizeDomain(raw.replace(/^@/, ""));
      if (domain) domains.push(domain);
      else invalid.push(raw.slice(0, 80));
    }
  }
  return Object.freeze({ active: addresses.length + domains.length > 0, addresses: Object.freeze([...new Set(addresses)]), domains: Object.freeze([...new Set(domains)]), invalid: Object.freeze(invalid) });
}

function inboundOwnershipConfig(env) {
  const raw = String(env.MAIL_INBOUND_ACTIVE_ENVIRONMENT ?? "").trim().toLowerCase();
  const activeEnvironment = DEPLOYMENT_ENVIRONMENTS.has(raw) ? raw : null;
  const here = deploymentEnvironment(env);
  return Object.freeze({ activeEnvironment, declared: Boolean(raw), invalid: Boolean(raw) && !activeEnvironment, ownedHere: !raw || activeEnvironment === here });
}

function deliveryPollingConfig(env, enabled) {
  const sending = enabled && flag(env.MAIL_SENDING_ENABLED);
  const inbound = inboundOwnershipConfig(env);
  const raw = String(env.MAIL_DELIVERY_STATUS_POLLING_ENABLED ?? "").trim();
  const byDefault = inbound.declared && !inbound.ownedHere;
  return Object.freeze({
    enabled: sending && (raw === "" ? byDefault : flag(raw)),
    intervalSeconds: intInRange(env.MAIL_DELIVERY_STATUS_POLL_INTERVAL_SECONDS, 120, 30, 3600),
    lookbackHours: intInRange(env.MAIL_DELIVERY_STATUS_POLL_LOOKBACK_HOURS, 72, 1, 168),
    maxPerRun: intInRange(env.MAIL_DELIVERY_STATUS_POLL_MAX_PER_RUN, 25, 1, 200),
  });
}

const WORKER_LEASE_MARGIN_SECONDS = 30;

function workerLease(env) {
  const requested = intInRange(env.MAIL_WORKER_LEASE_SECONDS, 120, 15, 900);
  const providerTimeoutSeconds = Math.ceil(intInRange(env.RESEND_TIMEOUT_MS, 15000, 1000, 60000) / 1000);
  const minimum = providerTimeoutSeconds + WORKER_LEASE_MARGIN_SECONDS;
  return { leaseSeconds: Math.max(requested, minimum), leaseMinimumSeconds: minimum, leaseClampedFrom: requested < minimum ? requested : null };
}

// GAP 8: MAIL_MIXED_RECIPIENT_MODE validation. full-headers is refused
// (mode stays external-only, reason reported) when no origin-header key is
// available: MAIL_ORIGIN_HEADER_SECRET (>= 32 chars) or an env keyring.
// Re-audit 7b: it is also refused (MAIL_RECEIVING_CUTOVER_NOT_CONFIRMED)
// unless MAIL_RECEIVING_CUTOVER_CONFIRMED=true (default false) says the
// receiving cutover is done, because before the cutover the provider would
// deliver duplicate copies of internal To/Cc to the legacy mail system.
function mixedRecipientConfig(env) {
  const { originKeyAvailable, MIN_SECRET_LENGTH } = require("./security/origin-header");
  const requestedMode = String(env.MAIL_MIXED_RECIPIENT_MODE || "external-only").trim().toLowerCase();
  const rawSecret = String(env.MAIL_ORIGIN_HEADER_SECRET || "");
  const originSecret = rawSecret.length >= MIN_SECRET_LENGTH ? rawSecret : "";
  let mode = "external-only";
  let refusedReason = null;
  if (!["external-only", "full-headers"].includes(requestedMode)) refusedReason = "MAIL_MIXED_RECIPIENT_MODE_UNKNOWN";
  else if (requestedMode === "full-headers" && String(env.MAIL_RECEIVING_CUTOVER_CONFIRMED || "").trim().toLowerCase() !== "true") refusedReason = "MAIL_RECEIVING_CUTOVER_NOT_CONFIRMED";
  else if (requestedMode === "full-headers") {
    const available = originKeyAvailable({ secret: originSecret, encryptionKeys: env.MAIL_ENCRYPTION_KEYS || "", activeKey: env.MAIL_ENCRYPTION_ACTIVE_KEY || "", kmsProvider: env.MAIL_KMS_PROVIDER || "env" });
    if (available) mode = "full-headers";
    else refusedReason = "MAIL_ORIGIN_HEADER_SECRET_MISSING";
  }
  return Object.freeze({ requestedMode, mode, refusedReason, originSecret, secretTooShort: rawSecret.length > 0 && !originSecret });
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
 * distinct, marked buckets and KMS keys; keyring files and filesystem stores
 * are bound to their environment at runtime (file-keyring.js, mail-storage.js).
 */
function infrastructureViolations(config) {
  const environment = config.deploymentEnvironment;
  const problems = [];
  const storage = config.storage;
  const strict = environment === "production" || environment === "staging";
  if (environment === "production") {
    // Self-hosted (filesystem + file keyring) or object storage (s3 + a key
    // service). Raw keys in the container environment are refused.
    if (!["filesystem", "s3"].includes(storage.provider)) problems.push("production requires MAIL_STORAGE_PROVIDER=filesystem or s3");
    if (!["file", "aws-kms"].includes(config.kms.provider)) problems.push("production requires MAIL_KMS_PROVIDER=file or aws-kms");
    if (config.scanning.provider !== "clamd") problems.push("production requires MAIL_SCANNER_PROVIDER=clamd");
  }
  if (strict && storage.provider === "memory") problems.push(`${environment} refuses memory storage`);
  if (storage.provider === "filesystem" && !String(storage.localDirectory || "").startsWith("/")) problems.push("MAIL_STORAGE_LOCAL_DIR must be an absolute path with filesystem storage");
  if (storage.provider === "s3") {
    const endpoint = storage.s3.endpoint;
    if (endpoint && !/^https:\/\//i.test(endpoint) && !(hostIsLocal(endpoint) && !strict)) problems.push("MAIL_S3_ENDPOINT must use https");
    if (strict) problems.push(...markerCheck(storage.s3.bucket, environment, "MAIL_S3_BUCKET"));
    if (environment === "production" && !storage.s3.sse) problems.push("production requires MAIL_S3_SSE (AES256 or AWS:KMS)");
  }
  if (!["env", "file", "aws-kms"].includes(config.kms.provider)) problems.push("MAIL_KMS_PROVIDER must be env, file or aws-kms");
  if (config.kms.provider === "file") {
    if (!String(config.kms.keyringFile || "").startsWith("/")) problems.push("MAIL_ENCRYPTION_KEYRING_FILE must be an absolute path with MAIL_KMS_PROVIDER=file");
    // One source of truth for keys: never both a file and environment keys.
    if (config.encryption.keys) problems.push("MAIL_ENCRYPTION_KEYS must be empty with MAIL_KMS_PROVIDER=file (keys live in the keyring file)");
  }
  if (config.kms.provider === "aws-kms") {
    if (!config.kms.keyId) problems.push("MAIL_KMS_KEY_ID is required with aws-kms");
    if (config.kms.endpoint && !/^https:\/\//i.test(config.kms.endpoint) && !(hostIsLocal(config.kms.endpoint) && !strict)) problems.push("MAIL_KMS_ENDPOINT must use https");
    if (strict && config.kms.keyId) {
      if (/^alias\//.test(config.kms.keyId) || /:alias\//.test(config.kms.keyId)) problems.push(...markerCheck(config.kms.keyId.split("alias/").pop(), environment, "MAIL_KMS_KEY_ID alias"));
      else if (config.kms.keyEnvironment !== environment) problems.push(`MAIL_KMS_KEY_ENVIRONMENT must be declared as ${environment} for a key ARN/id`);
    }
  }
  // Provider identity (§18 staging proof): staging/production never run on
  // the offline fake, a live capability needs its webhook secret, external
  // sending/receiving needs an explicit domain allowlist, and an optional
  // provider environment marker must match. Key values are never inspected
  // or logged here.
  if (strict) {
    if (config.provider === "fake") problems.push(`${environment} refuses MAIL_PROVIDER=fake`);
    if ((config.sendingEnabled || config.receivingEnabled) && !config.resend.webhookSecret) problems.push(`${environment} requires RESEND_WEBHOOK_SECRET when sending or receiving is enabled`);
    if ((config.sendingEnabled || config.receivingEnabled) && !config.domainAllowlist.length) problems.push(`${environment} requires MAIL_DOMAIN_ALLOWLIST when sending or receiving is enabled`);
    // Shared Resend account: never let two deployments compete for inbound
    // mail, and keep staging test traffic to approved recipients.
    if (config.receivingEnabled && !config.inbound.declared) problems.push(`${environment} requires MAIL_INBOUND_ACTIVE_ENVIRONMENT when receiving is enabled`);
    if (environment === "staging" && config.sendingEnabled && !config.testRecipients.active) problems.push("staging requires MAIL_TEST_RECIPIENT_ALLOWLIST when sending is enabled");
  }
  if (config.inbound.invalid) problems.push("MAIL_INBOUND_ACTIVE_ENVIRONMENT must be development, test, staging or production");
  if (config.testRecipients.invalid.length) problems.push(`MAIL_TEST_RECIPIENT_ALLOWLIST has ${config.testRecipients.invalid.length} invalid entr${config.testRecipients.invalid.length === 1 ? "y" : "ies"}`);
  if (config.resend.keyEnvironment && config.resend.keyEnvironment !== environment) problems.push(`MAIL_PROVIDER_ENVIRONMENT_TAG / RESEND_API_KEY_ENVIRONMENT does not match the ${environment} deployment`);
  return problems;
}

// Address-policy rules checked by `npm run mail:config:validate` (they do not
// change storage availability). Values are addresses, never secrets.
function addressPolicyViolations(config) {
  const problems = [];
  if (config.reservedSendersInvalid.length) problems.push(`MAIL_RESERVED_SENDER_ADDRESSES has ${config.reservedSendersInvalid.length} invalid entr${config.reservedSendersInvalid.length === 1 ? "y" : "ies"}`);
  for (const address of config.reservedSenders) {
    const domain = address.split("@")[1];
    if (!config.domainAllowlist.includes(domain)) problems.push(`MAIL_RESERVED_SENDER_ADDRESSES entry ${address} is not on a MAIL_DOMAIN_ALLOWLIST domain`);
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
    reservedSenders: config.reservedSenders.length,
    testRecipientAllowlist: config.testRecipients.active ? config.testRecipients.addresses.length + config.testRecipients.domains.length : 0,
    deliveryStatusPolling: config.deliveryPolling.enabled,
    inbound: { activeEnvironment: config.inbound.activeEnvironment, ownedHere: config.inbound.ownedHere },
    // GAP 8: mixed-recipient header mode (never the secret).
    mixedRecipients: { mode: config.mixedRecipients.mode, requestedMode: config.mixedRecipients.requestedMode, refusedReason: config.mixedRecipients.refusedReason },
    search: { metadataOnly: !config.search.bodies, bodySearch: config.search.bodies ? "keyed-blind-index" : "disabled", bodySearchRequestedWithoutKey: config.search.bodyRequested && !config.search.bodies, bodyIndexingRequestRefused: config.search.bodyIndexingRequestRefused },
    archive: { headers: config.archive.storeHeaders, rawMime: config.archive.storeRawMime },
    forwarding: { externalAllowedDomains: config.forwarding.externalAllowedDomains.length },
    quota: { mailboxStorageBytes: config.quota.mailboxStorageBytes, overQuotaPolicy: config.quota.overQuotaPolicy },
    broadcastDispatchEnabled: config.broadcastDispatchEnabled,
    automationEnabled: config.automationEnabled,
    confirmationEmailsEnabled: config.confirmationEmailsEnabled,
    testSendsEnabled: config.testSendsEnabled,
    workerQueues: config.workerQueues,
    inboundReconciliation: config.receivingEnabled && config.reconciliation.enabled,
    unsubscribeConfigured: config.unsubscribe.secret.length >= 32 && Boolean(config.publicApiUrl),
    emergencyStop: { ...config.emergencyStop },
    integrationsEnabled: config.integrations.enabled,
    integrationsConfigured: config.integrations.hashSecret.length >= 32,
    retentionExecutionEnabled: config.retention.executionEnabled,
    retentionSystemDays: { ...config.retention.systemDays },
    opsAlertsEnabled: config.ops.alertsEnabled,
    metricsEndpointEnabled: config.ops.metricsToken.length >= 32,
    rolloutEnforced: config.rollout.enforced,
    broadcastLimits: { maxRecipients: config.broadcast.maxRecipients, providerRequestsPerSecond: config.broadcast.providerRequestsPerSecond, approvalTtlDays: config.broadcast.approvalTtlDays, sharedProviderAccountAllowed: config.broadcast.allowSharedProviderAccount },
  };
}

module.exports = { loadMailConfig, providerConfigured, publicStatus, flag, optionalFlag, infrastructureViolations, addressPolicyViolations, ENVIRONMENT_MARKERS };
