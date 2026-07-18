const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CAPABILITY_STATUS,
  CAPABILITY_STATUS_VALUES,
  CONNECTOR_METHODS,
  REASON_CODES,
} = require("../connectors/connector.constants");
const { getConnector, listConnectors } = require("../connectors/connector.registry");

function connection(provider, overrides = {}) {
  return {
    id: `${provider.toLowerCase()}-connection`,
    provider,
    status: "ACTIVE",
    requiresReauthorization: false,
    ...overrides,
  };
}

async function capabilities(provider, identity = {}, connectionOverrides = {}) {
  return getConnector(provider).getCapabilities({
    identity,
    connection: connection(provider, connectionOverrides),
  });
}

test("capability entries use approved statuses and include reason keys", async () => {
  for (const connector of listConnectors()) {
    const result = await connector.getCapabilities({
      identity: { type: `${connector.platform}_TEST` },
      connection: connection(connector.platform),
    });

    assert.deepEqual(Object.keys(result).sort(), [...CONNECTOR_METHODS].sort());
    for (const value of Object.values(result)) {
      assert.ok(CAPABILITY_STATUS_VALUES.includes(value.status));
      assert.ok(Object.hasOwn(value, "reason"));
    }
  }
});

test("connection-state rules override provider-specific rules", async () => {
  const disabled = await capabilities("META", { type: "FACEBOOK_PAGE" }, { status: "DISABLED" });
  assert.equal(
    Object.values(disabled).some((entry) => entry.status === CAPABILITY_STATUS.AVAILABLE),
    false,
  );

  const reauth = await capabilities("META", { type: "FACEBOOK_PAGE" }, {
    status: "REAUTHORIZATION_REQUIRED",
  });
  assert.equal(reauth.publishPost.status, CAPABILITY_STATUS.REQUIRES_REAUTHORIZATION);

  const approval = await capabilities("X", { type: "X_USER" }, {
    status: "PENDING_PLATFORM_APPROVAL",
  });
  assert.equal(approval.publishPost.status, CAPABILITY_STATUS.REQUIRES_PLATFORM_APPROVAL);

  const pending = await capabilities("META", { type: "FACEBOOK_PAGE" }, {
    status: "PENDING_AUTHORIZATION",
  });
  assert.equal(pending.publishPost.reason, REASON_CODES.AUTHORIZATION_INCOMPLETE);
});

test("Meta account and messaging capability gates are conservative", async () => {
  const personal = await capabilities("META", { type: "INSTAGRAM_PERSONAL" });
  assert.equal(personal.publishPost.status, CAPABILITY_STATUS.UNSUPPORTED_ACCOUNT_TYPE);

  const page = await capabilities("META", { type: "FACEBOOK_PAGE" });
  assert.notEqual(page.publishPost.status, CAPABILITY_STATUS.UNSUPPORTED_ACCOUNT_TYPE);

  const professional = await capabilities("META", {
    type: "INSTAGRAM_PROFESSIONAL",
  });
  assert.notEqual(professional.publishPost.status, CAPABILITY_STATUS.UNSUPPORTED_ACCOUNT_TYPE);

  const closedWindow = await capabilities("META", { type: "FACEBOOK_PAGE" });
  assert.equal(closedWindow.sendMessage.reason, REASON_CODES.CUSTOMER_INITIATED_WINDOW_REQUIRED);
});

test("TikTok native-only and posting-mode restrictions are surfaced", async () => {
  const result = await capabilities("TIKTOK", { type: "TIKTOK_ACCOUNT" });
  for (const operation of ["listComments", "replyToComment", "listConversations", "sendMessage"]) {
    assert.equal(result[operation].status, CAPABILITY_STATUS.NATIVE_ONLY);
  }
});

test("X publishing, upload, and DM capabilities require paid/provider approval", async () => {
  const result = await capabilities("X", { type: "X_USER" });
  assert.equal(result.publishPost.status, CAPABILITY_STATUS.REQUIRES_PLATFORM_APPROVAL);
  assert.equal(result.uploadMedia.status, CAPABILITY_STATUS.REQUIRES_PLATFORM_APPROVAL);
  assert.equal(result.sendMessage.status, CAPABILITY_STATUS.REQUIRES_PLATFORM_APPROVAL);
  assert.equal(result.publishPost.reason, REASON_CODES.X_PAID_ACCESS_REQUIRED);
});

test("LinkedIn inbox and member-publishing capability rules are explicit", async () => {
  const organization = await capabilities("LINKEDIN", { type: "LINKEDIN_ORGANIZATION" });
  assert.equal(organization.listConversations.status, CAPABILITY_STATUS.NATIVE_ONLY);
  assert.equal(organization.sendMessage.status, CAPABILITY_STATUS.NATIVE_ONLY);
  assert.notEqual(organization.publishPost.status, CAPABILITY_STATUS.UNSUPPORTED_ACCOUNT_TYPE);

  const member = await capabilities("LINKEDIN", { type: "LINKEDIN_MEMBER" });
  assert.equal(member.publishPost.status, CAPABILITY_STATUS.DISABLED_BY_POLICY);
  assert.equal(member.publishPost.reason, REASON_CODES.LINKEDIN_MEMBER_PUBLISHING_DEFERRED);
  assert.notEqual(member.publishPost.status, CAPABILITY_STATUS.UNSUPPORTED_ACCOUNT_TYPE);
});
