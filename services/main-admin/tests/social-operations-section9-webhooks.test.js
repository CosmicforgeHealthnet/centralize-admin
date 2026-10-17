const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ingestWebhookEvent,
} = require("../src/modules/marketing/social-operations/services/webhook-ingestion.service");
const {
  signWebhookPayload,
} = require("../src/modules/marketing/social-operations/services/webhook-verification.service");

function fakeWebhookDb() {
  const rows = [];
  return {
    rows,
    socialWebhookEvent: {
      async findUnique({ where }) {
        if (where.provider_eventId) {
          return rows.find(
            (row) =>
              row.provider === where.provider_eventId.provider &&
              row.eventId === where.provider_eventId.eventId,
          );
        }
        if (where.provider_payloadHash) {
          return rows.find(
            (row) =>
              row.provider === where.provider_payloadHash.provider &&
              row.payloadHash === where.provider_payloadHash.payloadHash,
          );
        }
        return null;
      },
      async create({ data }) {
        const row = { id: `evt-${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
    },
  };
}

test("webhook signature verification happens before persistence", async () => {
  let createCalled = false;
  const db = {
    socialWebhookEvent: {
      async findUnique() {
        return null;
      },
      async create() {
        createCalled = true;
        throw new Error("create should not run");
      },
    },
  };

  await assert.rejects(
    ingestWebhookEvent({
      provider: "META",
      headers: {},
      rawBody: Buffer.from("{}"),
      db,
      signatureVerifier: () => ({ valid: false, reasonCode: "WEBHOOK_SIGNATURE_INVALID" }),
    }),
    /Webhook signature/,
  );
  assert.equal(createCalled, false);
});

test("valid webhook is persisted before normalization and stores encrypted payload", async () => {
  const db = fakeWebhookDb();
  const rawBody = Buffer.from(JSON.stringify({ eventId: "evt-1", type: "MESSAGE" }));
  const result = await ingestWebhookEvent({
    provider: "META",
    headers: { "x-social-signature": signWebhookPayload({ provider: "META", rawBody, secret: "s" }) },
    rawBody,
    db,
    signatureVerifier: ({ headers }) => ({
      valid: Boolean(headers["x-social-signature"]),
      reasonCode: null,
    }),
  });

  assert.equal(result.acknowledged, true);
  assert.equal(result.duplicate, false);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].status, "RECEIVED");
  assert.equal(db.rows[0].signatureValid, true);
  assert.ok(Buffer.isBuffer(db.rows[0].encryptedRawPayload));
  assert.notEqual(db.rows[0].encryptedRawPayload.toString("utf8"), rawBody.toString("utf8"));
});

test("webhook dedup works by provider eventId and payloadHash fallback", async () => {
  const db = fakeWebhookDb();
  const firstBody = Buffer.from(JSON.stringify({ eventId: "evt-2", type: "COMMENT" }));
  const common = {
    provider: "META",
    headers: { "x-social-signature": "ok" },
    db,
    signatureVerifier: () => ({ valid: true, reasonCode: null }),
  };

  const first = await ingestWebhookEvent({ ...common, rawBody: firstBody });
  const duplicateById = await ingestWebhookEvent({ ...common, rawBody: firstBody });
  assert.equal(first.duplicate, false);
  assert.equal(duplicateById.duplicate, true);
  assert.equal(db.rows.length, 1);

  const fallbackBody = Buffer.from(JSON.stringify({ type: "COMMENT", value: "same" }));
  const fallbackFirst = await ingestWebhookEvent({
    ...common,
    provider: "TIKTOK",
    rawBody: fallbackBody,
  });
  const fallbackDuplicate = await ingestWebhookEvent({
    ...common,
    provider: "TIKTOK",
    rawBody: fallbackBody,
  });
  assert.equal(fallbackFirst.duplicate, false);
  assert.equal(fallbackDuplicate.duplicate, true);
  assert.equal(db.rows.length, 2);
});
