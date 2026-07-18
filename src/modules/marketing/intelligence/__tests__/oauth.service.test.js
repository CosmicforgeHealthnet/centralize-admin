const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createOauthService } = require("../oauth.service");
const { createProviderConnectionService } = require("../provider-connections.service");
const { decryptCredentialEnvelope } = require("../utils/credential-envelope");
const { createFakePrisma } = require("./helpers/fake-prisma");

beforeEach(() => {
  process.env.MARKETING_CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  process.env.ADMIN_BACKEND_PUBLIC_URL = "https://admin-api.example.test";
  process.env.ADMIN_FRONTEND_PUBLIC_URL = "https://admin.example.test";
  process.env.GOOGLE_ADS_CLIENT_ID = "google-client";
  process.env.GOOGLE_ADS_CLIENT_SECRET = "google-secret";
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "google-developer";
  process.env.MARKETING_OAUTH_STATE_TTL_SECONDS = "600";
});

function stateFrom(result) {
  return new URL(result.authorizationUrl).searchParams.get("state");
}

test("OAuth start stores hashed random state and never stores the raw state", async () => {
  const prisma = createFakePrisma();
  const service = createOauthService({ prisma });

  const first = await service.startOAuth(
    "GOOGLE_ADS",
    { customerId: "123-456-7890", currency: "usd" },
    "admin-1",
  );
  const second = await service.startOAuth(
    "GOOGLE_ADS",
    { customerId: "123-456-7890", currency: "usd" },
    "admin-1",
  );

  const firstState = stateFrom(first);
  const secondState = stateFrom(second);

  assert.ok(firstState);
  assert.notEqual(firstState, secondState);
  assert.equal(prisma.__state.oauthStates.length, 2);
  assert.notEqual(prisma.__state.oauthStates[0].stateHash, firstState);
  assert.ok(prisma.__state.oauthStates[0].encryptedVerifier.startsWith("v1:"));
});

test("OAuth callback exchanges code, encrypts tokens, and rejects state reuse", async () => {
  const prisma = createFakePrisma();
  const connections = createProviderConnectionService({ prisma });
  const httpClient = {
    async post() {
      return { data: { refresh_token: "google-refresh" } };
    },
  };
  const service = createOauthService({ prisma, httpClient, connections });

  const start = await service.startOAuth(
    "GOOGLE_ADS",
    { customerId: "123-456-7890", currency: "usd" },
    "admin-1",
  );
  const state = stateFrom(start);

  const result = await service.callbackOAuth("GOOGLE_ADS", {
    state,
    code: "auth-code",
  });

  assert.equal(result.connection.platform, "GOOGLE_ADS");
  assert.equal(result.connection.accountId, "1234567890");
  assert.ok(!JSON.stringify(result).includes("google-refresh"));
  assert.ok(!JSON.stringify(result).includes("google-secret"));

  const stored = prisma.__state.connections[0];
  const envelope = decryptCredentialEnvelope(stored.encryptedCredentials);
  assert.equal(envelope.refreshToken, "google-refresh");
  assert.equal(envelope.developerToken, "google-developer");

  await assert.rejects(
    () => service.callbackOAuth("GOOGLE_ADS", { state, code: "auth-code" }),
    /already been used/,
  );
});

test("OAuth callback rejects invalid state before token exchange", async () => {
  let exchanged = false;
  const service = createOauthService({
    prisma: createFakePrisma(),
    httpClient: {
      async post() {
        exchanged = true;
        return { data: {} };
      },
    },
  });

  await assert.rejects(
    () => service.callbackOAuth("GOOGLE_ADS", { state: "missing-state", code: "auth-code" }),
    /Invalid OAuth state/,
  );
  assert.equal(exchanged, false);
});
