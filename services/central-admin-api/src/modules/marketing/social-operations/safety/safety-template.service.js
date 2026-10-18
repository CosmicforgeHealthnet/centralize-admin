const ApiError = require("../../../../shared/utils/ApiError");
const { prisma } = require("../../../../shared/config/database");
const {
  COMPLIANCE_KEYS,
  loadSocialSettingMap,
  settingValue,
} = require("../privacy/retention-settings.service");

const TEMPLATE_SETTING_BY_CLASSIFICATION = Object.freeze({
  MEDICAL_EMERGENCY: "safety.templates.medicalEmergencyReplyId",
  SELF_HARM_RISK: "safety.templates.selfHarmReplyId",
  CLINICAL_ADVICE_REQUEST: "safety.templates.clinicalAdviceRedirectReplyId",
  PRESCRIPTION_REQUEST: "safety.templates.prescriptionRedirectReplyId",
  PRIVACY_INCIDENT: "safety.templates.privacyIncidentReplyId",
  MEDICAL_MISINFORMATION: "safety.templates.medicalMisinformationReplyId",
});

function approvedVariables(reply) {
  const config = reply?.variablesJson || {};
  if (Array.isArray(config.allowedVariables)) return new Set(config.allowedVariables);
  return new Set(Object.keys(config));
}

async function resolveApprovedSafetyTemplate({
  classification,
  channel,
  variables = {},
  db = prisma,
  settings,
} = {}) {
  const settingMap = settings || (await loadSocialSettingMap({ db }));
  if (settingValue(settingMap, COMPLIANCE_KEYS.EMERGENCY_TEMPLATES_APPROVED) !== true) {
    throw new ApiError(409, "Approved Social safety template is unavailable", {
      missingKeys: [COMPLIANCE_KEYS.EMERGENCY_TEMPLATES_APPROVED],
    });
  }

  const settingKey = TEMPLATE_SETTING_BY_CLASSIFICATION[classification];
  const replyId = settingValue(settingMap, settingKey);
  if (!replyId) {
    throw new ApiError(409, "Approved Social safety template is unavailable", {
      missingKeys: [settingKey],
    });
  }
  const reply = await db.socialSavedReply.findUnique({ where: { id: replyId } });
  if (!reply || reply.status !== "ACTIVE" || reply.channel !== channel) {
    throw new ApiError(409, "Approved Social safety template is unavailable", {
      missingKeys: [settingKey],
    });
  }
  const allowed = approvedVariables(reply);
  for (const key of Object.keys(variables)) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "Template variable is not allowed");
    }
  }
  return {
    id: reply.id,
    name: reply.name,
    channel: reply.channel,
    text: reply.text,
    variablesJson: reply.variablesJson,
    sendsProviderMessage: false,
  };
}

module.exports = {
  TEMPLATE_SETTING_BY_CLASSIFICATION,
  resolveApprovedSafetyTemplate,
};
