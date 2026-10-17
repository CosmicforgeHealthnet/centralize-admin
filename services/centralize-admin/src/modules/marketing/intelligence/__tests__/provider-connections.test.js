const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createProviderConnectionService } = require("../provider-connections.service");
const { decryptCredential, encryptCredential } = require("../utils/credential-encryption");
const { decryptCredentialEnvelope, ENVELOPE_MARKER } = require("../utils/credential-envelope");
const { createFakePrisma } = require("./helpers/fake-prisma");

const CONNECTION_IDS = Object.freeze({
  primary: "11111111-1111-4111-8111-111111111111",
  meta: "22222222-2222-4222-8222-222222222222",
  metaSuccess: "33333333-3333-4333-8333-333333333333",
  metaLive: "44444444-4444-4444-8444-444444444444",
  tiktok: "55555555-5555-4555-8555-555555555555",
  linkedin: "66666666-6666-4666-8666-666666666666",
  google: "77777777-7777-4777-8777-777777777777",
});

beforeEach(() => {
  process.env.MARKETING_CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  process.env.META_ACCESS_TOKEN = "meta-env-token";
  process.env.META_AD_ACCOUNT_ID = "act_meta_123";
  process.env.TIKTOK_ACCESS_TOKEN = "tt-env-token";
  process.env.TIKTOK_REFRESH_TOKEN = "tt-refresh-token";
  process.env.TIKTOK_ADVERTISER_ID = "tt-adv-123";
  process.env.GOOGLE_ADS_CLIENT_ID = "google-client";
  process.env.GOOGLE_ADS_CLIENT_SECRET = "google-secret";
  process.env.GOOGLE_ADS_REFRESH_TOKEN = "google-refresh";
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "google-developer";
  process.env.GOOGLE_ADS_CUSTOMER_ID = "123-456-7890";
});

test("TikTok env credentials bootstrap into an encrypted active DB connection", async () => {
  const prisma = createFakePrisma();
  const service = createProviderConnectionService({ prisma });

  const result = await service.bootstrapConnectionFromEnv("TIKTOK");

  assert.equal(result.status, "CREATED");
  assert.equal(prisma.__state.connections.length, 1);
  const stored = prisma.__state.connections[0];
  assert.equal(stored.platform, "TIKTOK");
  assert.equal(stored.accountId, "tt-adv-123");
  assert.ok(stored.accessToken.startsWith("v1:"));
  assert.ok(stored.refreshToken.startsWith("v1:"));
  assert.equal(decryptCredential(stored.accessToken), "tt-env-token");
  assert.equal(decryptCredential(stored.refreshToken), "tt-refresh-token");
  assert.ok(!JSON.stringify(result).includes("tt-env-token"));
});

test("bootstrap is idempotent and does not duplicate existing connections", async () => {
  const prisma = createFakePrisma();
  const service = createProviderConnectionService({ prisma });

  await service.bootstrapConnectionFromEnv("TIKTOK");
  const second = await service.bootstrapConnectionFromEnv("TIKTOK");

  assert.equal(second.status, "EXISTING_ACTIVE");
  assert.equal(prisma.__state.connections.length, 1);
});

test("existing DB credentials are preferred over older environment tokens", async () => {
  const prisma = createFakePrisma();
  prisma.__state.connections.push({
    id: CONNECTION_IDS.primary,
    platform: "TIKTOK",
    accountId: "tt-adv-123",
    accessToken: encryptCredential("db-new-token"),
    refreshToken: encryptCredential("db-refresh-token"),
    status: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  process.env.TIKTOK_ACCESS_TOKEN = "older-env-token";
  const service = createProviderConnectionService({ prisma });

  const connections = await service.getActiveConnectionOrBootstrap("TIKTOK");

  assert.equal(connections.length, 1);
  assert.equal(decryptCredential(prisma.__state.connections[0].accessToken), "db-new-token");
});

test("connection metadata never returns encrypted or plaintext tokens", async () => {
  const prisma = createFakePrisma();
  const service = createProviderConnectionService({ prisma });

  await service.bootstrapConnectionFromEnv("META");
  const metadata = await service.listConnections();
  const serialized = JSON.stringify(metadata);

  assert.equal(metadata[0].hasAccessToken, true);
  assert.ok(!serialized.includes("meta-env-token"));
  assert.ok(!serialized.includes("v1:"));
  assert.equal(Object.hasOwn(metadata[0], "accessToken"), false);
  assert.equal(Object.hasOwn(metadata[0], "refreshToken"), false);
});

test("Google Ads env credentials bootstrap into encrypted envelope storage", async () => {
  const prisma = createFakePrisma();
  const service = createProviderConnectionService({ prisma });

  const result = await service.bootstrapConnectionFromEnv("GOOGLE_ADS");

  assert.equal(result.status, "CREATED");
  const stored = prisma.__state.connections[0];
  assert.equal(stored.platform, "GOOGLE_ADS");
  assert.equal(stored.accountId, "1234567890");
  assert.equal(decryptCredential(stored.accessToken), ENVELOPE_MARKER);
  const envelope = decryptCredentialEnvelope(stored.encryptedCredentials);
  assert.equal(envelope.clientId, "google-client");
  assert.equal(envelope.clientSecret, "google-secret");
  assert.equal(envelope.refreshToken, "google-refresh");
  assert.equal(envelope.developerToken, "google-developer");
  assert.equal(result.connection.hasEncryptedCredentials, true);
  assert.equal(result.connection.hasRequiredCredentials, true);
  assert.ok(!JSON.stringify(result).includes("google-secret"));
});

test("manual X connection upsert stores provider credentials in the envelope only", async () => {
  const prisma = createFakePrisma();
  const service = createProviderConnectionService({ prisma });

  const result = await service.upsertConnection({
    platform: "X",
    accountId: "x-acct-1",
    credentials: {
      consumerKey: "consumer-key",
      consumerSecret: "consumer-secret",
      accessToken: "x-access",
      accessTokenSecret: "x-access-secret",
    },
    connectionMetadata: { accountId: "x-acct-1" },
    currency: "usd",
  });

  const stored = prisma.__state.connections[0];
  const envelope = decryptCredentialEnvelope(stored.encryptedCredentials);
  assert.equal(result.platform, "X");
  assert.equal(result.currency, "USD");
  assert.equal(result.hasRequiredCredentials, true);
  assert.equal(envelope.accessTokenSecret, "x-access-secret");
  assert.ok(!JSON.stringify(result).includes("x-access-secret"));
});

test("connection get, update, disable, enable, and delete are safe metadata operations", async () => {
  const prisma = createFakePrisma();
  const service = createProviderConnectionService({ prisma });

  const created = await service.upsertConnection({
    platform: "META",
    accountId: "12345",
    accessToken: "meta-access",
    currency: "ngn",
  });

  assert.equal(created.accountId, "act_12345");
  const fetched = await service.getConnection(created.id);
  assert.equal(fetched.hasRequiredCredentials, true);

  const updated = await service.updateConnection(created.id, {
    platform: "META",
    accountId: "act_12345",
    accessToken: "meta-new-access",
    currency: "usd",
  });
  assert.equal(updated.currency, "USD");
  assert.ok(!JSON.stringify(updated).includes("meta-new-access"));

  const disabled = await service.disableConnection(created.id);
  assert.equal(disabled.status, "DISABLED");

  const enabled = await service.enableConnection(created.id);
  assert.equal(enabled.status, "ACTIVE");

  const deleted = await service.deleteConnection(created.id);
  assert.equal(deleted.status, "DISABLED");
  assert.equal(prisma.__state.connections.length, 1);
});

test("Google Ads customer IDs are normalized and invalid IDs are rejected", async () => {
  const prisma = createFakePrisma();
  const service = createProviderConnectionService({ prisma });

  const created = await service.upsertConnection({
    platform: "GOOGLE_ADS",
    customerId: "123-456-7890",
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    developerToken: "developer",
    currency: "usd",
  });

  assert.equal(created.accountId, "1234567890");
  await assert.rejects(
    () =>
      service.upsertConnection({
        platform: "GOOGLE_ADS",
        customerId: "abc",
        clientId: "client",
        clientSecret: "secret",
        refreshToken: "refresh",
        developerToken: "developer",
        currency: "usd",
      }),
    /customerId must be numeric/,
  );
});

test("connection test returns sanitized provider failures", async () => {
  const prisma = createFakePrisma();
  prisma.__state.connections.push({
    id: CONNECTION_IDS.meta,
    platform: "META",
    accountId: "act_meta_123",
    accessToken: encryptCredential("meta-secret-token"),
    status: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const connectors = {
    META: {
      async fetchDailyCampaignInsights() {
        throw new Error("provider rejected access_token=meta-secret-token and app_secret=app-secret");
      },
    },
  };
  const service = createProviderConnectionService({ prisma, connectors });

  const result = await service.testConnection(CONNECTION_IDS.meta, { since: "2026-07-01", until: "2026-07-01" });

  assert.equal(result.ok, false);
  assert.equal(result.validationStatus, "FAILED");
  assert.equal(prisma.__state.connections[0].validationStatus, "FAILED");
  assert.ok(!result.error.includes("meta-secret-token"));
  assert.ok(!result.error.includes("app-secret"));
  assert.ok(result.error.includes("***REDACTED***"));
});

test("connection test records bounded-fetch success without live provider calls", async () => {
  const prisma = createFakePrisma();
  prisma.__state.connections.push({
    id: CONNECTION_IDS.metaSuccess,
    platform: "META",
    accountId: "act_meta_123",
    accessToken: encryptCredential("meta-secret-token"),
    currency: "USD",
    status: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  let calls = 0;
  const connectors = {
    META: {
      async fetchDailyCampaignInsights() {
        calls += 1;
        return [{ campaignExternalId: "camp-1" }];
      },
    },
  };
  const service = createProviderConnectionService({ prisma, connectors });

  const result = await service.testConnection(CONNECTION_IDS.metaSuccess, {
    since: "2026-07-01",
    until: "2026-07-01",
  });

  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.validationStatus, "BOUNDED_FETCH_PASSED");
  assert.equal(prisma.__state.connections[0].validationStatus, "BOUNDED_FETCH_PASSED");
  assert.ok(prisma.__state.connections[0].lastConnectionTestAt instanceof Date);
  assert.ok(prisma.__state.connections[0].lastSuccessfulFetchAt instanceof Date);
  assert.equal(prisma.__state.connections[0].sanitizedValidationError, null);
});

test("provider validation status reports all five platforms and isolates blockers", async () => {
  const prisma = createFakePrisma();
  prisma.__state.connections.push(
    {
      id: CONNECTION_IDS.metaLive,
      platform: "META",
      accountId: "act_meta_123",
      status: "ACTIVE",
      validationStatus: "LIVE_VALIDATED",
      lastConnectionTestAt: new Date(),
      lastSuccessfulFetchAt: new Date(),
      lastMetricReconciliationAt: new Date(),
      lastPaginationVerificationAt: new Date(),
      lastRateLimitVerificationAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: CONNECTION_IDS.tiktok,
      platform: "TIKTOK",
      accountId: "tt-adv-123",
      status: "ERROR",
      validationStatus: "CREDENTIAL_BLOCKED",
      sanitizedValidationError: "invalid token",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: CONNECTION_IDS.linkedin,
      platform: "LINKEDIN",
      accountId: "urn:li:sponsoredAccount:123",
      status: "ACTIVE",
      validationStatus: "APPROVAL_BLOCKED",
      sanitizedValidationError: "missing scope",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  );
  const service = createProviderConnectionService({ prisma, connectors: {} });

  const statuses = await service.listValidationStatus();
  const byPlatform = Object.fromEntries(statuses.map((row) => [row.platform, row]));

  assert.deepEqual(statuses.map((row) => row.platform), ["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"]);
  for (const row of statuses) {
    assert.equal(row.codeStatus, "IMPLEMENTED");
    assert.equal(row.mockTests, "MOCK_VERIFIED");
  }
  assert.equal(byPlatform.META.liveStatus, "LIVE_VALIDATED");
  assert.equal(byPlatform.META.blocker, null);
  assert.equal(byPlatform.TIKTOK.liveStatus, "CREDENTIAL_BLOCKED");
  assert.equal(byPlatform.LINKEDIN.liveStatus, "APPROVAL_BLOCKED");
  assert.equal(byPlatform.X.liveStatus, "NOT_VALIDATED");
  assert.equal(byPlatform.GOOGLE_ADS.liveStatus, "NOT_VALIDATED");
  assert.equal(byPlatform.TIKTOK.blocker, "EXTERNAL_CREDENTIAL_OR_APPROVAL_REQUIRED");
  assert.ok(!JSON.stringify(statuses).includes("meta-secret-token"));
});

test("live validation requires every applicable gate including token refresh", async () => {
  const prisma = createFakePrisma();
  prisma.__state.connections.push({
    id: CONNECTION_IDS.google,
    platform: "GOOGLE_ADS",
    accountId: "1234567890",
    status: "ACTIVE",
    connectionMetadata: { tokenRefreshApplicable: true },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const service = createProviderConnectionService({ prisma, connectors: {} });

  const partial = await service.recordValidationEvidence(CONNECTION_IDS.google, {
    connectionTestPassed: true,
    boundedFetchPassed: true,
    metricReconciled: true,
    paginationVerified: true,
    rateLimitVerified: true,
  });
  assert.equal(partial.validationStatus, "METRIC_RECONCILED");

  const complete = await service.recordValidationEvidence(CONNECTION_IDS.google, {
    tokenRefreshVerified: true,
  });
  assert.equal(complete.validationStatus, "LIVE_VALIDATED");
  assert.ok(complete.lastTokenRefreshVerificationAt instanceof Date);
});
