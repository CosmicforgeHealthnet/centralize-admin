const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  redactMessageContent,
  redactCommentContent,
  redactInternalNoteContent,
  redactWebhookPayload,
} = require("../src/modules/marketing/social-operations/privacy/content-redaction.service");
const {
  runRedactionBatch,
  redactionWorkerConfigFromEnv,
} = require("../src/modules/marketing/social-operations/privacy/redaction-worker");
const {
  RETENTION_KEYS,
} = require("../src/modules/marketing/social-operations/privacy/retention-settings.service");
const {
  encryptBuffer,
} = require("../src/modules/marketing/social-operations/security/encryption.service");

function model(rows) {
  return {
    rows,
    async findUnique({ where }) {
      return rows.find((row) => row.id === where.id) || null;
    },
    async update({ where, data }) {
      const row = rows.find((candidate) => candidate.id === where.id);
      Object.assign(row, data);
      return row;
    },
    async findMany({ where, take }) {
      return rows
        .filter(
          (row) =>
            !row.redactedAt &&
            row.retentionExpiresAt &&
            row.retentionExpiresAt <= where.retentionExpiresAt.lte,
        )
        .slice(0, take);
    },
  };
}

function fakeDb() {
  return {
    socialMessage: model([
      {
        id: "message-1",
        content: "synthetic private message",
        contentHash: null,
        attachmentsJson: [{ secureUrl: "https://example.test/private" }],
        sensitiveDataState: "FLAGGED",
        retentionExpiresAt: new Date("2026-07-01T00:00:00Z"),
        redactedAt: null,
      },
    ]),
    socialComment: model([
      {
        id: "comment-1",
        providerCommentId: "provider-comment-1",
        text: "synthetic private comment",
        contentHash: null,
        sensitiveDataState: "FLAGGED",
        retentionExpiresAt: new Date("2026-07-01T00:00:00Z"),
        redactedAt: null,
      },
    ]),
    socialInternalNote: model([
      {
        id: "note-1",
        authorId: "admin-1",
        entityType: "COMMENT",
        entityId: "comment-1",
        text: "synthetic internal note",
        contentHash: null,
        sensitiveDataState: "CONFIRMED",
        retentionExpiresAt: new Date("2026-07-01T00:00:00Z"),
        redactedAt: null,
      },
    ]),
    socialWebhookEvent: model([
      {
        id: "webhook-1",
        provider: "META",
        eventId: "evt-1",
        payloadHash: "hash",
        encryptedRawPayload: encryptBuffer("synthetic raw payload", {
          purpose: "SOCIAL_WEBHOOK_PAYLOAD",
        }),
        retentionExpiresAt: new Date("2026-07-01T00:00:00Z"),
        redactedAt: null,
      },
    ]),
  };
}

test("content redaction removes plaintext while preserving identity metadata", async () => {
  const db = fakeDb();
  const audits = [];
  await redactMessageContent({
    id: "message-1",
    db,
    auditWriter: async (entry) => audits.push(entry),
  });
  assert.equal(db.socialMessage.rows[0].content, null);
  assert.ok(db.socialMessage.rows[0].contentHash);
  assert.deepEqual(db.socialMessage.rows[0].attachmentsJson, [{ redacted: true }]);
  assert.equal(db.socialMessage.rows[0].sensitiveDataState, "REDACTED");
  assert.ok(db.socialMessage.rows[0].redactedAt);

  await redactCommentContent({
    id: "comment-1",
    db,
    auditWriter: async (entry) => audits.push(entry),
  });
  assert.equal(db.socialComment.rows[0].text, null);
  assert.equal(db.socialComment.rows[0].providerCommentId, "provider-comment-1");
  assert.equal(db.socialComment.rows[0].sensitiveDataState, "REDACTED");

  await redactInternalNoteContent({
    id: "note-1",
    db,
    auditWriter: async (entry) => audits.push(entry),
  });
  assert.equal(db.socialInternalNote.rows[0].text, null);
  assert.equal(db.socialInternalNote.rows[0].authorId, "admin-1");
  assert.equal(db.socialInternalNote.rows[0].entityType, "COMMENT");
  assert.equal(JSON.stringify(audits).includes("synthetic private"), false);
});

test("redaction is idempotent and webhook tombstone is encrypted", async () => {
  const db = fakeDb();
  const first = await redactWebhookPayload({
    id: "webhook-1",
    db,
    auditWriter: async () => {},
  });
  const envelope = db.socialWebhookEvent.rows[0].encryptedRawPayload.toString("utf8");
  const second = await redactWebhookPayload({
    id: "webhook-1",
    db,
    auditWriter: async () => {},
  });
  assert.equal(first.redacted, true);
  assert.equal(second.redacted, false);
  assert.equal(envelope.includes("synthetic raw payload"), false);
  assert.ok(db.socialWebhookEvent.rows[0].redactedAt);
});

test("retention worker is disabled by default and fails safe without settings", async () => {
  assert.equal(redactionWorkerConfigFromEnv({}).enabled, false);
  const db = fakeDb();
  const summary = await runRedactionBatch({
    db,
    settings: new Map(),
    now: () => new Date("2026-07-16T00:00:00Z"),
  });
  assert.deepEqual(summary.missingSettings.sort(), [
    RETENTION_KEYS.COMMENTS_DAYS,
    RETENTION_KEYS.INTERNAL_NOTES_DAYS,
    RETENTION_KEYS.MESSAGES_DAYS,
    RETENTION_KEYS.WEBHOOK_PAYLOAD_DAYS,
  ].sort());
  assert.equal(summary.rowsRedacted, 0);
  assert.equal(db.socialMessage.rows[0].content, "synthetic private message");
});

test("retention worker supports dry-run and bounded batches", async () => {
  const db = fakeDb();
  const settings = new Map([
    [RETENTION_KEYS.MESSAGES_DAYS, 1],
    [RETENTION_KEYS.COMMENTS_DAYS, 1],
    [RETENTION_KEYS.INTERNAL_NOTES_DAYS, 1],
    [RETENTION_KEYS.WEBHOOK_PAYLOAD_DAYS, 1],
  ]);
  const dryRun = await runRedactionBatch({
    db,
    settings,
    batchSize: 1,
    dryRun: true,
    now: () => new Date("2026-07-16T00:00:00Z"),
  });
  assert.equal(dryRun.rowsExamined, 4);
  assert.equal(dryRun.rowsRedacted, 0);
  assert.equal(db.socialComment.rows[0].text, "synthetic private comment");

  const live = await runRedactionBatch({
    db,
    settings,
    batchSize: 1,
    now: () => new Date("2026-07-16T00:00:00Z"),
  });
  assert.equal(live.rowsRedacted, 4);
  assert.equal(db.socialInternalNote.rows[0].text, null);
});
