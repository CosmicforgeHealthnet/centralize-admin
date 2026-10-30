const ApiError = require("../../../../shared/utils/ApiError");
const { prisma } = require("../../../../shared/config/database");
const {
  RETENTION_KEYS,
  REDACTION_KEYS,
  COMPLIANCE_KEYS,
  loadSocialSettingMap,
  settingValue,
  parsePositiveBoundedDays,
  socialFeatureFlags,
} = require("./retention-settings.service");

const REQUIRED_TEMPLATE_KEYS = Object.freeze([
  "safety.templates.medicalEmergencyReplyId",
  "safety.templates.selfHarmReplyId",
  "safety.templates.clinicalAdviceRedirectReplyId",
  "safety.templates.prescriptionRedirectReplyId",
  "safety.templates.privacyIncidentReplyId",
  "safety.templates.medicalMisinformationReplyId",
]);

const PLACEHOLDER_POLICY_VALUES = Object.freeze([
  "placeholder",
  "todo",
  "tbd",
  "draft",
  "changeme",
]);

function validTimestamp(value) {
  return value && !Number.isNaN(new Date(value).getTime());
}

function hasApprovedBoolean(settings, key) {
  return settingValue(settings, key) === true;
}

async function templateActive({ db, id }) {
  if (!id) return false;
  const reply = await db.socialSavedReply.findUnique({ where: { id } });
  return Boolean(reply && reply.status === "ACTIVE");
}

async function assertPhaseDComplianceReady({
  db = prisma,
  settings,
  env = process.env,
  restrictedVisibilityTestsPass = false,
  redactionWorkerPresent = true,
} = {}) {
  const settingMap = settings || (await loadSocialSettingMap({ db }));
  const missing = [];

  if (!hasApprovedBoolean(settingMap, COMPLIANCE_KEYS.PHASE_D_APPROVED)) {
    missing.push(COMPLIANCE_KEYS.PHASE_D_APPROVED);
  }
  const policyVersion = String(settingValue(settingMap, COMPLIANCE_KEYS.POLICY_VERSION) || "");
  if (
    !policyVersion ||
    PLACEHOLDER_POLICY_VALUES.includes(policyVersion.trim().toLowerCase())
  ) {
    missing.push(COMPLIANCE_KEYS.POLICY_VERSION);
  }
  if (!validTimestamp(settingValue(settingMap, COMPLIANCE_KEYS.LEGAL_REVIEWED_AT))) {
    missing.push(COMPLIANCE_KEYS.LEGAL_REVIEWED_AT);
  }
  if (!validTimestamp(settingValue(settingMap, COMPLIANCE_KEYS.PRIVACY_REVIEWED_AT))) {
    missing.push(COMPLIANCE_KEYS.PRIVACY_REVIEWED_AT);
  }

  for (const key of [
    COMPLIANCE_KEYS.DATA_SUBJECT_PROCEDURE_APPROVED,
    COMPLIANCE_KEYS.EMERGENCY_TEMPLATES_APPROVED,
    COMPLIANCE_KEYS.RETENTION_DURATIONS_APPROVED,
    COMPLIANCE_KEYS.REDACTION_FIELDS_APPROVED,
  ]) {
    if (!hasApprovedBoolean(settingMap, key)) missing.push(key);
  }

  for (const key of [
    RETENTION_KEYS.MESSAGES_DAYS,
    RETENTION_KEYS.COMMENTS_DAYS,
    RETENTION_KEYS.WEBHOOK_PAYLOAD_DAYS,
    RETENTION_KEYS.AUDIT_DAYS,
  ]) {
    try {
      const parsed = parsePositiveBoundedDays(settingValue(settingMap, key), key);
      if (!parsed.configured) missing.push(key);
    } catch {
      missing.push(key);
    }
  }

  for (const key of [
    REDACTION_KEYS.MESSAGE_FIELDS,
    REDACTION_KEYS.COMMENT_FIELDS,
    REDACTION_KEYS.WEBHOOK_FIELDS,
  ]) {
    if (!settingValue(settingMap, key)) missing.push(key);
  }

  for (const key of REQUIRED_TEMPLATE_KEYS) {
    if (!(await templateActive({ db, id: settingValue(settingMap, key) }))) {
      missing.push(key);
    }
  }

  if (!restrictedVisibilityTestsPass) missing.push("restrictedVisibility.testsPassed");
  if (!redactionWorkerPresent) missing.push("redaction.worker.present");
  if (!socialFeatureFlags(env).inboxEnabled) missing.push("SOCIAL_INBOX_ENABLED");

  if (missing.length) {
    throw new ApiError(503, "Social Phase D compliance configuration is incomplete", {
      missingKeys: [...new Set(missing)].sort(),
    });
  }

  return { ready: true, policyVersion };
}

module.exports = {
  REQUIRED_TEMPLATE_KEYS,
  assertPhaseDComplianceReady,
};
