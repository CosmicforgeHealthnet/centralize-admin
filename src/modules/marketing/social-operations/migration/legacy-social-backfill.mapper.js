const crypto = require("crypto");
const {
  assertSafeRemoteMediaUrl,
} = require("../security/ssrf-safe-fetch.service");

const LEGACY_MIGRATION_SOURCE = "LEGACY_MARKETING_SOCIAL";
const LEGACY_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  PUBLISHED_UNVERIFIED: "LEGACY_PUBLISHED_UNVERIFIED",
  SCHEDULED_UNVERIFIED: "LEGACY_SCHEDULED_UNVERIFIED",
});

const PASSWORD_CREDENTIAL_REASON = "PASSWORD_STYLE_CREDENTIAL_SKIPPED";

function asDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stringifySafe(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function normalizeLegacySourceId(row = {}) {
  const value = stringifySafe(row.id)?.trim();
  return value || null;
}

function normalizeLegacyStatus(row = {}) {
  return String(row.status || "Draft");
}

function extractCreatorId(row = {}) {
  for (const key of ["createdById", "authorId", "creatorId", "adminUserId", "createdBy"]) {
    const value = stringifySafe(row[key])?.trim();
    if (value) return value;
  }
  return null;
}

function getPostText(row = {}) {
  return String(row.caption || row.description || row.excerpt || "").trim();
}

function getPostTitle(row = {}) {
  const text = getPostText(row);
  return text ? text.slice(0, 120) : null;
}

function parseMediaArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [trimmed];
    } catch {
      return [trimmed];
    }
  }
  return [];
}

function collectMediaUrls(row = {}) {
  const values = [
    row.attachmentUrl,
    row.thumbnailUrl,
    row.imageUrl,
    ...parseMediaArray(row.attachmentUrls),
  ]
    .map((value) => stringifySafe(value)?.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function safeMediaReference(url) {
  try {
    const parsed = new URL(url);
    return {
      hostname: parsed.hostname,
      protocol: parsed.protocol,
      urlHash: hashValue(url),
    };
  } catch {
    return {
      hostname: null,
      protocol: null,
      urlHash: hashValue(url),
    };
  }
}

function classifyMediaUrl(url, options = {}) {
  const reference = safeMediaReference(url);
  if (!options.validateMedia) {
    return { ...reference, status: "VALIDATION_NOT_EXECUTED" };
  }
  try {
    assertSafeRemoteMediaUrl({
      url,
      allowedHosts: options.allowedHosts,
      allowedSubdomainSuffixes: options.allowedSubdomainSuffixes,
      allowHttpLocalTest: options.allowHttpLocalTest,
      nodeEnv: options.nodeEnv,
    });
    return { ...reference, status: "STRUCTURALLY_ALLOWED_FETCH_NOT_EXECUTED" };
  } catch (error) {
    return {
      ...reference,
      status: "BLOCKED",
      reason: error.message || "Remote media URL is not allowed",
    };
  }
}

function classifyStatus(row = {}, migrationReferenceTime = new Date()) {
  const status = normalizeLegacyStatus(row);
  const postedAt = asDate(row.postedAt || row.publishedAt);
  const scheduledFor = asDate(row.scheduledFor || row.scheduledAt);
  const hasPublishedSignal = Boolean(postedAt) || /^published$/i.test(status);
  const hasFutureSchedule = Boolean(scheduledFor && scheduledFor > migrationReferenceTime);
  if (hasPublishedSignal && hasFutureSchedule) {
    return {
      status: null,
      blockingReason: "CONFLICTING_STATUS_TIMESTAMPS",
    };
  }
  if (hasFutureSchedule) return { status: LEGACY_STATUS.SCHEDULED_UNVERIFIED };
  if (hasPublishedSignal) return { status: LEGACY_STATUS.PUBLISHED_UNVERIFIED };
  return { status: LEGACY_STATUS.DRAFT };
}

function buildInitialRevisionSnapshot({ row, mediaReferences }) {
  return {
    migrationSource: LEGACY_MIGRATION_SOURCE,
    legacySourceId: normalizeLegacySourceId(row),
    legacyStatus: normalizeLegacyStatus(row),
    legacyPostedAt: asDate(row.postedAt || row.publishedAt)?.toISOString() || null,
    legacyScheduledAt: asDate(row.scheduledFor || row.scheduledAt)?.toISOString() || null,
    legacyProvider: stringifySafe(row.platform),
    mediaReferences,
    providerConfirmation: false,
  };
}

function createEmptyCounts() {
  return {
    totalLegacyRows: 0,
    eligibleRows: 0,
    alreadyMigratedRows: 0,
    draftRows: 0,
    legacyPublishedUnverifiedRows: 0,
    legacyScheduledUnverifiedRows: 0,
    independentlyVerifiedProviderRows: 0,
    skippedUnresolvedCreatorRows: 0,
    skippedMalformedRows: 0,
    conflictingStatusTimestampRows: 0,
    duplicateLegacySourceIds: 0,
    totalMediaUrlsDiscovered: 0,
    validMediaUrls: 0,
    unreachableMediaUrls: 0,
    unsafeBlockedMediaUrls: 0,
    invalidMediaContentTypes: 0,
    mediaUrlsExceedingSizeLimits: 0,
    mediaRowsMissingValidOwner: 0,
    legacyCredentialRowsDetected: 0,
    passwordStyleCredentialRowsSkipped: 0,
    oauthStyleRowsRequiringAuthorization: 0,
    rowsRequiringHumanReconnection: 0,
    socialPostsWouldBeInserted: 0,
    initialRevisionsWouldBeInserted: 0,
    mediaAssetsWouldBeInserted: 0,
    publicationsWouldBeInserted: 0,
    targetsWouldBeInserted: 0,
    errors: 0,
    warnings: 0,
  };
}

function countCredentialRows(accounts = []) {
  return accounts.reduce(
    (counts, account) => {
      counts.legacyCredentialRowsDetected += 1;
      if (account.encryptedPassword || account.credentialsSaved || account.username) {
        counts.passwordStyleCredentialRowsSkipped += 1;
        counts.rowsRequiringHumanReconnection += 1;
      }
      counts.oauthStyleRowsRequiringAuthorization += 1;
      return counts;
    },
    {
      legacyCredentialRowsDetected: 0,
      passwordStyleCredentialRowsSkipped: 0,
      oauthStyleRowsRequiringAuthorization: 0,
      rowsRequiringHumanReconnection: 0,
    },
  );
}

function countStatuses(counts, status) {
  if (status === LEGACY_STATUS.DRAFT) counts.draftRows += 1;
  if (status === LEGACY_STATUS.PUBLISHED_UNVERIFIED) {
    counts.legacyPublishedUnverifiedRows += 1;
  }
  if (status === LEGACY_STATUS.SCHEDULED_UNVERIFIED) {
    counts.legacyScheduledUnverifiedRows += 1;
  }
}

function computeReportChecksum(report) {
  const stable = {
    counts: report.counts,
    eligibleLegacySourceIds: report.eligibleRows.map((row) => row.legacySourceId).sort(),
    skippedRows: report.skippedRows
      .map((row) => `${row.legacySourceId || "unknown"}:${row.reason}`)
      .sort(),
  };
  return hashValue(JSON.stringify(stable));
}

function evaluateLegacySocialBackfill({
  legacyRows = [],
  legacyAccounts = [],
  adminUsers = [],
  existingLegacySourceIds = [],
  migrationReferenceTime = new Date(),
  mediaOptions = {},
} = {}) {
  const counts = createEmptyCounts();
  const adminIds = new Set(adminUsers.map((admin) => String(admin.id)));
  const migratedIds = new Set(existingLegacySourceIds.filter(Boolean).map(String));
  const seenIds = new Set();
  const duplicatedIds = new Set();
  const eligibleRows = [];
  const skippedRows = [];
  const media = [];

  Object.assign(counts, countCredentialRows(legacyAccounts));
  counts.totalLegacyRows = legacyRows.length;

  for (const row of legacyRows) {
    const legacySourceId = normalizeLegacySourceId(row);
    if (!legacySourceId) {
      counts.skippedMalformedRows += 1;
      counts.errors += 1;
      skippedRows.push({ legacySourceId: null, reason: "MALFORMED_LEGACY_ID" });
      continue;
    }
    if (seenIds.has(legacySourceId)) duplicatedIds.add(legacySourceId);
    seenIds.add(legacySourceId);
  }
  counts.duplicateLegacySourceIds = duplicatedIds.size;

  for (const row of legacyRows) {
    const legacySourceId = normalizeLegacySourceId(row);
    if (!legacySourceId) continue;

    const mediaUrls = collectMediaUrls(row);
    counts.totalMediaUrlsDiscovered += mediaUrls.length;
    const mediaReferences = mediaUrls.map((url) => classifyMediaUrl(url, mediaOptions));
    for (const item of mediaReferences) {
      media.push({ legacySourceId, ...item });
      if (item.status === "BLOCKED") counts.unsafeBlockedMediaUrls += 1;
      else if (item.status === "VALIDATION_NOT_EXECUTED") counts.warnings += 1;
      else counts.validMediaUrls += 1;
    }

    if (migratedIds.has(legacySourceId)) {
      counts.alreadyMigratedRows += 1;
      skippedRows.push({ legacySourceId, reason: "ALREADY_MIGRATED" });
      continue;
    }
    if (duplicatedIds.has(legacySourceId)) {
      counts.errors += 1;
      skippedRows.push({ legacySourceId, reason: "DUPLICATE_LEGACY_SOURCE_ID" });
      continue;
    }

    const statusResult = classifyStatus(row, migrationReferenceTime);
    if (statusResult.blockingReason) {
      counts.conflictingStatusTimestampRows += 1;
      counts.errors += 1;
      skippedRows.push({ legacySourceId, reason: statusResult.blockingReason });
      continue;
    }

    const creatorId = extractCreatorId(row);
    if (!creatorId || !adminIds.has(creatorId)) {
      counts.skippedUnresolvedCreatorRows += 1;
      counts.errors += 1;
      skippedRows.push({ legacySourceId, reason: "CREATOR_UNRESOLVED" });
      continue;
    }

    const title = getPostTitle(row);
    const baseText = getPostText(row) || "(legacy social post had no text)";
    const mapped = {
      legacySourceId,
      status: statusResult.status,
      createdById: creatorId,
      title,
      baseText,
      currentVersion: 1,
      createdAt: asDate(row.createdAt) || migrationReferenceTime,
      updatedAt: asDate(row.updatedAt) || asDate(row.createdAt) || migrationReferenceTime,
      revision: {
        version: 1,
        title,
        baseText,
        createdById: creatorId,
        createdAt: asDate(row.updatedAt) || asDate(row.createdAt) || migrationReferenceTime,
        changeSummary: "Initial legacy marketing social migration snapshot",
        snapshotJson: buildInitialRevisionSnapshot({ row, mediaReferences }),
      },
    };

    countStatuses(counts, mapped.status);
    counts.eligibleRows += 1;
    counts.socialPostsWouldBeInserted += 1;
    counts.initialRevisionsWouldBeInserted += 1;
    eligibleRows.push(mapped);
  }

  const report = {
    migrationSource: LEGACY_MIGRATION_SOURCE,
    migrationReferenceTime: migrationReferenceTime.toISOString(),
    counts,
    blockingIssueCount:
      counts.skippedUnresolvedCreatorRows +
      counts.skippedMalformedRows +
      counts.conflictingStatusTimestampRows +
      counts.duplicateLegacySourceIds,
    eligibleRows,
    skippedRows,
    media,
    credentialPolicy: {
      passwordCredentialAction: PASSWORD_CREDENTIAL_REASON,
      socialConnectionsRequireFreshOAuth: true,
    },
  };
  report.reportChecksum = computeReportChecksum(report);
  return report;
}

function markdownReport(report) {
  const lines = [
    "# Social Operations Legacy Migration Reconciliation",
    "",
    `Migration source: ${report.migrationSource}`,
    `Reference time: ${report.migrationReferenceTime}`,
    `Checksum: ${report.reportChecksum}`,
    "",
    "## Counts",
    "",
    "| Metric | Count |",
    "|---|---:|",
  ];
  for (const [key, value] of Object.entries(report.counts)) {
    lines.push(`| ${key} | ${value} |`);
  }
  lines.push(
    "",
    "## Blocking Rows",
    "",
    "| legacySourceId | reason |",
    "|---|---|",
  );
  for (const row of report.skippedRows.filter((item) => item.reason !== "ALREADY_MIGRATED")) {
    lines.push(`| ${row.legacySourceId || ""} | ${row.reason} |`);
  }
  lines.push(
    "",
    "## Credential Policy",
    "",
    "Password-style legacy provider credentials are not migrated. Social provider connections require fresh human-driven OAuth authorization.",
  );
  return `${lines.join("\n")}\n`;
}

module.exports = {
  LEGACY_MIGRATION_SOURCE,
  LEGACY_STATUS,
  PASSWORD_CREDENTIAL_REASON,
  collectMediaUrls,
  classifyStatus,
  evaluateLegacySocialBackfill,
  markdownReport,
  normalizeLegacySourceId,
};
