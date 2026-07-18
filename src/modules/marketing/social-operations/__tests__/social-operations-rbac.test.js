const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SOCIAL_OPERATION_SECTION_VALUES,
} = require("../governance/social-operations.sections");
const {
  SOCIAL_OPERATION_ACTIONS,
  createRequireSocialOperation,
  getSocialOperationGrant,
} = require("../governance/social-operations.rbac");

test("social operations sections contain the required static grants", () => {
  assert.deepEqual(
    [...SOCIAL_OPERATION_SECTION_VALUES].sort(),
    [
      "social_content",
      "social_content_submit",
      "social_approvals",
      "social_publish",
      "social_publish_emergency_override",
      "social_schedule",
      "social_publish_retry",
      "social_publish_cancel",
      "social_publish_delete",
      "social_inbox",
      "social_inbox_reply",
      "social_inbox_assign",
      "social_inbox_resolve",
      "social_inbox_note",
      "social_inbox_tag",
      "social_moderation_hide",
      "social_moderation_delete",
      "social_moderation_escalate",
      "social_moderation_safety",
      "social_moderation_restricted",
      "social_connections",
      "social_analytics",
      "social_settings",
      "social_operations",
    ].sort(),
  );
});

test("every action resolves to marketing VIEW or EDIT and never uses a fourth argument", () => {
  const calls = [];
  const requireSocialOperation = createRequireSocialOperation((...args) => {
    calls.push(args);
    return "middleware";
  });

  for (const action of Object.keys(SOCIAL_OPERATION_ACTIONS)) {
    const grant = getSocialOperationGrant(action);
    assert.equal(grant.module, "marketing");
    assert.ok(["VIEW", "EDIT"].includes(grant.mode));
    assert.notEqual(grant.mode, "EMERGENCY_OVERRIDE");
    assert.equal(requireSocialOperation(action), "middleware");
  }

  assert.ok(calls.every((args) => args.length === 3));
  assert.throws(() => requireSocialOperation("UNKNOWN_ACTION"), /Unknown Social Operations action/);
});

test("required action-to-section mappings are exact", () => {
  assert.deepEqual(getSocialOperationGrant("CONTENT_VIEW"), {
    module: "marketing",
    section: "social_content",
    mode: "VIEW",
  });
  assert.deepEqual(getSocialOperationGrant("CONTENT_SUBMIT"), {
    module: "marketing",
    section: "social_content_submit",
    mode: "EDIT",
  });
  assert.deepEqual(getSocialOperationGrant("PUBLISH"), {
    module: "marketing",
    section: "social_publish",
    mode: "EDIT",
  });
  assert.deepEqual(getSocialOperationGrant("PUBLISH_EMERGENCY_OVERRIDE"), {
    module: "marketing",
    section: "social_publish_emergency_override",
    mode: "EDIT",
  });
  assert.deepEqual(getSocialOperationGrant("INBOX_VIEW"), {
    module: "marketing",
    section: "social_inbox",
    mode: "VIEW",
  });
  assert.deepEqual(getSocialOperationGrant("INBOX_NOTE"), {
    module: "marketing",
    section: "social_inbox_note",
    mode: "EDIT",
  });
  assert.notEqual(
    getSocialOperationGrant("MODERATION_HIDE").section,
    getSocialOperationGrant("MODERATION_DELETE").section,
  );
  assert.notEqual(
    getSocialOperationGrant("MODERATION_DELETE").section,
    getSocialOperationGrant("MODERATION_ESCALATE").section,
  );
  assert.equal(getSocialOperationGrant("RESTRICTED_CONTENT_VIEW").section, "social_moderation_restricted");
  assert.equal(getSocialOperationGrant("MODERATION_SAFETY").section, "social_moderation_safety");
  assert.equal(getSocialOperationGrant("SETTINGS_EDIT").mode, "EDIT");
  assert.equal(getSocialOperationGrant("CONNECTION_VIEW").mode, "VIEW");
  assert.equal(getSocialOperationGrant("CONNECTION_EDIT").mode, "EDIT");
});
