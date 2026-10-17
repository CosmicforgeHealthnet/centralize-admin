const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { getConnector } = require("../src/modules/marketing/social-operations/connectors/connector.registry");
const {
  mapTikTokPublishResult,
} = require("../src/modules/marketing/social-operations/connectors/tiktok-publish-result.mapper");
const {
  assertPublishingConnection,
} = require("../src/modules/marketing/social-operations/connectors/connector.validators");

test("TikTok upload-to-draft and submitted states map safely", () => {
  const draft = mapTikTokPublishResult({ postingMode: "UPLOAD_TO_DRAFT" });
  assert.equal(draft.status, "AWAITING_USER_ACTION");
  assert.notEqual(draft.status, "PUBLISHED");

  const submitted = mapTikTokPublishResult({ postingMode: "DIRECT_POST" });
  assert.equal(submitted.status, "PROCESSING");
});

test("TikTok native-only inbox and comment actions remain permanent policy failures", async () => {
  const capabilities = await getConnector("TIKTOK").getCapabilities({
    identity: { type: "TIKTOK_ACCOUNT" },
    connection: { provider: "TIKTOK", status: "ACTIVE", requiresReauthorization: false },
  });
  assert.equal(capabilities.replyToComment.status, "NATIVE_ONLY");
  assert.equal(capabilities.listConversations.status, "NATIVE_ONLY");
  assert.equal(capabilities.sendMessage.status, "NATIVE_ONLY");
});

test("X paid/provider approval gate and ads credential isolation remain enforced", async () => {
  const capabilities = await getConnector("X").getCapabilities({
    identity: { type: "X_USER" },
    connection: { provider: "X", status: "ACTIVE", requiresReauthorization: false },
  });
  assert.equal(capabilities.publishPost.status, "REQUIRES_PLATFORM_APPROVAL");
  assert.equal(capabilities.uploadMedia.status, "REQUIRES_PLATFORM_APPROVAL");
  assert.equal(capabilities.sendMessage.status, "REQUIRES_PLATFORM_APPROVAL");
  assert.throws(
    () => assertPublishingConnection({ platform: "X", accountId: "ad-account" }, "X"),
    /Advertising connections/,
  );

  const connectorSource = fs.readFileSync(
    path.resolve(__dirname, "../src/modules/marketing/social-operations/connectors/x-publishing.connector.js"),
    "utf8",
  );
  assert.equal(connectorSource.includes("marketing/intelligence"), false);
});

test("LinkedIn member publishing is deferred by policy while organization identity is accepted", async () => {
  const member = await getConnector("LINKEDIN").getCapabilities({
    identity: { type: "LINKEDIN_MEMBER" },
    connection: { provider: "LINKEDIN", status: "ACTIVE", requiresReauthorization: false },
  });
  assert.equal(member.publishPost.status, "DISABLED_BY_POLICY");
  assert.notEqual(member.publishPost.status, "UNSUPPORTED_ACCOUNT_TYPE");

  const organization = await getConnector("LINKEDIN").getCapabilities({
    identity: { type: "LINKEDIN_ORGANIZATION" },
    connection: { provider: "LINKEDIN", status: "ACTIVE", requiresReauthorization: false },
  });
  assert.notEqual(organization.publishPost.status, "UNSUPPORTED_ACCOUNT_TYPE");
  assert.equal(organization.sendMessage.status, "NATIVE_ONLY");
});

test("Meta personal Instagram remains unsupported while pages/professional accounts are accepted", async () => {
  const personal = await getConnector("META").getCapabilities({
    identity: { type: "INSTAGRAM_PERSONAL" },
    connection: { provider: "META", status: "ACTIVE", requiresReauthorization: false },
  });
  assert.equal(personal.publishPost.status, "UNSUPPORTED_ACCOUNT_TYPE");

  const page = await getConnector("META").getCapabilities({
    identity: { type: "FACEBOOK_PAGE", messagingWindowOpen: true },
    connection: { provider: "META", status: "ACTIVE", requiresReauthorization: false },
  });
  assert.notEqual(page.publishPost.status, "UNSUPPORTED_ACCOUNT_TYPE");

  const professional = await getConnector("META").getCapabilities({
    identity: { type: "INSTAGRAM_PROFESSIONAL", messagingWindowOpen: true },
    connection: { provider: "META", status: "ACTIVE", requiresReauthorization: false },
  });
  assert.notEqual(professional.publishPost.status, "UNSUPPORTED_ACCOUNT_TYPE");
  assert.notEqual(professional.sendMessage.reason, "CUSTOMER_INITIATED_WINDOW_REQUIRED");
});

test("Meta capabilities are derived from connector capability checks", () => {
  const apiSource = fs.readFileSync(
    path.resolve(__dirname, "../src/modules/marketing/social-operations/services/social-api.service.js"),
    "utf8",
  );
  assert.match(apiSource, /connector\.getCapabilities/);
  assert.match(apiSource, /capabilitiesJson/);
});
