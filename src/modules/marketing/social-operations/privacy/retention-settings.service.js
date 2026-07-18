const ApiError = require("../../../../shared/utils/ApiError");
const { prisma } = require("../../../../shared/config/database");

const RETENTION_KEYS = Object.freeze({
  MESSAGES_DAYS: "retention.messagesDays",
  COMMENTS_DAYS: "retention.commentsDays",
  INTERNAL_NOTES_DAYS: "retention.internalNotesDays",
  WEBHOOK_PAYLOAD_DAYS: "retention.webhookPayloadDays",
  PUBLIC_CONTENT_DAYS: "retention.publicContentDays",
  AUDIT_DAYS: "retention.auditDays",
});

const REDACTION_KEYS = Object.freeze({
  MESSAGE_FIELDS: "redaction.messageFields",
  COMMENT_FIELDS: "redaction.commentFields",
  INTERNAL_NOTE_FIELDS: "redaction.internalNoteFields",
  WEBHOOK_FIELDS: "redaction.webhookFields",
});

const COMPLIANCE_KEYS = Object.freeze({
  PHASE_D_APPROVED: "compliance.phaseDApproved",
  POLICY_VERSION: "compliance.policyVersion",
  LEGAL_REVIEWED_AT: "compliance.legalReviewedAt",
  PRIVACY_REVIEWED_AT: "compliance.privacyReviewedAt",
  DATA_SUBJECT_PROCEDURE_APPROVED: "compliance.dataSubjectProcedureApproved",
  EMERGENCY_TEMPLATES_APPROVED: "compliance.emergencyTemplatesApproved",
  RETENTION_DURATIONS_APPROVED: "compliance.retentionDurationsApproved",
  REDACTION_FIELDS_APPROVED: "compliance.redactionFieldsApproved",
});

const FEATURE_FLAGS = Object.freeze({
  SOCIAL_INBOX_ENABLED: "SOCIAL_INBOX_ENABLED",
  SOCIAL_PHASE_D_ENABLED: "SOCIAL_PHASE_D_ENABLED",
  SOCIAL_REDACTION_WORKER_ENABLED: "SOCIAL_REDACTION_WORKER_ENABLED",
});

function exactTrue(value) {
  return String(value || "").toLowerCase() === "true";
}

async function loadSocialSettingMap({ db = prisma } = {}) {
  const rows = await db.socialOperationsSetting.findMany({
    select: { key: true, valueJson: true },
  });
  return new Map(rows.map((row) => [row.key, row.valueJson]));
}

function settingValue(settings, key) {
  if (settings instanceof Map) return settings.get(key);
  return settings?.[key];
}

function parsePositiveBoundedDays(value, key, { min = 1, max = 3650 } = {}) {
  if (value === undefined || value === null || value === "") {
    return { configured: false, key, days: null };
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError(400, "Social retention setting is invalid", [
      { reasonCode: "SOCIAL_RETENTION_SETTING_INVALID", key },
    ]);
  }
  return { configured: true, key, days: parsed };
}

function getRetentionDays(settings, key) {
  return parsePositiveBoundedDays(settingValue(settings, key), key);
}

function retentionCutoffFromDays(days, { now = new Date() } = {}) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function featureFlagEnabled(name, env = process.env) {
  return exactTrue(env[name]);
}

function socialFeatureFlags(env = process.env) {
  return {
    inboxEnabled: featureFlagEnabled(FEATURE_FLAGS.SOCIAL_INBOX_ENABLED, env),
    phaseDEnabled: featureFlagEnabled(FEATURE_FLAGS.SOCIAL_PHASE_D_ENABLED, env),
    redactionWorkerEnabled: featureFlagEnabled(
      FEATURE_FLAGS.SOCIAL_REDACTION_WORKER_ENABLED,
      env,
    ),
  };
}

module.exports = {
  RETENTION_KEYS,
  REDACTION_KEYS,
  COMPLIANCE_KEYS,
  FEATURE_FLAGS,
  exactTrue,
  loadSocialSettingMap,
  settingValue,
  getRetentionDays,
  parsePositiveBoundedDays,
  retentionCutoffFromDays,
  featureFlagEnabled,
  socialFeatureFlags,
};
