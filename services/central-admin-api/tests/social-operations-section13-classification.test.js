const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  CLASSIFICATION_PRIORITY,
  classifyInboundContent,
} = require("../src/modules/marketing/social-operations/safety/inbound-classification.service");

const CASES = [
  ["MEDICAL_EMERGENCY", "medical emergency chest pain"],
  ["SELF_HARM_RISK", "I might harm myself"],
  ["CLINICAL_ADVICE_REQUEST", "what should I do about symptoms"],
  ["PRESCRIPTION_REQUEST", "can I get a prescription refill"],
  ["PROTECTED_HEALTH_INFORMATION", "my patient id and diagnosis are visible"],
  ["PRIVACY_INCIDENT", "wrong patient data breach"],
  ["PATIENT_COMPLAINT", "I want to make a formal complaint"],
  ["LEGAL_THREAT", "my lawyer will sue you"],
  ["MEDICAL_MISINFORMATION", "this miracle cure is better"],
  ["GENERAL_INQUIRY", "what are your opening hours"],
];

for (const [classification, text] of CASES) {
  test(`classification maps synthetic signal to ${classification}`, () => {
    const result = classifyInboundContent({ text, sourceType: "MESSAGE" });
    assert.equal(result.classification, classification);
    assert.equal(JSON.stringify(result).includes(text), false);
  });
}

test("public comments and private messages use identical PHI restrictions", () => {
  const comment = classifyInboundContent({
    text: "patient id 12345",
    sourceType: "COMMENT",
  });
  const message = classifyInboundContent({
    text: "patient id 12345",
    sourceType: "MESSAGE",
  });
  assert.equal(comment.classification, "PROTECTED_HEALTH_INFORMATION");
  assert.equal(message.classification, "PROTECTED_HEALTH_INFORMATION");
  assert.equal(comment.restrictedVisibility, true);
  assert.equal(message.restrictedVisibility, true);
});

test("classification priority is documented and conservative", () => {
  assert.deepEqual(CLASSIFICATION_PRIORITY.slice(0, 3), [
    "SELF_HARM_RISK",
    "MEDICAL_EMERGENCY",
    "PRIVACY_INCIDENT",
  ]);
  const result = classifyInboundContent({
    text: "I might harm myself and this is a general inquiry",
  });
  assert.equal(result.classification, "SELF_HARM_RISK");
  assert.equal(result.sensitiveDataState, "FLAGGED");
  assert.equal(result.automationAllowed, false);
});

test("general inquiry can be clear, but confirmed and redacted states are not downgraded", () => {
  assert.equal(
    classifyInboundContent({ text: "hello", existingSensitiveDataState: "UNCLASSIFIED" })
      .sensitiveDataState,
    "CLEAR",
  );
  assert.equal(
    classifyInboundContent({ text: "hello", existingSensitiveDataState: "CONFIRMED" })
      .sensitiveDataState,
    "CONFIRMED",
  );
  assert.equal(
    classifyInboundContent({ text: "hello", existingSensitiveDataState: "REDACTED" })
      .sensitiveDataState,
    "REDACTED",
  );
});
