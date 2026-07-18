const { prisma } = require("../../../../shared/config/database");
const {
  RETENTION_KEYS,
  getRetentionDays,
  loadSocialSettingMap,
  retentionCutoffFromDays,
  socialFeatureFlags,
} = require("./retention-settings.service");
const {
  redactMessageContent,
  redactCommentContent,
  redactInternalNoteContent,
  redactWebhookPayload,
} = require("./content-redaction.service");
const { redactLogPayload } = require("../security/log-redaction.service");

const DEFAULT_BATCH_SIZE = 50;

function redactionWorkerConfigFromEnv(env = process.env) {
  const flags = socialFeatureFlags(env);
  return {
    enabled: flags.redactionWorkerEnabled,
    batchSize: Math.min(
      500,
      Math.max(1, Number(env.SOCIAL_REDACTION_WORKER_BATCH_SIZE || DEFAULT_BATCH_SIZE)),
    ),
    dryRun: String(env.SOCIAL_REDACTION_WORKER_DRY_RUN || "false").toLowerCase() === "true",
  };
}

async function dueRows({ model, cutoff, batchSize }) {
  return model.findMany({
    where: {
      redactedAt: null,
      retentionExpiresAt: { lte: cutoff },
    },
    orderBy: { retentionExpiresAt: "asc" },
    take: batchSize,
  });
}

async function runRedactionBatch({
  db = prisma,
  settings,
  batchSize = DEFAULT_BATCH_SIZE,
  dryRun = false,
  now = () => new Date(),
  log,
  keyring,
  hashKey,
} = {}) {
  const started = Date.now();
  const settingMap = settings || (await loadSocialSettingMap({ db }));
  const summary = {
    enabled: true,
    dryRun,
    rowsExamined: 0,
    rowsRedacted: 0,
    failures: 0,
    missingSettings: [],
    durationMs: 0,
  };

  const plans = [
    ["messages", RETENTION_KEYS.MESSAGES_DAYS, db.socialMessage, redactMessageContent],
    ["comments", RETENTION_KEYS.COMMENTS_DAYS, db.socialComment, redactCommentContent],
    [
      "internalNotes",
      RETENTION_KEYS.INTERNAL_NOTES_DAYS,
      db.socialInternalNote,
      redactInternalNoteContent,
    ],
    [
      "webhookPayloads",
      RETENTION_KEYS.WEBHOOK_PAYLOAD_DAYS,
      db.socialWebhookEvent,
      redactWebhookPayload,
    ],
  ];

  for (const [name, key, model, redactor] of plans) {
    const retention = getRetentionDays(settingMap, key);
    if (!retention.configured) {
      summary.missingSettings.push(key);
      continue;
    }
    const cutoff = retentionCutoffFromDays(retention.days, { now: now() });
    const rows = await dueRows({ model, cutoff, batchSize });
    summary.rowsExamined += rows.length;
    if (dryRun) continue;
    for (const row of rows) {
      try {
        const result = await redactor({ id: row.id, db, keyring, hashKey, now });
        if (result.redacted) summary.rowsRedacted += 1;
      } catch (error) {
        summary.failures += 1;
        if (log?.warn) {
          log.warn(
            "[SocialOperations] Redaction row failed",
            redactLogPayload({ name, error: error.message }),
          );
        }
      }
    }
  }

  summary.durationMs = Date.now() - started;
  return summary;
}

async function runRedactionWorkerOnce({
  db = prisma,
  config = redactionWorkerConfigFromEnv(),
  settings,
  log,
  keyring,
  hashKey,
} = {}) {
  if (!config.enabled) {
    return { enabled: false, rowsExamined: 0, rowsRedacted: 0, failures: 0 };
  }
  return runRedactionBatch({
    db,
    settings,
    batchSize: config.batchSize,
    dryRun: config.dryRun,
    log,
    keyring,
    hashKey,
  });
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  redactionWorkerConfigFromEnv,
  runRedactionBatch,
  runRedactionWorkerOnce,
};
