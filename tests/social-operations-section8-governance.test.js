const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  canApprovePost,
  planApprovedTargetEdit,
} = require("../src/modules/marketing/social-operations/governance/approval-governance.service");
const {
  auditBeforeEmergencyEnqueue,
} = require("../src/modules/marketing/social-operations/governance/emergency-publish-governance.service");
const {
  validateSchedule,
} = require("../src/modules/marketing/social-operations/validators/social.validator");
const {
  evaluateJobExecutionPolicy,
} = require("../src/modules/marketing/social-operations/governance/job-execution.policy");

function runMiddleware(middleware, req) {
  return new Promise((resolve, reject) => {
    middleware(req, {}, (error) => (error ? reject(error) : resolve()));
  });
}

test("self-approval remains denied by default", () => {
  assert.equal(
    canApprovePost({ actorId: "admin-1", authorId: "admin-1", settings: [] }).allowed,
    false,
  );
  assert.equal(
    canApprovePost({
      actorId: "admin-1",
      authorId: "admin-1",
      settings: { "social.approvals.allow_self_approval": true },
    }).allowed,
    true,
  );
});

test("approved-content edits require a new draft revision and reapproval", () => {
  const plan = planApprovedTargetEdit({
    target: { status: "APPROVED" },
    currentRevision: { id: "rev-1", version: 2 },
    changes: { baseText: "updated" },
  });
  assert.equal(plan.requiresNewRevision, true);
  assert.equal(plan.targetStatus, "DRAFT");
  assert.equal(plan.reapprovalRequired, true);
  assert.equal(plan.previousRevision.id, "rev-1");
});

test("emergency publishing still audits before enqueue", async () => {
  const calls = [];
  const result = await auditBeforeEmergencyEnqueue({
    reason: "clinical urgency",
    audit: async (payload) => calls.push(["audit", payload.requiredGrant.section]),
    enqueue: async () => calls.push(["enqueue"]),
  });

  assert.equal(result.enqueued, true);
  assert.deepEqual(calls, [
    ["audit", "social_publish_emergency_override"],
    ["enqueue"],
  ]);
});

test("schedule validator rejects empty targets, past dates and bad mediaAssetIds", async () => {
  await assert.rejects(
    runMiddleware(validateSchedule, { body: { targets: [] } }),
    /targets must contain/,
  );

  await assert.rejects(
    runMiddleware(validateSchedule, {
      body: {
        targets: [
          {
            identityId: "11111111-1111-4111-8111-111111111111",
            text: "hello",
            mediaAssetIds: "asset",
            scheduledForUtc: "2000-01-01T00:00:00Z",
            timezone: "UTC",
          },
        ],
      },
    }),
    /mediaAssetIds|scheduledForUtc/,
  );
});

test("publish execution validates capability, provider policy and revision state", () => {
  const denied = evaluateJobExecutionPolicy({
    connection: { id: "conn", status: "ACTIVE", requiresReauthorization: false, provider: "X" },
    identity: { id: "identity", connectionId: "conn" },
    requiredCapability: "publishPost",
    capability: { status: "REQUIRES_PLATFORM_APPROVAL", reason: "X_PAID_ACCESS_REQUIRED" },
    publication: { postVersion: 2, postId: "post" },
    approvedRevision: { postId: "post", version: 2 },
    currentRevision: { postId: "post", version: 2 },
    settings: [],
  });

  assert.equal(denied.allowed, false);
  assert.equal(denied.reasonCode, "CAPABILITY_NOT_AVAILABLE");
});

