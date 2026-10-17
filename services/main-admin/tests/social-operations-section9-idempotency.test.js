const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  applyNormalizedWebhookEvent,
  processWebhookEvent,
} = require("../src/modules/marketing/social-operations/services/webhook-processing.service");
const {
  encryptWebhookPayload,
} = require("../src/modules/marketing/social-operations/services/webhook-crypto.service");

function fakeMessageDb() {
  const contacts = new Map();
  const conversations = new Map();
  const messages = new Map();
  const identity = {
    id: "identity-1",
    providerIdentityId: "page-1",
    connection: { provider: "META" },
  };

  return {
    contacts,
    conversations,
    messages,
    socialPublishingIdentity: {
      async findFirst() {
        return identity;
      },
    },
    socialContact: {
      async upsert({ where, create, update }) {
        const key = `${where.identityId_providerUserId.identityId}:${where.identityId_providerUserId.providerUserId}`;
        const existing = contacts.get(key);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: `contact-${contacts.size + 1}`, ...create };
        contacts.set(key, row);
        return row;
      },
    },
    socialConversation: {
      async upsert({ where, create, update }) {
        const key = `${where.identityId_providerConversationId.identityId}:${where.identityId_providerConversationId.providerConversationId}`;
        const existing = conversations.get(key);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: `conversation-${conversations.size + 1}`, ...create };
        conversations.set(key, row);
        return row;
      },
    },
    socialMessage: {
      async upsert({ where, create, update }) {
        const key = `${where.conversationId_providerMessageId.conversationId}:${where.conversationId_providerMessageId.providerMessageId}`;
        const existing = messages.get(key);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: `message-${messages.size + 1}`, ...create };
        messages.set(key, row);
        return row;
      },
    },
  };
}

test("webhook message processing is idempotent through provider-id upserts", async () => {
  const db = fakeMessageDb();
  const normalized = {
    kind: "MESSAGE",
    eventId: "evt-message",
    identityProviderId: "page-1",
    data: {
      providerMessageId: "msg-1",
      providerConversationId: "thread-1",
      providerUserId: "user-1",
      text: "hello",
      direction: "INBOUND",
      type: "TEXT",
    },
  };

  await applyNormalizedWebhookEvent({ provider: "META", normalized, db });
  await applyNormalizedWebhookEvent({ provider: "META", normalized, db });

  assert.equal(db.contacts.size, 1);
  assert.equal(db.conversations.size, 1);
  assert.equal(db.messages.size, 1);
});

test("processedAt is stamped only after domain event publish succeeds", async () => {
  const rawBody = Buffer.from(JSON.stringify({ event: true }));
  const updates = [];
  const event = {
    id: "webhook-1",
    provider: "META",
    encryptedRawPayload: encryptWebhookPayload(rawBody),
    attemptCount: 0,
    processedAt: null,
  };
  const db = {
    socialWebhookEvent: {
      async findUnique() {
        return event;
      },
      async update({ data }) {
        updates.push(data);
        Object.assign(event, data);
        return { ...event };
      },
    },
    socialPublishingIdentity: {
      async findFirst() {
        return null;
      },
    },
  };

  const connectorResolver = () => ({
    normalizeWebhookEvent() {
      return {
        kind: "MESSAGE",
        eventId: "evt",
        identityProviderId: "missing",
        data: {
          providerMessageId: "msg",
          providerConversationId: "thread",
          providerUserId: "user",
        },
      };
    },
  });

  const result = await processWebhookEvent({
    eventId: event.id,
    db,
    connectorResolver,
    publisher: async () => {
      throw new Error("event bus down");
    },
  });

  assert.equal(result.processed, false);
  assert.equal(updates.some((data) => data.processedAt), false);
  assert.equal(event.status, "FAILED");
  assert.ok(event.nextAttemptAt);
});
