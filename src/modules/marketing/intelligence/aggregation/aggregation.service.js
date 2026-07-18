const { prisma } = require("../../../../shared/config/database");
const logger = require("../../../../shared/utils/logger");
const ApiError = require("../../../../shared/utils/ApiError");
const { CONNECTORS } = require("../connectors");
const { validateNormalizedRow } = require("../connectors/connector.interface");
const { sanitizeProviderText } = require("../connectors/provider-http");
const { encryptCredential } = require("../utils/credential-encryption");
const {
  encryptCredentialEnvelope,
  resolveStoredCredentials,
} = require("../utils/credential-envelope");
const { AD_PLATFORMS } = require("../platforms");
const { createSyncLock, SYNC_LOCK_KEY } = require("./sync-lock");
const providerConnections = require("../provider-connections.service");

// Aggregation service: pulls provider insights, stores raw rows, upserts
// normalized daily snapshots, and reconciles internal funnel metrics.

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// Centralized source-to-platform alias map. Funnel events may arrive with any
// of these source values; they all attribute to the mapped ad platform.
const SOURCE_PLATFORM_ALIASES = Object.freeze({
  meta: "META",
  facebook: "META",
  instagram: "META",
  fb: "META",
  ig: "META",
  tiktok: "TIKTOK",
  tik_tok: "TIKTOK",
  x: "X",
  twitter: "X",
  twitter_ads: "X",
  x_ads: "X",
  linkedin: "LINKEDIN",
  linked_in: "LINKEDIN",
  linkedin_ads: "LINKEDIN",
  google: "GOOGLE_ADS",
  google_ads: "GOOGLE_ADS",
  googleads: "GOOGLE_ADS",
  adwords: "GOOGLE_ADS",
});

function resolvePlatformFromSource(source) {
  if (!source) return null;
  return SOURCE_PLATFORM_ALIASES[String(source).trim().toLowerCase()] || null;
}

function toUtcDay(dateString) {
  return new Date(`${dateString}T00:00:00.000Z`);
}

function normalizeCurrency(value) {
  const normalized = String(value || "UNSPECIFIED").trim().toUpperCase();
  return normalized ? normalized.slice(0, 16) : "UNSPECIFIED";
}

function assertValidRange(since, until) {
  if (!DATE_ONLY_REGEX.test(since || "") || !DATE_ONLY_REGEX.test(until || "")) {
    throw new ApiError(400, "since and until must be YYYY-MM-DD dates");
  }
  if (toUtcDay(since).getTime() > toUtcDay(until).getTime()) {
    throw new ApiError(400, "since must not be after until");
  }
}

// CPA = spend / signups; conversion rate = payments / clicks as a PERCENTAGE
// (0-100). Zero denominators yield 0 - never Infinity or NaN.
function deriveMetrics({ spend, signups, clicks, payments }) {
  const spendNumber = Number(spend) || 0;
  const cpa = signups > 0 ? spendNumber / signups : 0;
  const conversionRate = clicks > 0 ? (payments / clicks) * 100 : 0;

  return {
    cpa: Math.round(cpa * 100) / 100,
    conversionRate: Math.round(conversionRate * 100) / 100,
  };
}

function createAggregationService({
  prisma: db = prisma,
  connectors = CONNECTORS,
  syncLock,
  log = logger,
} = {}) {
  const lock = syncLock || createSyncLock({ prisma: db });

  // Aggregate internal funnel events for one campaign/day. Events attribute
  // when their campaignExternalId matches and their source either maps to the
  // platform or is absent (the external campaign id is platform-scoped).
  async function computeFunnelMetrics(platform, campaignExternalId, dateString) {
    const dayStart = toUtcDay(dateString);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const events = await db.marketing_funnel_events.findMany({
      where: {
        campaignExternalId,
        occurredAt: { gte: dayStart, lt: dayEnd },
      },
      select: { stage: true, source: true, value: true },
    });

    const metrics = { signups: 0, activeUsers: 0, payments: 0, revenue: 0 };

    for (const event of events) {
      const eventPlatform = resolvePlatformFromSource(event.source);
      if (eventPlatform && eventPlatform !== platform) continue;

      if (event.stage === "SIGNUP") metrics.signups += 1;
      if (event.stage === "ACTIVE") metrics.activeUsers += 1;
      if (event.stage === "PAYMENT") {
        metrics.payments += 1;
        metrics.revenue += Number(event.value) || 0;
      }
    }

    metrics.revenue = Math.round(metrics.revenue * 100) / 100;
    return metrics;
  }

  // Store the untouched provider row. Re-synchronization upserts on
  // (platform, campaignExternalId, date) so re-runs never duplicate raw data.
  function accountScope(connection) {
    return {
      connectionId: connection?.id || null,
      accountId: connection?.accountId || "ENV",
    };
  }

  async function storeRawInsight(row, connection) {
    const date = toUtcDay(row.date);
    const scope = accountScope(connection);

    await db.marketing_ad_insights_raw.upsert({
      where: {
        platform_accountId_campaignExternalId_date: {
          platform: row.platform,
          accountId: scope.accountId,
          campaignExternalId: row.campaignExternalId,
          date,
        },
      },
      create: {
        connectionId: scope.connectionId,
        accountId: scope.accountId,
        platform: row.platform,
        campaignExternalId: row.campaignExternalId,
        date,
        rawJson: row.raw,
        fetchedAt: new Date(),
      },
      update: {
        connectionId: scope.connectionId,
        accountId: scope.accountId,
        rawJson: row.raw,
        fetchedAt: new Date(),
      },
    });
  }

  // Upsert the normalized daily snapshot, merging provider metrics with
  // internal funnel metrics. Returns "inserted" or "updated".
  async function upsertSnapshot(row, connection) {
    const date = toUtcDay(row.date);
    const scope = accountScope(connection);
    const funnel = await computeFunnelMetrics(
      row.platform,
      row.campaignExternalId,
      row.date,
    );
    const derived = deriveMetrics({
      spend: row.spend,
      signups: funnel.signups,
      clicks: row.clicks,
      payments: funnel.payments,
    });

    const where = {
      platform_accountId_campaignExternalId_date: {
        platform: row.platform,
        accountId: scope.accountId,
        campaignExternalId: row.campaignExternalId,
        date,
      },
    };

    const existing = await db.marketing_performance_snapshots.findUnique({
      where,
      select: { id: true },
    });

    const data = {
      campaignName: row.campaignName,
      connectionId: scope.connectionId,
      accountId: scope.accountId,
      spend: row.spend,
      currency: normalizeCurrency(row.currency),
      impressions: row.impressions,
      clicks: row.clicks,
      signups: funnel.signups,
      activeUsers: funnel.activeUsers,
      payments: funnel.payments,
      revenue: funnel.revenue,
      cpa: derived.cpa,
      conversionRate: derived.conversionRate,
    };

    if (existing) {
      await db.marketing_performance_snapshots.update({ where, data });
      return "updated";
    }

    await db.marketing_performance_snapshots.create({
      data: {
        platform: row.platform,
        connectionId: scope.connectionId,
        accountId: scope.accountId,
        campaignExternalId: row.campaignExternalId,
        date,
        ...data,
      },
    });
    return "inserted";
  }

  // Idempotent funnel reconciliation for an existing snapshot - recomputes
  // signups/activeUsers/payments/revenue and derived metrics. Used after a
  // delayed funnel event lands so already-created snapshots stay correct.
  async function reconcileSnapshotFunnel({ platform, campaignExternalId, date }) {
    const dateString = typeof date === "string" ? date : date.toISOString().slice(0, 10);

    let snapshot;
    if (typeof db.marketing_performance_snapshots.findFirst === "function") {
      snapshot = await db.marketing_performance_snapshots.findFirst({
        where: {
          platform,
          campaignExternalId,
          date: toUtcDay(dateString),
        },
      });
    } else {
      snapshot = await db.marketing_performance_snapshots.findUnique({
        where: {
          platform_accountId_campaignExternalId_date: {
            platform,
            accountId: "ENV",
            campaignExternalId,
            date: toUtcDay(dateString),
          },
        },
      });
    }

    if (!snapshot) return null;

    const funnel = await computeFunnelMetrics(platform, campaignExternalId, dateString);
    const derived = deriveMetrics({
      spend: snapshot.spend,
      signups: funnel.signups,
      clicks: snapshot.clicks,
      payments: funnel.payments,
    });

    return db.marketing_performance_snapshots.update({
      where: { id: snapshot.id },
      data: {
        signups: funnel.signups,
        activeUsers: funnel.activeUsers,
        payments: funnel.payments,
        revenue: funnel.revenue,
        cpa: derived.cpa,
        conversionRate: derived.conversionRate,
      },
    });
  }

  // Resolve the connections to sync for a platform: active database
  // connections first. If only environment credentials exist, bootstrap them
  // into encrypted database storage when the encryption key is configured;
  // otherwise keep the legacy env fallback for local/mock workflows.
  async function resolveConnections(platform, { connectionIds = [] } = {}) {
    const connector = connectors[platform];
    if (!connector) return [];
    const connectionService = providerConnections.createProviderConnectionService({
      prisma: db,
      connectors,
    });

    let dbConnections = await connectionService.getActiveConnectionOrBootstrap(platform);
    if (connectionIds.length > 0) {
      const allowed = new Set(connectionIds);
      dbConnections = dbConnections.filter((connection) => allowed.has(connection.id));
    }

    if (dbConnections.length > 0) {
      return dbConnections.map((connection) => ({ connection, connector }));
    }

    if (connectionIds.length > 0) {
      return [];
    }

    const inactiveDbConnections = await db.marketing_ad_platform_connections.findMany({
      where: { platform },
      select: { id: true },
      take: 1,
    });
    if (inactiveDbConnections.length > 0) {
      log.warn(
        `[MarketingIntelligence] ${platform} sync skipped because database connection(s) exist but none are active`,
      );
      return [];
    }

    const envCheck = connector.validateConfiguration({});
    if (envCheck.ok) {
      log.warn(
        `[MarketingIntelligence] ${platform} using environment credentials because no encrypted active connection is available`,
      );
      return [{ connection: null, connector }];
    }

    return [];
  }

  async function markConnectionSynced(connection) {
    if (!connection) return;
    await db.marketing_ad_platform_connections.update({
      where: { id: connection.id },
      data: {
        lastSyncedAt: new Date(),
        status: "ACTIVE",
        lastSyncError: null,
        requiresReauthorization: false,
      },
    });
  }

  // Persist tokens rotated by a connector's refresh cycle, encrypted.
  // Only applies to database-backed connections (env credentials have no row).
  async function persistRefreshedTokens(connection, tokens) {
    if (!connection || !tokens?.accessToken) return;

    const envelopeCredentials = {
      ...resolveStoredCredentials(connection),
      ...(tokens.credentials || {}),
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    };

    const data = {
      accessToken: encryptCredential(tokens.accessToken),
      encryptedCredentials: encryptCredentialEnvelope(envelopeCredentials),
      credentialVersion: 1,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt || null,
      requiresReauthorization: false,
    };
    if (tokens.refreshToken) {
      data.refreshToken = encryptCredential(tokens.refreshToken);
    }
    if (tokens.refreshTokenExpiresAt) {
      data.refreshTokenExpiresAt = tokens.refreshTokenExpiresAt;
    }

    await db.marketing_ad_platform_connections.update({
      where: { id: connection.id },
      data,
    });
    log.info(
      `[MarketingIntelligence] Stored refreshed ${connection.platform} tokens for connection ${connection.id}`,
    );
  }

  async function markConnectionError(connection, error) {
    if (!connection) return;
    const status = error?.kind === "auth" || error?.kind === "config" ? "ERROR" : connection.status;
    const requiresReauthorization = error?.kind === "auth" ? true : connection.requiresReauthorization;
    await db.marketing_ad_platform_connections.update({
      where: { id: connection.id },
      data: {
        status,
        requiresReauthorization,
        lastSyncError: sanitizeProviderText(String(error?.message || error)).slice(0, 1000),
      },
    });
  }

  async function syncPlatform(platform, { since, until, connectionIds = [] }) {
    const stats = {
      status: "SUCCESS",
      fetched: 0,
      inserted: 0,
      updated: 0,
      failed: 0,
      connections: [],
    };
    const targets = await resolveConnections(platform, { connectionIds });

    if (targets.length === 0) {
      stats.status = "SKIPPED_NO_CREDENTIALS";
      log.warn(
        `[MarketingIntelligence] ${platform} sync skipped - no active connection or environment credentials`,
      );
      return stats;
    }

    let anySuccess = false;

    for (const { connection, connector } of targets) {
      const connectionStats = {
        connectionId: connection?.id || null,
        platform,
        accountId: connection?.accountId || "ENV",
        status: "SUCCESS",
        fetched: 0,
        inserted: 0,
        updated: 0,
        failed: 0,
      };
      try {
        const rows = await connector.fetchDailyCampaignInsights({
          since,
          until,
          connection,
          onTokensRefreshed: (tokens) => persistRefreshedTokens(connection, tokens),
        });
        stats.fetched += rows.length;
        connectionStats.fetched += rows.length;

        for (const row of rows) {
          const check = validateNormalizedRow(row);
          if (!check.ok) {
            stats.failed += 1;
            connectionStats.failed += 1;
            log.warn(
              `[MarketingIntelligence] ${platform} rejected malformed row (${check.reason})`,
            );
            continue;
          }

          try {
            await storeRawInsight(row, connection);
            const outcome = await upsertSnapshot(row, connection);
            if (outcome === "inserted") {
              stats.inserted += 1;
              connectionStats.inserted += 1;
            } else {
              stats.updated += 1;
              connectionStats.updated += 1;
            }
          } catch (rowError) {
            stats.failed += 1;
            connectionStats.failed += 1;
            log.error(
              `[MarketingIntelligence] ${platform} failed to persist row for campaign ${row.campaignExternalId} on ${row.date}: ${sanitizeProviderText(rowError.message)}`,
            );
          }
        }

        await markConnectionSynced(connection);
        anySuccess = true;
      } catch (error) {
        stats.failed += 1;
        connectionStats.failed += 1;
        connectionStats.status = "FAILED";
        await markConnectionError(connection, error).catch(() => {});
        log.error(
          `[MarketingIntelligence] ${platform} sync failed: ${sanitizeProviderText(String(error.message || error))}`,
        );
      } finally {
        if (connectionStats.status !== "FAILED" && connectionStats.failed > 0) {
          connectionStats.status = "PARTIAL";
        }
        stats.connections.push(connectionStats);
      }
    }

    if (!anySuccess) {
      stats.status = "FAILED";
    } else if (stats.failed > 0) {
      stats.status = "PARTIAL";
    }

    return stats;
  }

  // Main entry point. Prevents overlapping runs via the distributed lock;
  // a skipped run returns { skipped: true } and is not an error.
  async function syncMarketingInsights({ since, until, platforms, connectionIds = [], trigger = "manual" } = {}) {
    assertValidRange(since, until);

    const requested = (platforms && platforms.length ? platforms : AD_PLATFORMS)
      .map((value) => String(value).toUpperCase())
      .filter((value) => AD_PLATFORMS.includes(value));

    if (requested.length === 0) {
      throw new ApiError(400, `platforms must contain at least one of: ${AD_PLATFORMS.join(", ")}`);
    }

    const owner = await lock.acquire(SYNC_LOCK_KEY);
    if (!owner) {
      log.info(
        `[MarketingIntelligence] Sync skipped (trigger=${trigger}) - another synchronization is already running`,
      );
      return { skipped: true, reason: "sync_already_running", trigger };
    }

    const startedAt = new Date();
    const result = { startedAt, completedAt: null, trigger, platforms: {} };

    try {
      for (const platform of requested) {
        result.platforms[platform] = await syncPlatform(platform, {
          since,
          until,
          connectionIds,
        });
      }
    } finally {
      await lock.release(SYNC_LOCK_KEY, owner).catch((releaseError) => {
        log.error(
          `[MarketingIntelligence] Failed to release sync lock: ${releaseError.message}`,
        );
      });
    }

    result.completedAt = new Date();

    const durationMs = result.completedAt.getTime() - startedAt.getTime();
    log.info(
      `[MarketingIntelligence] Sync finished (trigger=${trigger}, range=${since}..${until}, duration=${durationMs}ms): ${JSON.stringify(result.platforms)}`,
    );

    return result;
  }

  return {
    syncMarketingInsights,
    reconcileSnapshotFunnel,
    computeFunnelMetrics,
    upsertSnapshot,
    storeRawInsight,
  };
}

const defaultService = createAggregationService();

module.exports = {
  createAggregationService,
  deriveMetrics,
  resolvePlatformFromSource,
  SOURCE_PLATFORM_ALIASES,
  ...defaultService,
};
