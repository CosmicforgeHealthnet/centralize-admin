const assert = require("node:assert/strict");
const test = require("node:test");

const {
  canApprovePost,
  planApprovedTargetEdit,
} = require("../governance/approval-governance.service");
const {
  auditBeforeEmergencyEnqueue,
  validateEmergencyReason,
} = require("../governance/emergency-publish-governance.service");
const {
  sanitizeAuditMetadata,
  withProviderWriteAudit,
} = require("../governance/provider-write-audit.service");
const {
  canAccessRestrictedEntity,
} = require("../governance/restricted-visibility.policy");

test("self-approval is denied by default and only allowed by explicit true setting", () => {
  assert.equal(canApprovePost({ actorId: "a", authorId: "a" }).allowed, false);
  assert.equal(
    canApprovePost({
      actorId: "a",
      authorId: "a",
      settings: { "social.approvals.allow_self_approval": false },
    }).allowed,
    false,
  );
  assert.equal(
    canApprovePost({
      actorId: "a",
      authorId: "a",
      settings: { "social.approvals.allow_self_approval": true },
    }).allowed,
    true,
  );
  assert.equal(canApprovePost({ actorId: "a", authorId: "b" }).allowed, true);
  assert.equal(
    canApprovePost({
      actorId: "a",
      authorId: "a",
      settings: { "social.approvals.allow_self_approval": "yes" },
    }).allowed,
    false,
  );
});

test("approved target edits require a new draft revision and preserve the previous revision", () => {
  const previousRevision = { id: "rev-1", version: 2 };
  const decision = planApprovedTargetEdit({
    target: { id: "target-1", status: "APPROVED" },
    currentRevision: previousRevision,
    changes: { text: "updated" },
  });

  assert.equal(decision.requiresNewRevision, true);
  assert.equal(decision.targetStatus, "DRAFT");
  assert.equal(decision.reapprovalRequired, true);
  assert.equal(decision.previousRevision, previousRevision);
});

test("emergency publishing validates reason and audits before enqueue", async () => {
  assert.equal(validateEmergencyReason("").valid, false);
  assert.equal(validateEmergencyReason("   ").valid, false);

  const calls = [];
  const result = await auditBeforeEmergencyEnqueue({
    reason: "Urgent safety communication",
    audit: async () => calls.push("audit"),
    enqueue: async () => {
      calls.push("enqueue");
      return { id: "job-1" };
    },
  });

  assert.deepEqual(calls, ["audit", "enqueue"]);
  assert.equal(result.enqueued, true);

  const failedCalls = [];
  await assert.rejects(
    () =>
      auditBeforeEmergencyEnqueue({
        reason: "Urgent",
        audit: async () => {
          failedCalls.push("audit");
          throw new Error("audit failed");
        },
        enqueue: async () => failedCalls.push("enqueue"),
      }),
    /audit failed/,
  );
  assert.deepEqual(failedCalls, ["audit"]);
});

test("provider write audit records intent, success and failure with sanitized metadata", async () => {
  const events = [];
  const auditWriter = async (event) => events.push(event);

  const success = await withProviderWriteAudit({
    auditWriter,
    adminUserId: "admin-1",
    operation: "sendMessage",
    platform: "META",
    targetId: "message-1",
    metadata: {
      accessToken: "secret",
      message: "private message",
      safe: "value",
    },
    providerCallback: async () => "ok",
  });

  assert.equal(success, "ok");
  assert.deepEqual(events.map((event) => event.metadata.phase), ["INTENT", "SUCCESS"]);
  assert.equal(events[0].metadata.accessToken, "[REDACTED]");
  assert.equal(events[0].metadata.message, "[REDACTED]");
  assert.equal(events[0].metadata.safe, "value");

  await assert.rejects(
    () =>
      withProviderWriteAudit({
        auditWriter,
        operation: "replyToComment",
        platform: "META",
        metadata: { comment: "private comment" },
        providerCallback: async () => {
          throw new Error("provider failed");
        },
      }),
    /provider failed/,
  );
  assert.equal(events.at(-1).metadata.phase, "FAILURE");
  assert.equal(sanitizeAuditMetadata({ nested: { refreshToken: "secret" } }).nested.refreshToken, "[REDACTED]");
});

test("restricted visibility denies ordinary inbox-only access and honors restricted/safety grants", () => {
  assert.equal(
    canAccessRestrictedEntity({
      restrictedVisibility: true,
      hasInboxAccess: true,
      requestedOperation: "VIEW",
    }).allowed,
    false,
  );
  assert.equal(
    canAccessRestrictedEntity({
      restrictedVisibility: true,
      hasRestrictedView: true,
      requestedOperation: "VIEW",
    }).allowed,
    true,
  );
  assert.equal(
    canAccessRestrictedEntity({
      restrictedVisibility: true,
      hasRestrictedEdit: true,
      requestedOperation: "EDIT",
    }).allowed,
    true,
  );
  assert.equal(
    canAccessRestrictedEntity({
      restrictedVisibility: true,
      hasSafetyEdit: true,
      requestedOperation: "SAFETY",
    }).allowed,
    true,
  );
});
