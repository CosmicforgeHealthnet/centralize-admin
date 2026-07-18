const CLASSIFICATION_PRIORITY = Object.freeze([
  "SELF_HARM_RISK",
  "MEDICAL_EMERGENCY",
  "PRIVACY_INCIDENT",
  "PROTECTED_HEALTH_INFORMATION",
  "PRESCRIPTION_REQUEST",
  "CLINICAL_ADVICE_REQUEST",
  "LEGAL_THREAT",
  "PATIENT_COMPLAINT",
  "MEDICAL_MISINFORMATION",
  "GENERAL_INQUIRY",
]);

const SIGNAL_RULES = Object.freeze([
  {
    classification: "SELF_HARM_RISK",
    reasonCode: "SELF_HARM_SIGNAL",
    pattern: /\b(self[-\s]?harm|harm myself|end my life|suicide|kill myself)\b/i,
  },
  {
    classification: "MEDICAL_EMERGENCY",
    reasonCode: "MEDICAL_EMERGENCY_SIGNAL",
    pattern: /\b(chest pain|cannot breathe|can't breathe|stroke|seizure|medical emergency|unconscious)\b/i,
  },
  {
    classification: "PRIVACY_INCIDENT",
    reasonCode: "PRIVACY_INCIDENT_SIGNAL",
    pattern: /\b(data breach|privacy breach|wrong patient|sent my records|exposed my information)\b/i,
  },
  {
    classification: "PROTECTED_HEALTH_INFORMATION",
    reasonCode: "PHI_SIGNAL",
    pattern: /\b(patient id|medical record|diagnosis|lab result|insurance number|date of birth|dob)\b/i,
  },
  {
    classification: "PRESCRIPTION_REQUEST",
    reasonCode: "PRESCRIPTION_SIGNAL",
    pattern: /\b(prescription|refill|dose|dosage|medication|pharmacy)\b/i,
  },
  {
    classification: "CLINICAL_ADVICE_REQUEST",
    reasonCode: "CLINICAL_ADVICE_SIGNAL",
    pattern: /\b(what should i do|medical advice|treatment|symptoms|diagnose|is this normal)\b/i,
  },
  {
    classification: "LEGAL_THREAT",
    reasonCode: "LEGAL_THREAT_SIGNAL",
    pattern: /\b(lawsuit|lawyer|attorney|sue you|legal action)\b/i,
  },
  {
    classification: "PATIENT_COMPLAINT",
    reasonCode: "PATIENT_COMPLAINT_SIGNAL",
    pattern: /\b(complaint|formal complaint|poor care|negligence|mistreatment)\b/i,
  },
  {
    classification: "MEDICAL_MISINFORMATION",
    reasonCode: "MEDICAL_MISINFORMATION_SIGNAL",
    pattern: /\b(fake cure|miracle cure|vaccines cause|hoax treatment|unproven cure)\b/i,
  },
]);

function sourceText(input) {
  return String(input?.text || input?.content || input?.body || "");
}

function preserveState(existingState, proposedState) {
  if (["CONFIRMED", "REDACTED"].includes(existingState)) return existingState;
  return proposedState;
}

function classifyInboundContent({
  text,
  content,
  sourceType = "MESSAGE",
  existingSensitiveDataState = "UNCLASSIFIED",
} = {}) {
  const raw = sourceText({ text, content });
  const matches = SIGNAL_RULES.filter((rule) => rule.pattern.test(raw));
  const classifications = matches.map((match) => match.classification);
  const classification =
    CLASSIFICATION_PRIORITY.find((item) => classifications.includes(item)) ||
    "GENERAL_INQUIRY";
  const sensitive = classification !== "GENERAL_INQUIRY";
  const sensitiveDataState = preserveState(
    existingSensitiveDataState,
    sensitive ? "FLAGGED" : "CLEAR",
  );

  return {
    classification,
    sourceType,
    sensitiveDataState,
    requiresEscalation: sensitive,
    restrictedVisibility: sensitive,
    urgency:
      classification === "SELF_HARM_RISK" || classification === "MEDICAL_EMERGENCY"
        ? "CRITICAL"
        : sensitive
          ? "HIGH"
          : "NORMAL",
    reasonCodes: matches.map((match) => match.reasonCode),
    matchedSignals: matches.map((match) => match.reasonCode),
    automationAllowed: false,
  };
}

module.exports = {
  CLASSIFICATION_PRIORITY,
  classifyInboundContent,
};
