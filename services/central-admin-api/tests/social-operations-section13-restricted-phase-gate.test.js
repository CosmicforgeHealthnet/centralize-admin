const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveApprovedSafetyTemplate,
} = require("../src/modules/marketing/social-operations/safety/safety-template.service");
const {
  assertPhaseDComplianceReady,
} = require("../src/modules/marketing/social-operations/privacy/phase-d-compliance-gate.service");
const {
  COMPLIANCE_KEYS,
  RETENTION_KEYS,
  REDACTION_KEYS,
  socialFeatureFlags,
} = require("../src/modules/marketing/social-operations/privacy/retention-settings.service");
const {
  filterPrivateRows,
  stripInternalNotesForThirdParty,
} = require("../src/modules/marketing/social-operations/privacy/export-privacy.policy");
const {
  assertRestrictedContentAccess,
} = require("../src/modules/marketing/social-operations/privacy/restricted-content-query.policy");
const {
  assertModerationJustification,
} = require("../src/modules/marketing/social-operations/safety/moderation-justification.policy");

function gateDb(replyStatus = "ACTIVE") {
  return {
    socialSavedReply: {
      async findUnique({ where }) {
        if (where.id === "reply-active") {
          return {
            id: "reply-active",
            name: "Approved redirect",
            channel: "COMMENT",
            text: "Please use the approved care channel.",
            variablesJson: { allowedVariables: ["firstName"] },
            status: replyStatus,
          };
        }
        return null;
      },
    },
  };
}

function readySettings() {
  return new Map([
    [COMPLIANCE_KEYS.PHASE_D_APPROVED, true],
    [COMPLIANCE_KEYS.POLICY_VERSION, "2026.07-approved"],
    [COMPLIANCE_KEYS.LEGAL_REVIEWED_AT, "2026-07-16T10:00:00Z"],
    [COMPLIANCE_KEYS.PRIVACY_REVIEWED_AT, "2026-07-16T10:00:00Z"],
    [COMPLIANCE_KEYS.DATA_SUBJECT_PROCEDURE_APPROVED, true],
    [COMPLIANCE_KEYS.EMERGENCY_TEMPLATES_APPROVED, true],
    [COMPLIANCE_KEYS.RETENTION_DURATIONS_APPROVED, true],
    [COMPLIANCE_KEYS.REDACTION_FIELDS_APPROVED, true],
    [RETENTION_KEYS.MESSAGES_DAYS, 30],
    [RETENTION_KEYS.COMMENTS_DAYS, 30],
    [RETENTION_KEYS.WEBHOOK_PAYLOAD_DAYS, 7],
    [RETENTION_KEYS.AUDIT_DAYS, 365],
    [REDACTION_KEYS.MESSAGE_FIELDS, ["content", "attachmentsJson"]],
    [REDACTION_KEYS.COMMENT_FIELDS, ["text"]],
    [REDACTION_KEYS.WEBHOOK_FIELDS, ["encryptedRawPayload"]],
    ["safety.templates.medicalEmergencyReplyId", "reply-active"],
    ["safety.templates.selfHarmReplyId", "reply-active"],
    ["safety.templates.clinicalAdviceRedirectReplyId", "reply-active"],
    ["safety.templates.prescriptionRedirectReplyId", "reply-active"],
    ["safety.templates.privacyIncidentReplyId", "reply-active"],
    ["safety.templates.medicalMisinformationReplyId", "reply-active"],
  ]);
}

test("safe template service resolves only approved active templates and never sends", async () => {
  const template = await resolveApprovedSafetyTemplate({
    classification: "CLINICAL_ADVICE_REQUEST",
    channel: "COMMENT",
    variables: { firstName: "Synthetic" },
    db: gateDb(),
    settings: readySettings(),
  });
  assert.equal(template.id, "reply-active");
  assert.equal(template.sendsProviderMessage, false);

  await assert.rejects(
    resolveApprovedSafetyTemplate({
      classification: "CLINICAL_ADVICE_REQUEST",
      channel: "COMMENT",
      variables: { privateContent: "not allowed" },
      db: gateDb(),
      settings: readySettings(),
    }),
    /not allowed/,
  );
  await assert.rejects(
    resolveApprovedSafetyTemplate({
      classification: "MEDICAL_EMERGENCY",
      channel: "COMMENT",
      db: gateDb("INACTIVE"),
      settings: readySettings(),
    }),
    /unavailable/,
  );
});

test("Phase D gate fails safely for missing or placeholder configuration and passes synthetic approved config", async () => {
  await assert.rejects(
    assertPhaseDComplianceReady({
      db: gateDb(),
      settings: new Map([[COMPLIANCE_KEYS.POLICY_VERSION, "placeholder"]]),
      env: {},
    }),
    (error) => {
      assert.equal(error.errors.missingKeys.includes(COMPLIANCE_KEYS.PHASE_D_APPROVED), true);
      assert.equal(JSON.stringify(error.errors).includes("secret"), false);
      return true;
    },
  );

  const result = await assertPhaseDComplianceReady({
    db: gateDb(),
    settings: readySettings(),
    env: { SOCIAL_INBOX_ENABLED: "true" },
    restrictedVisibilityTestsPass: true,
    redactionWorkerPresent: true,
  });
  assert.equal(result.ready, true);
  assert.deepEqual(socialFeatureFlags({}), {
    inboxEnabled: false,
    phaseDEnabled: false,
    redactionWorkerEnabled: false,
  });
});

test("bulk/export privacy excludes restricted content and internal notes", () => {
  const rows = filterPrivateRows([
    { id: "safe", sensitiveDataState: "CLEAR" },
    { id: "flagged", sensitiveDataState: "FLAGGED" },
    { id: "confirmed", sensitiveDataState: "CONFIRMED" },
    { id: "redacted", sensitiveDataState: "REDACTED" },
    { id: "restricted", restrictedVisibility: true },
  ]);
  assert.deepEqual(rows.map((row) => row.id), ["safe"]);
  assert.deepEqual(
    stripInternalNotesForThirdParty({
      id: "safe",
      internalNotes: [{ text: "private" }],
      nested: { notes: [{ text: "private" }], provider: "META" },
    }),
    { id: "safe", nested: { provider: "META" } },
  );
});

test("restricted access and moderation justification use RBAC and safe audit metadata", async () => {
  const audits = [];
  const db = {
    adminSectionGrant: {
      async findMany({ where }) {
        return [
          {
            adminUserId: where.adminUserId,
            module: "marketing",
            section: "social_moderation_restricted",
            mode: "VIEW",
            revokedAt: null,
            expiresAt: null,
          },
          {
            adminUserId: where.adminUserId,
            module: "marketing",
            section: "social_moderation_hide",
            mode: "EDIT",
            revokedAt: null,
            expiresAt: null,
          },
        ].filter((grant) => where.section.in.includes(grant.section));
      },
    },
  };
  await assertRestrictedContentAccess({
    adminUser: { id: "admin-1", tier: "ADMIN" },
    entityType: "COMMENT",
    entityId: "comment-1",
    db,
    auditWriter: async (entry) => audits.push(entry),
  });
  await assertModerationJustification({
    action: "hide",
    reason: "Policy review required",
    adminUser: { id: "admin-1", tier: "ADMIN" },
    entityId: "comment-1",
    db,
    auditWriter: async (entry) => audits.push(entry),
  });
  assert.equal(JSON.stringify(audits).includes("private content"), false);

  await assert.rejects(
    assertRestrictedContentAccess({
      adminUser: { id: "admin-2", tier: "ADMIN" },
      entityType: "COMMENT",
      entityId: "comment-2",
      db: { adminSectionGrant: { async findMany() { return []; } } },
      auditWriter: async () => {},
    }),
    (error) => {
      assert.equal(error.statusCode || error.status, 403);
      assert.equal(error.message, "Forbidden");
      return true;
    },
  );
});
