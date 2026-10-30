const { prisma } = require("../../../shared/config/database");
const ApiError = require("../../../shared/utils/ApiError");
const { encryptCredential, isEncryptionConfigured } = require("./utils/credential-encryption");
const {
  encryptCredentialEnvelope,
  encryptedEnvelopeMarker,
  resolveStoredCredentials,
} = require("./utils/credential-envelope");
const { CONNECTORS } = require("./connectors");
const { ProviderError, sanitizeProviderText } = require("./connectors/provider-http");
const { AD_PLATFORMS, normalizePlatform: knownPlatform } = require("./platforms");
const { assertUuid, sanitizeBoundedJson } = require("./validation-security");
const { EVENTS, logEvent, providerFailure, safeRequestId } = require("./observability");

const SECRET_METADATA_KEYS = new Set([
  "accessToken",
  "refreshToken",
  "accessTokenSecret",
  "consumerKey",
  "consumerSecret",
  "clientId",
  "clientSecret",
  "developerToken",
  "appSecret",
  "authorization",
  "authorizationCode",
  "code",
]);

const ERROR_CATEGORY = Object.freeze({
  auth: "REAUTHORIZATION_REQUIRED",
  rate_limit: "RATE_LIMITED",
  timeout: "PROVIDER_UNAVAILABLE",
  provider: "PROVIDER_UNAVAILABLE",
  config: "INVALID_CONFIGURATION",
  malformed: "PROVIDER_UNAVAILABLE",
});

function normalizePlatform(platform) {
  const normalized = knownPlatform(platform);
  if (!normalized) {
    throw new ApiError(400, `platform must be one of: ${AD_PLATFORMS.join(", ")}`);
  }
  return normalized;
}

function normalizeCurrency(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return null;
  if (normalized !== "UNSPECIFIED" && !/^[A-Z]{3}$/.test(normalized)) {
    throw new ApiError(400, "currency must be an ISO 4217 code");
  }
  return normalized.slice(0, 16);
}

function currencyEnv(...names) {
  for (const name of names) {
    if (process.env[name]) return normalizeCurrency(process.env[name]);
  }
  return null;
}

function normalizeMetaAccountId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("act_") ? raw : `act_${raw}`;
}

function normalizeGoogleCustomerId(value) {
  const normalized = String(value || "").replace(/-/g, "").trim();
  if (!/^\d+$/.test(normalized)) {
    throw new ApiError(400, "Google Ads customerId must be numeric after dash removal");
  }
  return normalized;
}

function normalizeLinkedInAccountUrn(value) {
  const normalized = String(value || "").trim();
  if (!/^urn:li:sponsoredAccount:\d+$/.test(normalized)) {
    throw new ApiError(400, "LinkedIn adAccountUrn must match urn:li:sponsoredAccount:<id>");
  }
  return normalized;
}

function sanitizeMetadata(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_METADATA_KEYS.has(key)) continue;
    if (/token|secret|authorization|credential|cipher|iv|tag|code/i.test(key)) continue;
    if (value === undefined || value === "") continue;
    out[key] = value;
  }
  return Object.keys(out).length ? sanitizeBoundedJson(out, { maxBytes: 16384, maxDepth: 6, maxFields: 100, maxArray: 100, maxString: 1000 }) : null;
}

function hasRequiredCredentials(platform, credentials) {
  const required = {
    META: ["accessToken"],
    TIKTOK: ["accessToken"],
    X: ["consumerKey", "consumerSecret", "accessToken", "accessTokenSecret"],
    LINKEDIN: ["accessToken"],
    GOOGLE_ADS: ["clientId", "clientSecret", "refreshToken", "developerToken"],
  }[platform];

  return required.every((key) => Boolean(credentials?.[key]));
}

function tokenRefreshVerificationRequired(connection) {
  return Boolean(
    connection?.refreshToken || connection?.connectionMetadata?.tokenRefreshApplicable === true,
  );
}

function hasCompleteLiveValidation(connection) {
  return Boolean(
    connection?.lastConnectionTestAt &&
      connection?.lastSuccessfulFetchAt &&
      connection?.lastMetricReconciliationAt &&
      connection?.lastPaginationVerificationAt &&
      connection?.lastRateLimitVerificationAt &&
      (!tokenRefreshVerificationRequired(connection) ||
        connection?.lastTokenRefreshVerificationAt),
  );
}

function evidenceValidationStatus(connection) {
  if (hasCompleteLiveValidation(connection)) return "LIVE_VALIDATED";
  if (connection?.lastMetricReconciliationAt) return "METRIC_RECONCILED";
  if (connection?.lastSuccessfulFetchAt) return "BOUNDED_FETCH_PASSED";
  if (connection?.lastConnectionTestAt) return "CONNECTION_TEST_PASSED";
  return "NOT_VALIDATED";
}

function effectiveValidationStatus(connection) {
  const stored = connection?.validationStatus || "NOT_VALIDATED";
  if (["CREDENTIAL_BLOCKED", "APPROVAL_BLOCKED", "FAILED"].includes(stored)) {
    return stored;
  }
  return evidenceValidationStatus(connection);
}

function connectionMetadata(connection) {
  const credentials = (() => {
    try {
      return resolveStoredCredentials(connection);
    } catch (_error) {
      return {};
    }
  })();

  return {
    id: connection.id,
    platform: connection.platform,
    accountId: connection.accountId,
    status: connection.status,
    currency: connection.currency || null,
    requiresReauthorization: Boolean(connection.requiresReauthorization),
    accessTokenExpiresAt: connection.accessTokenExpiresAt,
    refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
    lastSyncedAt: connection.lastSyncedAt,
    lastSyncError: connection.lastSyncError
      ? sanitizeProviderText(String(connection.lastSyncError)).slice(0, 1000)
      : null,
    validationStatus: effectiveValidationStatus(connection),
    lastConnectionTestAt: connection.lastConnectionTestAt || null,
    lastSuccessfulFetchAt: connection.lastSuccessfulFetchAt || null,
    lastMetricReconciliationAt: connection.lastMetricReconciliationAt || null,
    lastPaginationVerificationAt: connection.lastPaginationVerificationAt || null,
    lastRateLimitVerificationAt: connection.lastRateLimitVerificationAt || null,
    lastTokenRefreshVerificationAt: connection.lastTokenRefreshVerificationAt || null,
    sanitizedValidationError: connection.sanitizedValidationError
      ? sanitizeProviderText(String(connection.sanitizedValidationError)).slice(0, 1000)
      : null,
    hasAccessToken: Boolean(credentials.accessToken),
    hasRefreshToken: Boolean(credentials.refreshToken),
    hasEncryptedCredentials: Boolean(connection.encryptedCredentials),
    hasRequiredCredentials: hasRequiredCredentials(connection.platform, credentials),
    connectionMetadata: sanitizeMetadata(connection.connectionMetadata),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function buildProviderPayload(input) {
  const platform = normalizePlatform(input.platform);
  const mergedCredentials = {
    ...(input.credentials || {}),
  };
  const metadata = {
    ...(input.connectionMetadata || {}),
  };
  let accountId = String(input.accountId || "").trim();

  const addCredential = (key, value) => {
    if (value !== undefined && value !== null && value !== "") mergedCredentials[key] = value;
  };
  const addMetadata = (key, value) => {
    if (value !== undefined && value !== null && value !== "") metadata[key] = value;
  };

  if (platform === "META") {
    accountId = normalizeMetaAccountId(accountId);
    addCredential("accessToken", input.accessToken);
    addMetadata("accountId", accountId);
    addMetadata("graphApiVersion", input.graphApiVersion || metadata.graphApiVersion);
  }

  if (platform === "TIKTOK") {
    accountId = accountId || String(input.advertiserId || "").trim();
    addCredential("accessToken", input.accessToken);
    addCredential("refreshToken", input.refreshToken);
    addCredential("appId", input.appId);
    addCredential("appSecret", input.appSecret);
    addMetadata("advertiserId", accountId);
    addMetadata("apiVersion", input.apiVersion || metadata.apiVersion);
  }

  if (platform === "X") {
    accountId = accountId || String(input.adsAccountId || "").trim();
    addCredential("consumerKey", input.consumerKey);
    addCredential("consumerSecret", input.consumerSecret);
    addCredential("accessToken", input.accessToken);
    addCredential("accessTokenSecret", input.accessTokenSecret);
    addMetadata("accountId", accountId);
  }

  if (platform === "LINKEDIN") {
    accountId = normalizeLinkedInAccountUrn(accountId || input.adAccountUrn);
    addCredential("accessToken", input.accessToken);
    addCredential("refreshToken", input.refreshToken);
    addCredential("clientId", input.clientId);
    addCredential("clientSecret", input.clientSecret);
    addMetadata("accountUrn", accountId);
    addMetadata("apiVersion", input.apiVersion || metadata.apiVersion);
  }

  if (platform === "GOOGLE_ADS") {
    accountId = normalizeGoogleCustomerId(accountId || input.customerId);
    addCredential("clientId", input.clientId);
    addCredential("clientSecret", input.clientSecret);
    addCredential("refreshToken", input.refreshToken);
    addCredential("developerToken", input.developerToken);
    addMetadata("customerId", accountId);
    if (input.loginCustomerId || metadata.loginCustomerId) {
      addMetadata("loginCustomerId", normalizeGoogleCustomerId(input.loginCustomerId || metadata.loginCustomerId));
    }
    addMetadata("apiVersion", input.apiVersion || metadata.apiVersion);
  }

  if (!accountId) throw new ApiError(400, "accountId is required");

  const currency = normalizeCurrency(input.currency || metadata.currency);
  if (!currency) throw new ApiError(400, "currency is required");

  return {
    platform,
    accountId,
    credentials: mergedCredentials,
    metadata: sanitizeMetadata(metadata),
    currency,
    accessTokenExpiresAt: input.accessTokenExpiresAt,
    refreshTokenExpiresAt: input.refreshTokenExpiresAt,
  };
}

function envCredentialsFor(platform) {
  const normalizedPlatform = normalizePlatform(platform);

  if (normalizedPlatform === "META") {
    if (!process.env.META_ACCESS_TOKEN || !process.env.META_AD_ACCOUNT_ID) return null;
    return buildProviderPayload({
      platform: normalizedPlatform,
      accountId: process.env.META_AD_ACCOUNT_ID,
      accessToken: process.env.META_ACCESS_TOKEN,
      graphApiVersion: process.env.META_GRAPH_API_VERSION,
      currency: currencyEnv("META_CURRENCY", "META_ACCOUNT_CURRENCY") || "UNSPECIFIED",
    });
  }

  if (normalizedPlatform === "TIKTOK") {
    if (!process.env.TIKTOK_ACCESS_TOKEN || !process.env.TIKTOK_ADVERTISER_ID) return null;
    return buildProviderPayload({
      platform: normalizedPlatform,
      advertiserId: process.env.TIKTOK_ADVERTISER_ID,
      accessToken: process.env.TIKTOK_ACCESS_TOKEN,
      refreshToken: process.env.TIKTOK_REFRESH_TOKEN,
      appId: process.env.TIKTOK_APP_ID,
      appSecret: process.env.TIKTOK_APP_SECRET,
      apiVersion: process.env.TIKTOK_API_VERSION,
      currency: currencyEnv("TIKTOK_CURRENCY", "TIKTOK_ACCOUNT_CURRENCY") || "UNSPECIFIED",
      accessTokenExpiresAt: parseEnvDate("TIKTOK_ACCESS_TOKEN_EXPIRES_AT"),
      refreshTokenExpiresAt: parseEnvDate("TIKTOK_REFRESH_TOKEN_EXPIRES_AT"),
    });
  }

  if (normalizedPlatform === "X") {
    if (
      !process.env.X_ADS_CONSUMER_KEY ||
      !process.env.X_ADS_CONSUMER_SECRET ||
      !process.env.X_ADS_ACCESS_TOKEN ||
      !process.env.X_ADS_ACCESS_TOKEN_SECRET ||
      !process.env.X_ADS_ACCOUNT_ID
    ) {
      return null;
    }
    return buildProviderPayload({
      platform: normalizedPlatform,
      adsAccountId: process.env.X_ADS_ACCOUNT_ID,
      consumerKey: process.env.X_ADS_CONSUMER_KEY,
      consumerSecret: process.env.X_ADS_CONSUMER_SECRET,
      accessToken: process.env.X_ADS_ACCESS_TOKEN,
      accessTokenSecret: process.env.X_ADS_ACCESS_TOKEN_SECRET,
      currency: currencyEnv("X_ADS_CURRENCY", "X_ADS_ACCOUNT_CURRENCY") || "UNSPECIFIED",
    });
  }

  if (normalizedPlatform === "LINKEDIN") {
    if (!process.env.LINKEDIN_ACCESS_TOKEN || !process.env.LINKEDIN_AD_ACCOUNT_URN) return null;
    return buildProviderPayload({
      platform: normalizedPlatform,
      adAccountUrn: process.env.LINKEDIN_AD_ACCOUNT_URN,
      clientId: process.env.LINKEDIN_CLIENT_ID,
      clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
      accessToken: process.env.LINKEDIN_ACCESS_TOKEN,
      refreshToken: process.env.LINKEDIN_REFRESH_TOKEN,
      apiVersion: process.env.LINKEDIN_API_VERSION,
      currency: currencyEnv("LINKEDIN_CURRENCY", "LINKEDIN_ACCOUNT_CURRENCY") || "UNSPECIFIED",
      accessTokenExpiresAt: parseEnvDate("LINKEDIN_ACCESS_TOKEN_EXPIRES_AT"),
      refreshTokenExpiresAt: parseEnvDate("LINKEDIN_REFRESH_TOKEN_EXPIRES_AT"),
    });
  }

  if (normalizedPlatform === "GOOGLE_ADS") {
    if (
      !process.env.GOOGLE_ADS_CLIENT_ID ||
      !process.env.GOOGLE_ADS_CLIENT_SECRET ||
      !process.env.GOOGLE_ADS_REFRESH_TOKEN ||
      !process.env.GOOGLE_ADS_DEVELOPER_TOKEN ||
      !process.env.GOOGLE_ADS_CUSTOMER_ID
    ) {
      return null;
    }
    return buildProviderPayload({
      platform: normalizedPlatform,
      customerId: process.env.GOOGLE_ADS_CUSTOMER_ID,
      clientId: process.env.GOOGLE_ADS_CLIENT_ID,
      clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
      apiVersion: process.env.GOOGLE_ADS_API_VERSION,
      currency: currencyEnv("GOOGLE_ADS_CURRENCY", "GOOGLE_ADS_ACCOUNT_CURRENCY") || "UNSPECIFIED",
    });
  }

  return null;
}

function parseEnvDate(name) {
  if (!process.env[name]) return undefined;
  const parsed = new Date(process.env[name]);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function configuredEnvStatus() {
  const requirements = {
    META: ["META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID"],
    TIKTOK: ["TIKTOK_ACCESS_TOKEN", "TIKTOK_ADVERTISER_ID"],
    X: [
      "X_ADS_CONSUMER_KEY",
      "X_ADS_CONSUMER_SECRET",
      "X_ADS_ACCESS_TOKEN",
      "X_ADS_ACCESS_TOKEN_SECRET",
      "X_ADS_ACCOUNT_ID",
    ],
    LINKEDIN: ["LINKEDIN_ACCESS_TOKEN", "LINKEDIN_AD_ACCOUNT_URN"],
    GOOGLE_ADS: [
      "GOOGLE_ADS_CLIENT_ID",
      "GOOGLE_ADS_CLIENT_SECRET",
      "GOOGLE_ADS_REFRESH_TOKEN",
      "GOOGLE_ADS_DEVELOPER_TOKEN",
      "GOOGLE_ADS_CUSTOMER_ID",
    ],
  };

  const summary = {};
  for (const [platform, names] of Object.entries(requirements)) {
    const present = names.filter((name) => Boolean(process.env[name]));
    summary[platform] =
      present.length === 0
        ? "not_configured"
        : present.length === names.length
          ? "configured"
          : "incomplete";
  }
  return summary;
}

function categoryForError(error) {
  if (error instanceof ProviderError) return ERROR_CATEGORY[error.kind] || "PROVIDER_UNAVAILABLE";
  const message = String(error?.message || error || "");
  if (/permission|scope|forbidden/i.test(message)) return "INSUFFICIENT_PERMISSION";
  if (/not found|account/i.test(message)) return "ACCOUNT_NOT_FOUND";
  if (/invalid|expired|unauthor/i.test(message)) return "INVALID_CREDENTIALS";
  if (/rate/i.test(message)) return "RATE_LIMITED";
  return "PROVIDER_UNAVAILABLE";
}

function validationStatusForError(category) {
  if (["INVALID_CREDENTIALS", "REAUTHORIZATION_REQUIRED"].includes(category)) {
    return "CREDENTIAL_BLOCKED";
  }
  if (["INSUFFICIENT_PERMISSION", "ACCOUNT_NOT_FOUND"].includes(category)) {
    return "APPROVAL_BLOCKED";
  }
  return "FAILED";
}

function createProviderConnectionService({ prisma: db = prisma, connectors = CONNECTORS, log } = {}) {
  async function listConnections({ platform } = {}) {
    const where = platform ? { platform: normalizePlatform(platform) } : {};
    const rows = await db.marketing_ad_platform_connections.findMany({
      where,
      orderBy: [{ platform: "asc" }, { createdAt: "desc" }],
    });
    return rows.map(connectionMetadata);
  }

  async function listValidationStatus() {
    const rows = await db.marketing_ad_platform_connections.findMany({
      orderBy: [{ platform: "asc" }, { createdAt: "desc" }],
    });
    const grouped = new Map(AD_PLATFORMS.map((platform) => [platform, []]));
    for (const row of rows) {
      grouped.get(row.platform)?.push(connectionMetadata(row));
    }

    return AD_PLATFORMS.map((platform) => {
      const connections = grouped.get(platform) || [];
      const liveValidated = connections.some((row) => row.validationStatus === "LIVE_VALIDATED");
      const best = connections.find((row) => row.status === "ACTIVE") || connections[0] || null;
      return {
        platform,
        codeStatus: "IMPLEMENTED",
        mockTests: "MOCK_VERIFIED",
        liveStatus: liveValidated ? "LIVE_VALIDATED" : best?.validationStatus || "NOT_VALIDATED",
        blocker: liveValidated ? null : "EXTERNAL_CREDENTIAL_OR_APPROVAL_REQUIRED",
        connections,
      };
    });
  }

  async function getConnection(id) {
    assertUuid(id, "connectionId");
    const row = await db.marketing_ad_platform_connections.findUnique({ where: { id } });
    if (!row) throw new ApiError(404, "Connection not found");
    return connectionMetadata(row);
  }

  async function upsertConnection(input) {
    const normalized = buildProviderPayload(input);

    const existing = await db.marketing_ad_platform_connections.findUnique({
      where: {
        platform_accountId: {
          platform: normalized.platform,
          accountId: normalized.accountId,
        },
      },
    });

    const mergedCredentials = {
      ...(existing ? resolveStoredCredentials(existing) : {}),
      ...normalized.credentials,
    };
    const hasNewCredentials = Object.keys(normalized.credentials).length > 0;

    if (!existing && !hasNewCredentials) {
      throw new ApiError(400, "credentials are required when creating a connection");
    }

    if (!hasRequiredCredentials(normalized.platform, mergedCredentials)) {
      throw new ApiError(400, `Missing required ${normalized.platform} credentials`);
    }

    const encryptedEnvelope = encryptCredentialEnvelope(mergedCredentials);
    const legacyAccessToken = mergedCredentials.accessToken
      ? encryptCredential(String(mergedCredentials.accessToken))
      : encryptedEnvelopeMarker();
    const legacyRefreshToken = mergedCredentials.refreshToken
      ? encryptCredential(String(mergedCredentials.refreshToken))
      : null;

    const data = {
      status: "ACTIVE",
      lastSyncError: null,
      requiresReauthorization: false,
      connectionMetadata: normalized.metadata,
      currency: normalized.currency,
      encryptedCredentials: encryptedEnvelope,
      credentialVersion: 1,
      accessToken: legacyAccessToken,
      refreshToken: legacyRefreshToken,
      accessTokenExpiresAt: normalized.accessTokenExpiresAt || null,
      refreshTokenExpiresAt: normalized.refreshTokenExpiresAt || null,
    };

    const row = existing
      ? await db.marketing_ad_platform_connections.update({
          where: { id: existing.id },
          data,
        })
      : await db.marketing_ad_platform_connections.create({
          data: {
            platform: normalized.platform,
            accountId: normalized.accountId,
            ...data,
          },
        });

    return connectionMetadata(row);
  }

  async function updateConnection(id, input) {
    assertUuid(id, "connectionId");
    const existing = await db.marketing_ad_platform_connections.findUnique({ where: { id } });
    if (!existing) throw new ApiError(404, "Connection not found");
    return upsertConnection({
      platform: existing.platform,
      accountId: existing.accountId,
      currency: existing.currency,
      connectionMetadata: existing.connectionMetadata,
      ...input,
    });
  }

  async function setConnectionStatus(id, status) {
    assertUuid(id, "connectionId");
    const row = await db.marketing_ad_platform_connections.update({
      where: { id },
      data: {
        status,
        ...(status === "ACTIVE" && { requiresReauthorization: false, lastSyncError: null }),
      },
    });
    return connectionMetadata(row);
  }

  async function disableConnection(id) {
    return setConnectionStatus(id, "DISABLED");
  }

  async function enableConnection(id) {
    return setConnectionStatus(id, "ACTIVE");
  }

  async function deleteConnection(id) {
    return setConnectionStatus(id, "DISABLED");
  }

  async function bootstrapConnectionFromEnv(platform) {
    const normalizedPlatform = normalizePlatform(platform);
    let env;
    try {
      env = envCredentialsFor(normalizedPlatform);
    } catch (error) {
      return {
        status: "SKIPPED_INVALID_ENV_CONFIGURATION",
        platform: normalizedPlatform,
        warning: sanitizeProviderText(error.message),
      };
    }
    if (!env) return { status: "SKIPPED_NO_ENV_CREDENTIALS", platform: normalizedPlatform };

    const existing = await db.marketing_ad_platform_connections.findUnique({
      where: {
        platform_accountId: {
          platform: normalizedPlatform,
          accountId: env.accountId,
        },
      },
    });

    if (existing) {
      return {
        status: existing.status === "ACTIVE" ? "EXISTING_ACTIVE" : "EXISTING_NOT_ACTIVE",
        connection: connectionMetadata(existing),
      };
    }

    if (!isEncryptionConfigured()) {
      return { status: "SKIPPED_ENCRYPTION_KEY_MISSING", platform: normalizedPlatform };
    }

    const connection = await upsertConnection(env);
    return { status: "CREATED", connection };
  }

  async function bootstrapAllFromEnv() {
    const results = {};
    for (const platform of AD_PLATFORMS) {
      results[platform] = await bootstrapConnectionFromEnv(platform);
    }
    return results;
  }

  async function getActiveConnectionOrBootstrap(platform) {
    const normalizedPlatform = normalizePlatform(platform);
    const active = await db.marketing_ad_platform_connections.findMany({
      where: { platform: normalizedPlatform, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    });
    if (active.length > 0) return active;

    if (String(process.env.MARKETING_INTELLIGENCE_BOOTSTRAP_CONNECTIONS).toLowerCase() === "true") {
      const bootstrapped = await bootstrapConnectionFromEnv(normalizedPlatform);
      if (bootstrapped.connection?.status === "ACTIVE") {
        const row = await db.marketing_ad_platform_connections.findUnique({
          where: { id: bootstrapped.connection.id },
        });
        return row ? [row] : [];
      }
    }

    return [];
  }

  async function testConnection(id, { since, until } = {}) {
    assertUuid(id, "connectionId");
    const connection = await db.marketing_ad_platform_connections.findUnique({ where: { id } });
    if (!connection) throw new ApiError(404, "Connection not found");
    if (connection.status !== "ACTIVE") throw new ApiError(400, "Connection is not active");

    const connector = connectors[connection.platform];
    if (!connector) throw new ApiError(400, `No connector registered for ${connection.platform}`);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const range = { since: since || yesterday, until: until || yesterday };

    try {
      const checkedAt = new Date();
      const rows = await connector.fetchDailyCampaignInsights({
        ...range,
        connection,
        onTokensRefreshed: async () => {},
      });
      await db.marketing_ad_platform_connections.update({
        where: { id },
        data: {
          status: "ACTIVE",
          requiresReauthorization: false,
          lastSyncError: null,
          validationStatus: "BOUNDED_FETCH_PASSED",
          lastConnectionTestAt: checkedAt,
          lastSuccessfulFetchAt: checkedAt,
          sanitizedValidationError: null,
        },
      });
      return {
        success: true,
        ok: true,
        platform: connection.platform,
        accountId: connection.accountId,
        status: "CONNECTED",
        checkedAt: checkedAt.toISOString(),
        validationStatus: "BOUNDED_FETCH_PASSED",
        range,
        rowsFetched: rows.length,
        accountMetadata: {
          currency: connection.currency || connection.connectionMetadata?.currency || null,
        },
      };
    } catch (error) {
      const category = categoryForError(error);
      const failure = providerFailure(error);
      const requiresReauthorization = ["INVALID_CREDENTIALS", "REAUTHORIZATION_REQUIRED"].includes(category);
      const checkedAt = new Date();
      const sanitized = sanitizeProviderText(String(error.message || error)).slice(0, 1000);
      await db.marketing_ad_platform_connections.update({
        where: { id },
        data: {
          status: requiresReauthorization ? "ERROR" : connection.status,
          requiresReauthorization,
          lastSyncError: sanitized,
          validationStatus: validationStatusForError(category),
          lastConnectionTestAt: checkedAt,
          sanitizedValidationError: sanitized,
        },
      });
      logEvent(EVENTS.PROVIDER_FAILURE, {
        runId: null, platform: connection.platform, connectionId: id,
        ...failure, attempt: 1,
        safeRequestId: safeRequestId(error.requestId || error.response?.headers?.["x-request-id"]),
        operation: "CONNECTION_TEST", status: "FAILED",
      }, { log, level: "warn" });
      return {
        success: false,
        ok: false,
        platform: connection.platform,
        accountId: connection.accountId,
        status: requiresReauthorization ? "ERROR" : connection.status,
        checkedAt: checkedAt.toISOString(),
        validationStatus: validationStatusForError(category),
        range,
        errorCategory: category,
        providerErrorCategory: failure.providerErrorCategory,
        retryable: failure.retryable,
        safeRequestId: safeRequestId(error.requestId || error.response?.headers?.["x-request-id"]),
        error: sanitized,
      };
    }
  }

  async function recordValidationEvidence(id, evidence = {}) {
    assertUuid(id, "connectionId");
    const connection = await db.marketing_ad_platform_connections.findUnique({ where: { id } });
    if (!connection) throw new ApiError(404, "Connection not found");

    const checkedAt = evidence.checkedAt ? new Date(evidence.checkedAt) : new Date();
    if (Number.isNaN(checkedAt.getTime())) throw new ApiError(400, "checkedAt is invalid");

    const data = { sanitizedValidationError: null };
    if (evidence.connectionTestPassed) data.lastConnectionTestAt = checkedAt;
    if (evidence.boundedFetchPassed) data.lastSuccessfulFetchAt = checkedAt;
    if (evidence.metricReconciled) data.lastMetricReconciliationAt = checkedAt;
    if (evidence.paginationVerified) data.lastPaginationVerificationAt = checkedAt;
    if (evidence.rateLimitVerified) data.lastRateLimitVerificationAt = checkedAt;
    if (evidence.tokenRefreshVerified) data.lastTokenRefreshVerificationAt = checkedAt;

    data.validationStatus = evidenceValidationStatus({ ...connection, ...data });
    const updated = await db.marketing_ad_platform_connections.update({
      where: { id },
      data,
    });
    return connectionMetadata(updated);
  }

  return {
    listConnections,
    getConnection,
    upsertConnection,
    updateConnection,
    disableConnection,
    enableConnection,
    deleteConnection,
    bootstrapConnectionFromEnv,
    bootstrapAllFromEnv,
    getActiveConnectionOrBootstrap,
    listValidationStatus,
    testConnection,
    recordValidationEvidence,
  };
}

const defaultService = createProviderConnectionService();

module.exports = {
  createProviderConnectionService,
  connectionMetadata,
  envCredentialsFor,
  normalizePlatform,
  normalizeMetaAccountId,
  normalizeGoogleCustomerId,
  normalizeLinkedInAccountUrn,
  buildProviderPayload,
  configuredEnvStatus,
  validationStatusForError,
  hasCompleteLiveValidation,
  evidenceValidationStatus,
  ...defaultService,
};
