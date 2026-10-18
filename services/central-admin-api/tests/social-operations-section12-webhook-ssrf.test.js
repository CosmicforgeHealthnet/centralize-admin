const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ingestWebhookEvent,
} = require("../src/modules/marketing/social-operations/services/webhook-ingestion.service");
const {
  parseEncryptedPayload,
} = require("../src/modules/marketing/social-operations/services/webhook-processing.service");
const {
  redactWebhookPayload,
} = require("../src/modules/marketing/social-operations/privacy/content-redaction.service");
const {
  validateRemoteMediaRequest,
  fetchRemoteMediaSafely,
} = require("../src/modules/marketing/social-operations/security/ssrf-safe-fetch.service");

function fakeWebhookDb() {
  const rows = [];
  return {
    rows,
    socialWebhookEvent: {
      async findUnique({ where }) {
        if (where.id) return rows.find((row) => row.id === where.id) || null;
        if (where.provider_eventId) {
          return rows.find(
            (row) =>
              row.provider === where.provider_eventId.provider &&
              row.eventId === where.provider_eventId.eventId,
          ) || null;
        }
        if (where.provider_payloadHash) {
          return rows.find(
            (row) =>
              row.provider === where.provider_payloadHash.provider &&
              row.payloadHash === where.provider_payloadHash.payloadHash,
          ) || null;
        }
        return null;
      },
      async create({ data }) {
        const row = { id: `evt-${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = rows.find((candidate) => candidate.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
  };
}

test("webhook verification uses exact raw bytes and invalid signatures persist nothing", async () => {
  const db = fakeWebhookDb();
  const rawBody = Buffer.from('{"eventId":"evt-1","text":"private synthetic"}');
  let receivedRawBody = null;
  await assert.rejects(
    ingestWebhookEvent({
      provider: "META",
      headers: { "x-test": "signature" },
      rawBody,
      db,
      signatureVerifier: ({ rawBody: verifierRawBody }) => {
        receivedRawBody = verifierRawBody;
        return { valid: false, reasonCode: "BAD_SIGNATURE" };
      },
    }),
    /Webhook signature/,
  );
  assert.equal(receivedRawBody, rawBody);
  assert.equal(db.rows.length, 0);
});

test("valid webhook stores encrypted payload, safe metadata, and deduplicates", async () => {
  const db = fakeWebhookDb();
  const rawBody = Buffer.from(
    JSON.stringify({
      eventId: "evt-2",
      type: "MESSAGE",
      text: "private synthetic message",
    }),
  );
  const common = {
    provider: "META",
    headers: { "x-test": "ok" },
    rawBody,
    db,
    signatureVerifier: () => ({ valid: true, reasonCode: null }),
  };

  const first = await ingestWebhookEvent(common);
  const duplicate = await ingestWebhookEvent(common);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(db.rows.length, 1);
  assert.notEqual(db.rows[0].encryptedRawPayload.toString("utf8"), rawBody.toString("utf8"));
  assert.equal(JSON.stringify(db.rows[0].payloadMetadataJson).includes("private synthetic"), false);
  assert.deepEqual(parseEncryptedPayload(db.rows[0]), {
    eventId: "evt-2",
    type: "MESSAGE",
    text: "private synthetic message",
  });

  await redactWebhookPayload({
    id: db.rows[0].id,
    db,
    auditWriter: async () => {},
  });
  assert.ok(db.rows[0].redactedAt);
  assert.equal(db.rows[0].encryptedRawPayload.toString("utf8").includes("private synthetic"), false);
});

test("SSRF-safe media validation rejects private networks and unsafe redirects", async () => {
  const resolver = async (hostname) => {
    if (hostname === "media.example.test") return [{ address: "93.184.216.34", family: 4 }];
    if (hostname === "mixed.example.test") {
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ];
    }
    if (hostname === "loop.example.test") return [{ address: "127.0.0.1", family: 4 }];
    if (hostname === "ipv6.example.test") return [{ address: "::1", family: 6 }];
    return [{ address: "169.254.169.254", family: 4 }];
  };

  const allowed = await validateRemoteMediaRequest({
    url: "https://media.example.test/image.png",
    allowedHosts: ["media.example.test"],
    resolver,
  });
  assert.deepEqual(allowed.addresses, ["93.184.216.34"]);

  for (const url of [
    "http://media.example.test/image.png",
    "https://user:pass@media.example.test/image.png",
    "https://loop.example.test/image.png",
    "https://mixed.example.test/image.png",
    "https://ipv6.example.test/image.png",
    "https://metadata.example.test/image.png",
  ]) {
    await assert.rejects(
      validateRemoteMediaRequest({
        url,
        allowedHosts: ["media.example.test", "loop.example.test", "mixed.example.test", "ipv6.example.test", "metadata.example.test"],
        resolver,
      }),
      /not allowed/,
    );
  }

  await assert.rejects(
    fetchRemoteMediaSafely({
      url: "https://media.example.test/start",
      allowedHosts: ["media.example.test"],
      resolver,
      fetcher: async () => ({
        status: 302,
        headers: { location: "https://loop.example.test/private" },
        body: Buffer.alloc(0),
      }),
    }),
    /not allowed/,
  );
});

test("SSRF-safe fetch rejects oversized and unexpected content without real network calls", async () => {
  const resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  let fetchCalls = 0;
  await assert.rejects(
    fetchRemoteMediaSafely({
      url: "https://media.example.test/image.png",
      allowedHosts: ["media.example.test"],
      resolver,
      maxBytes: 4,
      fetcher: async () => {
        fetchCalls += 1;
        return {
          status: 200,
          headers: { "content-type": "image/png" },
          body: Buffer.from("too-large"),
        };
      },
    }),
    /too large/,
  );
  await assert.rejects(
    fetchRemoteMediaSafely({
      url: "https://media.example.test/file.exe",
      allowedHosts: ["media.example.test"],
      resolver,
      allowedContentTypes: ["image/png"],
      fetcher: async () => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from("x"),
      }),
    }),
    /content type/,
  );
  assert.equal(fetchCalls, 1);
});
