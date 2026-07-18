const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  LEGACY_STATUS,
  collectMediaUrls,
  classifyStatus,
  evaluateLegacySocialBackfill,
  markdownReport,
} = require("../src/modules/marketing/social-operations/migration/legacy-social-backfill.mapper");

const now = new Date("2026-07-17T20:00:00.000Z");
const admin = { id: "admin-1" };

test("legacy backfill maps draft, unverified published and unverified scheduled rows", () => {
  const report = evaluateLegacySocialBackfill({
    migrationReferenceTime: now,
    adminUsers: [admin],
    legacyRows: [
      {
        id: "legacy-draft",
        createdById: admin.id,
        platform: "Facebook",
        caption: "draft caption",
        status: "Draft",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "legacy-published",
        createdById: admin.id,
        platform: "LinkedIn",
        caption: "published caption",
        status: "Published",
        postedAt: new Date("2026-07-01T10:00:00.000Z"),
      },
      {
        id: "legacy-scheduled",
        createdById: admin.id,
        platform: "Instagram",
        caption: "scheduled caption",
        status: "Scheduled",
        scheduledFor: new Date("2026-08-01T10:00:00.000Z"),
      },
    ],
  });

  assert.equal(report.blockingIssueCount, 0);
  assert.equal(report.counts.eligibleRows, 3);
  assert.equal(report.counts.draftRows, 1);
  assert.equal(report.counts.legacyPublishedUnverifiedRows, 1);
  assert.equal(report.counts.legacyScheduledUnverifiedRows, 1);
  assert.equal(report.counts.socialPostsWouldBeInserted, 3);
  assert.equal(report.counts.initialRevisionsWouldBeInserted, 3);
  assert.equal(report.counts.publicationsWouldBeInserted, 0);
  assert.equal(report.counts.targetsWouldBeInserted, 0);
  assert.deepEqual(
    report.eligibleRows.map((row) => row.status),
    [
      LEGACY_STATUS.DRAFT,
      LEGACY_STATUS.PUBLISHED_UNVERIFIED,
      LEGACY_STATUS.SCHEDULED_UNVERIFIED,
    ],
  );
});

test("legacy backfill blocks unresolved creators, conflicts, duplicates and already migrated rows", () => {
  const report = evaluateLegacySocialBackfill({
    migrationReferenceTime: now,
    adminUsers: [admin],
    existingLegacySourceIds: ["already-migrated"],
    legacyRows: [
      {
        id: "unresolved",
        platform: "Facebook",
        caption: "no creator",
        status: "Draft",
      },
      {
        id: "conflict",
        createdById: admin.id,
        platform: "Facebook",
        caption: "conflict",
        status: "Published",
        postedAt: new Date("2026-07-01T10:00:00.000Z"),
        scheduledFor: new Date("2026-08-01T10:00:00.000Z"),
      },
      {
        id: "duplicate",
        createdById: admin.id,
        platform: "Facebook",
        caption: "duplicate one",
      },
      {
        id: "duplicate",
        createdById: admin.id,
        platform: "Facebook",
        caption: "duplicate two",
      },
      {
        id: "already-migrated",
        createdById: admin.id,
        platform: "Facebook",
        caption: "existing",
      },
    ],
  });

  assert.equal(report.counts.skippedUnresolvedCreatorRows, 1);
  assert.equal(report.counts.conflictingStatusTimestampRows, 1);
  assert.equal(report.counts.duplicateLegacySourceIds, 1);
  assert.equal(report.counts.alreadyMigratedRows, 1);
  assert.equal(report.counts.socialPostsWouldBeInserted, 0);
  assert.ok(report.blockingIssueCount >= 3);
  assert.ok(report.reportChecksum);
});

test("legacy media and credentials are reported without exposing credential values", () => {
  const report = evaluateLegacySocialBackfill({
    migrationReferenceTime: now,
    adminUsers: [admin],
    legacyAccounts: [
      {
        id: "account-1",
        platform: "Facebook",
        username: "legacy-user",
        encryptedPassword: "secret-ciphertext",
        credentialsSaved: true,
      },
    ],
    legacyRows: [
      {
        id: "media-row",
        createdById: admin.id,
        platform: "Facebook",
        caption: "media row",
        attachmentUrl: "https://media.example.com/asset.png",
        attachmentUrls: ["https://media.example.com/asset.png", "https://media.example.com/two.png"],
      },
    ],
  });

  assert.equal(report.counts.legacyCredentialRowsDetected, 1);
  assert.equal(report.counts.passwordStyleCredentialRowsSkipped, 1);
  assert.equal(report.counts.rowsRequiringHumanReconnection, 1);
  assert.equal(report.counts.totalMediaUrlsDiscovered, 2);
  assert.equal(report.media.every((item) => item.status === "VALIDATION_NOT_EXECUTED"), true);
  assert.equal(JSON.stringify(report).includes("secret-ciphertext"), false);
  assert.equal(markdownReport(report).includes("secret-ciphertext"), false);
});

test("status classifier refuses conflicting future schedule and published signal", () => {
  assert.equal(
    classifyStatus(
      {
        status: "Scheduled",
        scheduledFor: "2026-08-01T00:00:00.000Z",
        postedAt: "2026-07-01T00:00:00.000Z",
      },
      now,
    ).blockingReason,
    "CONFLICTING_STATUS_TIMESTAMPS",
  );
});

test("media collection deduplicates legacy media fields", () => {
  assert.deepEqual(
    collectMediaUrls({
      attachmentUrl: "https://example.com/a.png",
      imageUrl: "https://example.com/a.png",
      attachmentUrls: ["https://example.com/b.png"],
    }),
    ["https://example.com/a.png", "https://example.com/b.png"],
  );
});
