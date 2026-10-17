const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { CAPABILITY_STATUS } = require("../connectors/connector.constants");
const {
  evaluateJobExecutionPolicy,
} = require("../governance/job-execution.policy");

function baseInput(overrides = {}) {
  return {
    connection: {
      id: "connection-1",
      provider: "META",
      status: "ACTIVE",
      requiresReauthorization: false,
    },
    identity: {
      id: "identity-1",
      connectionId: "connection-1",
      disabledAt: null,
    },
    requiredCapability: "publishPost",
    capability: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
    publication: {
      id: "publication-1",
      postId: "post-1",
      postVersion: 3,
      requestedById: "former-requester",
      approvedById: "former-approver",
    },
    approvedRevision: {
      id: "revision-3",
      postId: "post-1",
      version: 3,
    },
    currentRevision: {
      id: "revision-3",
      postId: "post-1",
      version: 3,
    },
    settings: {},
    ...overrides,
  };
}

test("valid current execution state allows execution without historic actor RBAC checks", () => {
  const decision = evaluateJobExecutionPolicy(baseInput());
  assert.equal(decision.allowed, true);

  const actorlessDecision = evaluateJobExecutionPolicy(
    baseInput({
      publication: {
        id: "publication-1",
        postId: "post-1",
        postVersion: 3,
        requestedById: "revoked-user",
        approvedById: "deleted-grant-user",
      },
    }),
  );
  assert.equal(actorlessDecision.allowed, true);
});

test("connection failures are permanent", () => {
  assert.equal(
    evaluateJobExecutionPolicy(baseInput({ connection: null })).reasonCode,
    "CONNECTION_NOT_FOUND",
  );
  assert.equal(
    evaluateJobExecutionPolicy(
      baseInput({ connection: { id: "connection-1", provider: "META", status: "DISABLED" } }),
    ).reasonCode,
    "CONNECTION_NOT_ACTIVE",
  );
  assert.equal(
    evaluateJobExecutionPolicy(
      baseInput({
        connection: {
          id: "connection-1",
          provider: "META",
          status: "ACTIVE",
          requiresReauthorization: true,
        },
      }),
    ).reasonCode,
    "CONNECTION_REAUTHORIZATION_REQUIRED",
  );
});

test("identity failures are permanent", () => {
  assert.equal(
    evaluateJobExecutionPolicy(baseInput({ identity: null })).reasonCode,
    "IDENTITY_NOT_FOUND",
  );
  assert.equal(
    evaluateJobExecutionPolicy(
      baseInput({ identity: { id: "identity-1", connectionId: "connection-1", disabledAt: new Date() } }),
    ).reasonCode,
    "IDENTITY_DISABLED",
  );
  assert.equal(
    evaluateJobExecutionPolicy(
      baseInput({ identity: { id: "identity-1", connectionId: "other", disabledAt: null } }),
    ).reasonCode,
    "IDENTITY_CONNECTION_MISMATCH",
  );
});

test("capability states block execution unless currently available", () => {
  for (const status of [
    CAPABILITY_STATUS.NATIVE_ONLY,
    CAPABILITY_STATUS.READ_ONLY,
    CAPABILITY_STATUS.REQUIRES_PLATFORM_APPROVAL,
    CAPABILITY_STATUS.DISABLED_BY_POLICY,
  ]) {
    const decision = evaluateJobExecutionPolicy(
      baseInput({ capability: { status, reason: "test" } }),
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.reasonCode, "CAPABILITY_NOT_AVAILABLE");
  }

  const rateLimited = evaluateJobExecutionPolicy(
    baseInput({
      capability: {
        status: CAPABILITY_STATUS.RATE_LIMITED,
        reason: "RATE_LIMIT",
        retryAt: new Date(Date.now() + 60000),
      },
    }),
  );
  assert.equal(rateLimited.allowed, false);
  assert.equal(rateLimited.retryable, true);
  assert.equal(rateLimited.reasonCode, "PROVIDER_RATE_LIMITED");
});

test("company policy and revision checks block execution", () => {
  assert.equal(
    evaluateJobExecutionPolicy(
      baseInput({ settings: { "social.policy.blocked_providers": ["META"] } }),
    ).reasonCode,
    "PROVIDER_BLOCKED_BY_POLICY",
  );
  assert.equal(
    evaluateJobExecutionPolicy(
      baseInput({ settings: { "social.policy.blocked_identity_ids": ["identity-1"] } }),
    ).reasonCode,
    "IDENTITY_BLOCKED_BY_POLICY",
  );
  assert.equal(
    evaluateJobExecutionPolicy(baseInput({ approvedRevision: null })).reasonCode,
    "APPROVED_REVISION_NOT_FOUND",
  );
  assert.equal(
    evaluateJobExecutionPolicy(
      baseInput({
        publication: { id: "publication-1", postId: "post-1", postVersion: 2 },
      }),
    ).reasonCode,
    "APPROVED_REVISION_MISMATCH",
  );
  assert.equal(
    evaluateJobExecutionPolicy(
      baseInput({ currentRevision: { id: "revision-4", postId: "post-1", version: 4 } }),
    ).reasonCode,
    "APPROVED_REVISION_MISMATCH",
  );
});

test("job execution policy remains pure and does not import RBAC middleware", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../governance/job-execution.policy.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /rbac\.middleware|requireSection|adminSectionGrant/);
});
