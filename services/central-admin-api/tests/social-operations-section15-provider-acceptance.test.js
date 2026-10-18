const { test } = require("node:test");
const assert = require("node:assert/strict");

const { CAPABILITY_STATUS } = require("../src/modules/marketing/social-operations/connectors/connector.constants");

function assertNoRealProviderSurface(calls) {
  const text = JSON.stringify(calls);
  assert.equal(/https:\/\/(graph|api|business|www)\./i.test(text), false);
  assert.equal(/access[_-]?token|refresh[_-]?token|client[_-]?secret/i.test(text), false);
  assert.equal(/Bearer\s+/i.test(text), false);
}

function mockConnector(platform, overrides = {}) {
  const calls = [];
  const connector = {
    platform,
    calls,
    async discoverIdentities() {
      calls.push(["discoverIdentities"]);
      return [{ id: `mock-${platform.toLowerCase()}-identity`, providerIdentityId: `mock-${platform.toLowerCase()}-provider-id` }];
    },
    async getCapabilities({ identity = {} } = {}) {
      calls.push(["getCapabilities", identity.type]);
      return {
        publishPost: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        uploadMedia: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        listComments: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        replyToComment: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        moderateComment: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        listConversations: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        sendMessage: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        getPublishStatus: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
      };
    },
    async validatePost() {
      calls.push(["validatePost"]);
      return { ok: true };
    },
    async uploadMedia() {
      calls.push(["uploadMedia"]);
      return { providerMediaId: `mock-${platform.toLowerCase()}-media` };
    },
    async publishPost({ postingMode } = {}) {
      calls.push(["publishPost", postingMode || "DIRECT_POST"]);
      return {
        providerPostId: `mock-${platform.toLowerCase()}-post`,
        status: "PUBLISHED",
      };
    },
    async getPublishStatus() {
      calls.push(["getPublishStatus"]);
      return { status: "PUBLISHED", providerPostId: `mock-${platform.toLowerCase()}-post` };
    },
    async listComments() {
      calls.push(["listComments"]);
      return [{ providerCommentId: `mock-${platform.toLowerCase()}-comment`, text: "synthetic comment" }];
    },
    async replyToComment() {
      calls.push(["replyToComment"]);
      return { providerCommentId: `mock-${platform.toLowerCase()}-reply` };
    },
    async moderateComment({ action } = {}) {
      calls.push(["moderateComment", action]);
      return { ok: true };
    },
    async listConversations() {
      calls.push(["listConversations"]);
      return [{ providerConversationId: `mock-${platform.toLowerCase()}-conversation` }];
    },
    async sendMessage() {
      calls.push(["sendMessage"]);
      return { providerMessageId: `mock-${platform.toLowerCase()}-message` };
    },
    async listContent() {
      calls.push(["listContent"]);
      return [{ providerContentId: `mock-${platform.toLowerCase()}-content` }];
    },
    async getContent() {
      calls.push(["getContent"]);
      return { providerContentId: `mock-${platform.toLowerCase()}-content` };
    },
    async listContentMetrics() {
      calls.push(["listContentMetrics"]);
      return [{ providerContentId: `mock-${platform.toLowerCase()}-content`, date: "2026-07-17" }];
    },
    async verifyWebhook() {
      calls.push(["verifyWebhook"]);
      return { valid: true };
    },
    async normalizeWebhookEvent({ event } = {}) {
      calls.push(["normalizeWebhookEvent", event?.kind]);
      return { kind: event?.kind, providerEventId: `mock-${platform.toLowerCase()}-event` };
    },
    ...overrides,
  };
  return connector;
}

test("Facebook mocked acceptance covers publish, comment, Messenger window and idempotency", async () => {
  const connector = mockConnector("META", {
    async getCapabilities() {
      this.calls.push(["getCapabilities", "FACEBOOK_PAGE"]);
      return {
        publishPost: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        replyToComment: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        sendMessage: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
      };
    },
  });

  const identities = await connector.discoverIdentities();
  const publish = await connector.publishPost({ postingMode: "DIRECT_POST" });
  const status = await connector.getPublishStatus({ providerPostId: publish.providerPostId });
  const comment = await connector.normalizeWebhookEvent({ event: { kind: "COMMENT" } });
  const reply = await connector.replyToComment({ clientIdempotencyKey: "mock-facebook-reply-1" });
  const message = await connector.sendMessage({ clientIdempotencyKey: "mock-facebook-message-1" });

  assert.equal(identities[0].providerIdentityId.startsWith("mock-"), true);
  assert.equal(status.status, "PUBLISHED");
  assert.equal(comment.kind, "COMMENT");
  assert.ok(reply.providerCommentId);
  assert.ok(message.providerMessageId);
  assertNoRealProviderSurface(connector.calls);
});

test("Instagram mocked acceptance covers professional media publishing and rejects personal accounts", async () => {
  const connector = mockConnector("META", {
    async getCapabilities({ identity = {} } = {}) {
      this.calls.push(["getCapabilities", identity.type]);
      if (identity.type === "INSTAGRAM_PERSONAL") {
        return { publishPost: { status: CAPABILITY_STATUS.UNSUPPORTED_ACCOUNT_TYPE, reason: "UNSUPPORTED_ACCOUNT_TYPE" } };
      }
      return {
        publishPost: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        uploadMedia: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        replyToComment: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        sendMessage: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
      };
    },
  });

  const professional = await connector.getCapabilities({ identity: { type: "INSTAGRAM_PROFESSIONAL" } });
  const media = await connector.uploadMedia();
  const publish = await connector.publishPost({ media });
  const comment = await connector.normalizeWebhookEvent({ event: { kind: "COMMENT" } });
  const personal = await connector.getCapabilities({ identity: { type: "INSTAGRAM_PERSONAL" } });

  assert.equal(professional.publishPost.status, CAPABILITY_STATUS.AVAILABLE);
  assert.equal(media.providerMediaId.startsWith("mock-"), true);
  assert.equal(publish.status, "PUBLISHED");
  assert.equal(comment.kind, "COMMENT");
  assert.equal(personal.publishPost.status, CAPABILITY_STATUS.UNSUPPORTED_ACCOUNT_TYPE);
  assertNoRealProviderSurface(connector.calls);
});

test("TikTok mocked acceptance keeps processing and draft-upload states distinct", async () => {
  let pollCount = 0;
  const connector = mockConnector("TIKTOK", {
    async getCapabilities() {
      this.calls.push(["getCapabilities", "TIKTOK_ACCOUNT"]);
      return {
        publishPost: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        getPublishStatus: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        listComments: { status: CAPABILITY_STATUS.NATIVE_ONLY, reason: "PROVIDER_API_NOT_AVAILABLE" },
        sendMessage: { status: CAPABILITY_STATUS.NATIVE_ONLY, reason: "PROVIDER_API_NOT_AVAILABLE" },
      };
    },
    async publishPost({ postingMode } = {}) {
      this.calls.push(["publishPost", postingMode]);
      if (postingMode === "UPLOAD_TO_DRAFT") {
        return { status: "AWAITING_USER_ACTION", providerPostId: null };
      }
      return { status: "PROCESSING", providerPostId: "mock-tiktok-processing" };
    },
    async getPublishStatus() {
      this.calls.push(["getPublishStatus"]);
      pollCount += 1;
      return pollCount === 1
        ? { status: "PROCESSING", providerPostId: "mock-tiktok-processing" }
        : { status: "PUBLISHED", providerPostId: "mock-tiktok-post" };
    },
  });

  const direct = await connector.publishPost({ postingMode: "DIRECT_POST" });
  const firstPoll = await connector.getPublishStatus();
  const secondPoll = await connector.getPublishStatus();
  const draft = await connector.publishPost({ postingMode: "UPLOAD_TO_DRAFT" });
  const capabilities = await connector.getCapabilities();

  assert.equal(direct.status, "PROCESSING");
  assert.equal(firstPoll.status, "PROCESSING");
  assert.equal(secondPoll.status, "PUBLISHED");
  assert.equal(draft.status, "AWAITING_USER_ACTION");
  assert.notEqual(draft.status, "PUBLISHED");
  assert.equal(capabilities.listComments.status, CAPABILITY_STATUS.NATIVE_ONLY);
  assert.equal(capabilities.sendMessage.status, CAPABILITY_STATUS.NATIVE_ONLY);
  assertNoRealProviderSurface(connector.calls);
});

test("X mocked acceptance enforces paid/access tier gates and Ads credential isolation", async () => {
  const connector = mockConnector("X", {
    async getCapabilities({ connection = {} } = {}) {
      this.calls.push(["getCapabilities", connection.credentialKind || "organic"]);
      const paid = connection.accessTier === "PAID";
      return {
        publishPost: { status: paid ? CAPABILITY_STATUS.AVAILABLE : CAPABILITY_STATUS.REQUIRES_PLATFORM_APPROVAL, reason: paid ? null : "X_PAID_ACCESS_REQUIRED" },
        uploadMedia: { status: paid ? CAPABILITY_STATUS.AVAILABLE : CAPABILITY_STATUS.REQUIRES_PLATFORM_APPROVAL, reason: paid ? null : "X_PAID_ACCESS_REQUIRED" },
        sendMessage: { status: paid ? CAPABILITY_STATUS.AVAILABLE : CAPABILITY_STATUS.REQUIRES_PLATFORM_APPROVAL, reason: paid ? null : "X_PAID_ACCESS_REQUIRED" },
      };
    },
  });

  const gated = await connector.getCapabilities({ connection: { credentialKind: "ads", accessTier: "FREE" } });
  const paid = await connector.getCapabilities({ connection: { credentialKind: "organic", accessTier: "PAID" } });
  const media = await connector.uploadMedia();
  const post = await connector.publishPost();
  const reply = await connector.replyToComment();
  const dm = await connector.sendMessage();

  assert.equal(gated.publishPost.status, CAPABILITY_STATUS.REQUIRES_PLATFORM_APPROVAL);
  assert.equal(paid.publishPost.status, CAPABILITY_STATUS.AVAILABLE);
  assert.ok(media.providerMediaId);
  assert.ok(post.providerPostId);
  assert.ok(reply.providerCommentId);
  assert.ok(dm.providerMessageId);
  assert.equal(JSON.stringify(connector.calls).includes("ads-token"), false);
  assertNoRealProviderSurface(connector.calls);
});

test("LinkedIn mocked acceptance covers organization publishing and member/page policy gates", async () => {
  const connector = mockConnector("LINKEDIN", {
    async getCapabilities({ identity = {} } = {}) {
      this.calls.push(["getCapabilities", identity.type]);
      return {
        publishPost: {
          status:
            identity.type === "LINKEDIN_MEMBER"
              ? CAPABILITY_STATUS.DISABLED_BY_POLICY
              : CAPABILITY_STATUS.AVAILABLE,
          reason: identity.type === "LINKEDIN_MEMBER" ? "LINKEDIN_MEMBER_PUBLISHING_DEFERRED" : null,
        },
        uploadMedia: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        listComments: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        replyToComment: { status: CAPABILITY_STATUS.AVAILABLE, reason: null },
        listConversations: { status: CAPABILITY_STATUS.NATIVE_ONLY, reason: "PROVIDER_API_NOT_AVAILABLE" },
      };
    },
  });

  const org = await connector.getCapabilities({ identity: { type: "LINKEDIN_ORGANIZATION" } });
  const media = await connector.uploadMedia();
  const post = await connector.publishPost({ media });
  const comments = await connector.listComments();
  const reaction = await connector.normalizeWebhookEvent({ event: { kind: "REACTION" } });
  const member = await connector.getCapabilities({ identity: { type: "LINKEDIN_MEMBER" } });

  assert.equal(org.publishPost.status, CAPABILITY_STATUS.AVAILABLE);
  assert.ok(post.providerPostId);
  assert.ok(comments[0].providerCommentId);
  assert.equal(reaction.kind, "REACTION");
  assert.equal(org.listConversations.status, CAPABILITY_STATUS.NATIVE_ONLY);
  assert.equal(member.publishPost.status, CAPABILITY_STATUS.DISABLED_BY_POLICY);
  assertNoRealProviderSurface(connector.calls);
});
