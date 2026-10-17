const { prisma } = require("../../../../shared/config/database");
const { createSyncLock } = require("../aggregation/sync-lock");
const { persistRefreshedConnectionTokens } = require("../aggregation/aggregation.service");
const { createRunLedgerService } = require("../run-ledger.service");
const { requireOperationActor } = require("../actor-validation");
const { createSettingsService } = require("../settings.service");
const { createCreativeRegistry } = require("./creative.registry");
const { createCreativeRepository } = require("./creative.repository");
const { sanitizeProviderText } = require("../connectors/provider-http");
const { AD_PLATFORMS } = require("../platforms");
const { EVENTS, logEvent, providerFailure } = require("../observability");

const CREATIVE_SYNC_LOCK_KEY = "marketing:intelligence:creative-sync";
const DEFAULT_PAGE_LIMIT = 200;
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_MAX_ROWS = 50000;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultRange() {
  const until = new Date();
  const since = new Date(until.getTime() - 6 * 86400000);
  return { since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) };
}

function safeFailure(error) {
  return {
    errorCode: String(error?.code || error?.category || "CREATIVE_SYNC_FAILED").slice(0, 100),
    retryable: Boolean(error?.retryable),
    sanitizedMessage: sanitizeProviderText(String(error?.message || "Creative synchronization failed")).slice(0, 500),
  };
}

function createCreativeSyncService({
  prisma: db = prisma,
  registry = createCreativeRegistry(),
  repository,
  syncLock,
  runLedger,
  settingsService,
  log,
} = {}) {
  const repo = repository || createCreativeRepository({ prisma: db });
  const lock = syncLock || createSyncLock({ prisma: db });
  const ledger = runLedger || createRunLedgerService({ prisma: db });
  const settingsResolver = settingsService || createSettingsService({ prisma: db });

  async function fetchPages({ kind, connector, connection, since, until, persist }) {
    const maxPages = positiveInt(process.env.MARKETING_CREATIVE_SYNC_MAX_PAGES, DEFAULT_MAX_PAGES);
    const maxRows = positiveInt(process.env.MARKETING_CREATIVE_SYNC_MAX_ROWS, DEFAULT_MAX_ROWS);
    const limit = positiveInt(process.env.MARKETING_CREATIVE_SYNC_PAGE_SIZE, DEFAULT_PAGE_LIMIT);
    const seen = new Set();
    let cursor = null;
    let processed = 0;
    let pages = 0;
    let partial = false;
    let capability = connector.getCapability(connection);

    while (pages < maxPages && processed < maxRows) {
      const pageCursor = cursor;
      let page;
      try {
        const onTokensRefreshed = (tokens) => persistRefreshedConnectionTokens({
          db,
          connection,
          tokens,
        });
        page = kind === "catalog"
          ? await connector.fetchCreativeCatalog({ connection, since, until, cursor, limit, onTokensRefreshed })
          : await connector.fetchCreativeInsights({ connection, since, until, cursor, limit, onTokensRefreshed });
      } catch (error) {
        error.creativeProgress = { kind, processed, pages, nextCursor: cursor };
        throw error;
      }
      capability = page.capability || capability;
      if (capability.status !== "AVAILABLE" || !(kind === "catalog" ? capability.supportsCreativeCatalog : capability.supportsCreativeInsights)) {
        return { status: "UNSUPPORTED", processed, pages, partial: false, capability, nextCursor: null };
      }
      const records = kind === "catalog" ? page.items : page.rows;
      const remaining = maxRows - processed;
      const accepted = records.slice(0, remaining);
      await persist({
        connection,
        since,
        until,
        cursor: pageCursor,
        page: pages + 1,
        providerRequestId: page.providerRequestId,
        capability,
        rawResponse: page.rawResponse,
      }, accepted);
      processed += accepted.length;
      pages += 1;
      cursor = page.nextCursor || null;
      if (!cursor) break;
      if (seen.has(cursor)) {
        partial = true;
        break;
      }
      seen.add(cursor);
      if (accepted.length < records.length || pages >= maxPages || processed >= maxRows) partial = true;
    }

    return { status: partial ? "PARTIAL" : "SUCCEEDED", processed, pages, partial, capability, nextCursor: partial ? cursor : null };
  }

  async function processConnection(connection, context = {}) {
    const connector = registry[connection.platform];
    const base = {
      platform: connection.platform,
      connectionId: connection.id,
      status: "FAILED",
      catalogProcessedCount: 0,
      insightProcessedCount: 0,
    };
    if (!connector) return { ...base, errorCode: "UNSUPPORTED_PLATFORM", retryable: false, sanitizedMessage: "No creative connector registered" };

    let catalog = null;
    let insights = null;
    try {
      catalog = await fetchPages({
        kind: "catalog", connector, connection,
        since: connection.__since, until: connection.__until,
        persist: repo.persistCatalogPage,
      });
      insights = await fetchPages({
        kind: "insight", connector, connection,
        since: connection.__since, until: connection.__until,
        persist: repo.persistInsightPage,
      });
      const supported = [catalog, insights].filter((result) => result.status !== "UNSUPPORTED");
      const partial = supported.some((result) => result.partial);
      return {
        ...base,
        status: supported.length === 0 ? "UNSUPPORTED" : partial ? "PARTIAL_SUCCESS" : "SUCCEEDED",
        catalogProcessedCount: catalog.processed,
        insightProcessedCount: insights.processed,
        catalog,
        insights,
        capability: connector.getCapability(connection),
      };
    } catch (error) {
      const progress = error?.creativeProgress || {};
      const catalogProcessedCount = catalog?.processed
        || (progress.kind === "catalog" ? progress.processed || 0 : 0);
      const insightProcessedCount = insights?.processed
        || (progress.kind === "insight" ? progress.processed || 0 : 0);
      const partialPersistence = catalogProcessedCount + insightProcessedCount > 0;
      const failure = safeFailure(error);
      logEvent(EVENTS.PROVIDER_FAILURE, {
        runId: context.runId || null, platform: connection.platform, connectionId: connection.id,
        ...providerFailure(error), attempt: 1, safeRequestId: null, operation: "CREATIVE_SYNC", status: "FAILED",
      }, { log, level: "warn" });
      return {
        ...base,
        status: partialPersistence ? "PARTIAL_SUCCESS" : "FAILED",
        catalogProcessedCount,
        insightProcessedCount,
        partialPersistence,
        ...failure,
      };
    }
  }

  async function syncCreatives({ since, until, platforms, connectionIds, trigger = "INTERNAL", requestedByAdminUserId } = {}) {
    const operationStartedAt = Date.now();
    await requireOperationActor(db, { trigger, requestedByAdminUserId });
    const fallback = defaultRange();
    const range = { since: since || fallback.since, until: until || fallback.until };
    const requestedPlatforms = platforms?.length
      ? platforms.map((value) => String(value).toUpperCase())
      : AD_PLATFORMS;
    let run = await ledger.startRun({
      runType: "CREATIVE_SYNC", status: "STARTED", trigger, requestedByAdminUserId,
      windowStart: new Date(`${range.since}T00:00:00Z`),
      windowEnd: new Date(`${range.until}T23:59:59.999Z`),
    });
    logEvent(EVENTS.CREATIVE_SYNC_STARTED, {
      runId: run?.id || null, platform: requestedPlatforms.length === 1 ? requestedPlatforms[0] : "all", connectionId: connectionIds?.length === 1 ? connectionIds[0] : null,
      windowStart: `${range.since}T00:00:00.000Z`, windowEnd: `${range.until}T23:59:59.999Z`, cursorCount: 0,
      rowsProcessed: 0, rowsCreated: 0, rowsUpdated: 0, durationMs: 0, status: "STARTED", trigger,
    }, { log });
    const owner = await lock.acquire(CREATIVE_SYNC_LOCK_KEY);
    if (!owner) {
      await ledger.finishRun(run?.id, { status: "SKIPPED_LOCKED", summary: { reasonCode: "LOCK_UNAVAILABLE", lockScope: CREATIVE_SYNC_LOCK_KEY } });
      return { skipped: true, reason: "creative_sync_already_running", ...(run?.id ? { runId: run.id } : {}) };
    }

    const startedAt = new Date();
    let heartbeat;
    const results = [];
    try {
      await ledger.updateRun?.(run?.id, { lockKey: CREATIVE_SYNC_LOCK_KEY, lockOwner: owner, startedAt });
      heartbeat = lock.startHeartbeat({ key: CREATIVE_SYNC_LOCK_KEY, owner });
      const connections = await db.marketing_ad_platform_connections.findMany({
        where: {
          status: "ACTIVE",
          platform: { in: requestedPlatforms },
          ...(connectionIds?.length ? { id: { in: connectionIds } } : {}),
        },
        orderBy: [{ platform: "asc" }, { id: "asc" }],
      });
      for (const connection of connections) {
        const toggle = await settingsResolver.resolveSettings({ platform: connection.platform, connectionId: connection.id, currencyCode: connection.currency }, { keys: ["creativeSyncEnabled"] });
        if (!toggle.values.creativeSyncEnabled) {
          results.push({ platform: connection.platform, connectionId: connection.id, status: "SKIPPED_DISABLED", catalogProcessedCount: 0, insightProcessedCount: 0, reasonCode: "CREATIVE_SYNC_DISABLED" });
          continue;
        }
        results.push(await processConnection({ ...connection, __since: range.since, __until: range.until }, { runId: run?.id }));
        if (heartbeat.failed()) break;
      }
      const successCount = results.filter((item) => ["SUCCEEDED", "PARTIAL_SUCCESS", "SKIPPED_DISABLED"].includes(item.status)).length;
      const failedCount = results.filter((item) => item.status === "FAILED").length;
      const status = heartbeat.failed()
        ? "LOCK_RENEWAL_FAILED"
        : failedCount === 0 && successCount > 0 && results.every((item) => item.status === "SUCCEEDED")
          ? "SUCCEEDED"
          : successCount > 0
            ? "PARTIAL_SUCCESS"
            : "FAILED";
      const processedCount = results.reduce((sum, item) => sum + item.catalogProcessedCount + item.insightProcessedCount, 0);
      await ledger.finishRun(run?.id, {
        status,
        processedCount,
        succeededCount: successCount,
        failedCount,
        summary: { range, results },
        ...(heartbeat.failed() ? { errorCode: "LOCK_RENEWAL_FAILED", sanitizedError: heartbeat.lastError()?.message } : {}),
      });
      logEvent(EVENTS.CREATIVE_SYNC_COMPLETED, {
        runId: run?.id || null, platform: requestedPlatforms.length === 1 ? requestedPlatforms[0] : "all", connectionId: connectionIds?.length === 1 ? connectionIds[0] : null,
        windowStart: `${range.since}T00:00:00.000Z`, windowEnd: `${range.until}T23:59:59.999Z`,
        cursorCount: results.reduce((sum, item) => sum + Number(item.catalog?.pages || 0) + Number(item.insights?.pages || 0), 0),
        rowsProcessed: processedCount, rowsCreated: null, rowsUpdated: null, durationMs: Date.now() - operationStartedAt, status, trigger,
        pageCount: results.reduce((sum, item) => sum + Number(item.catalog?.pages || 0) + Number(item.insights?.pages || 0), 0),
        retryCount: 0, partial: status === "PARTIAL_SUCCESS",
      }, { log, level: status === "FAILED" ? "error" : "info" });
      return { skipped: false, status, range, processedCount, results, runId: run?.id || null };
    } catch (error) {
      await ledger.finishRun(run?.id, { status: "FAILED", errorCode: error.code || "CREATIVE_SYNC_FAILED", sanitizedError: error.message, summary: { range, results } }).catch(() => {});
      throw error;
    } finally {
      heartbeat?.stop();
      await lock.release(CREATIVE_SYNC_LOCK_KEY, owner).catch(() => {});
    }
  }

  return { syncCreatives, processConnection, fetchPages };
}

const defaultService = createCreativeSyncService();
const { runPhase2Operation } = require("../phase2-feature");
module.exports = {
  CREATIVE_SYNC_LOCK_KEY,
  createCreativeSyncService,
  syncCreatives: (...args) => runPhase2Operation("CREATIVE_SYNC", () => defaultService.syncCreatives(...args)),
};
