const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { PrismaClient } = require("../src/generated/admin-client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { replayVerify, dropDatabase } = require("../scripts/social-operations/db-replay-verify");
const { createAuditAdapter } = require("../src/modules/marketing/advertising-execution/integrations/audit.adapter");
const { createCreativePublicationService } = require("../src/modules/marketing/advertising-execution/creatives/creative-publication.service");
const { CreativePublicationRepository } = require("../src/modules/marketing/advertising-execution/creatives/creative-publication.repository");
const { createProviderReviewSyncService, assertCreativeApprovedForActivation } = require("../src/modules/marketing/advertising-execution/creatives/provider-review-sync.service");
const { TargetingDiscoveryRepository } = require("../src/modules/marketing/advertising-execution/targeting/targeting-discovery.repository");
const { createTargetingDiscoveryService } = require("../src/modules/marketing/advertising-execution/targeting/targeting-discovery.service");
const { ExecutionJobRepository, jobSubmissionIdentity } = require("../src/modules/marketing/advertising-execution/jobs/execution-job.repository");
const { ReconciliationRepository } = require("../src/modules/marketing/advertising-execution/reconciliation/reconciliation.repository");
const { createReconciliationService } = require("../src/modules/marketing/advertising-execution/reconciliation/reconciliation.service");
const { createReconciliationWorker } = require("../src/modules/marketing/advertising-execution/jobs/reconciliation-worker");
const { hashExecutionJson } = require("../src/modules/marketing/advertising-execution/execution-json.validator");

const BASE_DATABASE_URL = process.env.DATABASE_URL;
const CONNECTION_ID = "a0000000-0000-4000-8000-000000000001";
const SECOND_CONNECTION_ID = "a0000000-0000-4000-8000-000000000002";
const AUTHOR_ID = "b0000000-0000-4000-8000-000000000001";
const APPROVER_ID = "b0000000-0000-4000-8000-000000000002";
const ASSET_ID = "pg-creative-asset-1";
const FINGERPRINT = "f".repeat(64);

function sha(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function png(width = 1080, height = 1080) {
  const bytes = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[25] = 2;
  return bytes;
}
function publication(overrides = {}) {
  return {
    creativeAssetId: ASSET_ID, platform: "META", connectionId: CONNECTION_ID,
    accountExternalId: "act_pg_1", apiVersion: "v25.0", providerFormat: "IMAGE",
    copy: { headline: "Care that listens", headlines: [], body: "Book today", primaryText: null, description: null, descriptions: [], callToAction: "LEARN_MORE", displayUrl: null, path1: null, path2: null, locale: "en" },
    destinationUrl: "https://health.example.com/care?utm_source=meta&campaign=summer#fragment",
    identityReference: "page-1", pageReference: "page-1", instagramIdentityReference: null,
    campaignExternalId: "campaign-1", groupExternalId: null, sourceMediaIds: ["media-1"],
    accessibility: { altText: "Clinician speaking with a patient", caption: null, transcriptRef: null, language: "en", label: null, humanSupplied: true },
    thumbnailChecksum: null, renderedProviderReference: null, materialTrackingKeys: ["campaign"],
    ...overrides,
  };
}

async function seedBase(client) {
  await client.adminUser.createMany({ data: [
    { id: AUTHOR_ID, email: "pg-author@example.invalid", password: "test-only-hash", name: "PG Author", tier: "SUPER", status: "ACTIVE", mustChangePassword: false },
    { id: APPROVER_ID, email: "pg-approver@example.invalid", password: "test-only-hash", name: "PG Approver", tier: "SUPER", status: "ACTIVE", mustChangePassword: false },
  ] });
  await client.marketing_ad_platform_connections.createMany({ data: [
    { id: CONNECTION_ID, platform: "META", accountId: "act_pg_1", accessToken: "example-encrypted-token-envelope", currency: "USD", connectionMetadata: { advertisingDestinationDomains: ["health.example.com"], advertisingTrackingParameters: ["campaign"] } },
    { id: SECOND_CONNECTION_ID, platform: "META", accountId: "act_pg_2", accessToken: "example-encrypted-token-envelope", currency: "USD", connectionMetadata: { advertisingDestinationDomains: ["health.example.com"] } },
  ] });
  await client.marketing_creative_assets.create({ data: {
    id: ASSET_ID, platform: "META", connectionId: CONNECTION_ID, accountExternalId: "act_pg_1",
    campaignExternalId: "campaign-1", creativeExternalId: "creative-source-1", sourceKey: "pg-source-1",
    name: "PostgreSQL creative", type: "IMAGE", firstSeenAt: new Date(), lastSeenAt: new Date(),
  } });
}

async function createApprovedJob(client, { suffix, connectionId = CONNECTION_ID, accountExternalId = "act_pg_1", expiresAt = new Date(Date.now() + 3600000), runFingerprint = FINGERPRINT } = {}) {
  const plan = await client.marketingExecutionPlan.create({ data: {
    planNumber: `PG-${suffix}`, sourceType: "MANUAL", platform: "META", connectionId, accountExternalId,
    name: `PG plan ${suffix}`, status: "APPROVED", version: 1, currencyCode: "USD",
    desiredState: { approvalPolicy: { requiredApprovals: 1 } }, validationFingerprint: FINGERPRINT,
    validatedAt: new Date(), expiresAt, createdByAdminUserId: AUTHOR_ID, updatedByAdminUserId: AUTHOR_ID,
  } });
  const item = await client.marketingExecutionPlanItem.create({ data: {
    planId: plan.id, sequence: 0, operationType: "UPDATE", resourceType: "CAMPAIGN",
    providerResourceId: `campaign-${suffix}`, clientReference: `item-${suffix}`, dependsOnItemIds: [],
    intent: { status: "PAUSED" }, beforeState: { status: "ACTIVE" }, materialHash: sha(`item-${suffix}`),
  } });
  await client.marketingExecutionApproval.create({ data: {
    planId: plan.id, planVersion: 1, validationFingerprint: FINGERPRINT, decision: "APPROVED",
    approverAdminUserId: APPROVER_ID, approvalScope: { accountExternalId }, decidedAt: new Date(),
  } });
  const run = await client.marketingExecutionRun.create({ data: {
    planId: plan.id, submissionKey: sha(`run-${suffix}`), status: "QUEUED", trigger: "MANUAL",
    approvalFingerprint: runFingerprint, approvedPlanVersion: 1,
  } });
  const job = await client.marketingExecutionJob.create({ data: {
    runId: run.id, connectionId, platform: "META", accountExternalId, submissionIdentity: jobSubmissionIdentity(run.id), status: "PENDING",
  } });
  return { plan, item, run, job };
}

test("Sections 18-24 use real PostgreSQL transactions with fake provider clients", { timeout: 240000 }, async (t) => {
  assert.ok(BASE_DATABASE_URL, "DATABASE_URL is required");
  const replay = await replayVerify({ keep: true });
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: replay.replayUrl }) });
  await client.$connect();
  try {
    await seedBase(client);
    const audit = createAuditAdapter({ client });

    await t.test("creative validation persists, allocates concurrent revisions, deduplicates, scans, and sanitizes", async () => {
      const repository = new CreativePublicationRepository({ client });
      const service = createCreativePublicationService({
        client, repository, authorize: async () => true, audit,
        destinationDnsResolver: async () => [{ address: "93.184.216.34", family: 4 }],
        malwareScanner: { scan: async () => ({ status: "CLEAN", scanner: "fake-pg" }) },
      });
      const actor = { id: AUTHOR_ID, tier: "SUPER", status: "ACTIVE" };
      const media = { buffer: png(), mimetype: "image/png" };
      const [first, duplicate] = await Promise.all([
        service.createRevision({ actor, input: publication(), media }),
        service.createRevision({ actor, input: publication(), media }),
      ]);
      assert.equal(first.id, duplicate.id);
      assert.equal([first.reusedRevision, duplicate.reusedRevision].filter(Boolean).length, 1);
      assert.equal(JSON.stringify(first).includes("accessToken"), false);
      assert.equal(JSON.stringify(first).includes("v1:test-only"), false);
      const [revisionTwo, revisionThree] = await Promise.all([
        service.createRevision({ actor, input: publication({ copy: { ...publication().copy, headline: "First material change" } }), media }),
        service.createRevision({ actor, input: publication({ copy: { ...publication().copy, headline: "Second material change" } }), media }),
      ]);
      assert.deepEqual([revisionTwo.revision, revisionThree.revision].sort(), [2, 3]);
      assert.equal(await client.marketingCreativePublication.count({ where: { creativeAssetId: ASSET_ID } }), 3);
      await assert.rejects(service.createRevision({ actor, input: publication(), media: { buffer: Buffer.from("MZ executable"), mimetype: "image/png" } }), (error) => error.errors[0].reasonCode === "MIME_OR_SIGNATURE_NOT_ALLOWED");
      const infected = createCreativePublicationService({ client, repository, authorize: async () => true, destinationDnsResolver: async () => [{ address: "93.184.216.34", family: 4 }], malwareScanner: { scan: async () => ({ status: "INFECTED", scanner: "fake-pg" }) } });
      await assert.rejects(infected.createRevision({ actor, input: publication({ copy: { ...publication().copy, headline: "Infected media" } }), media }), (error) => error.errors[0].reasonCode === "MEDIA_MALWARE_INFECTED");
      assert.equal(await client.marketingCreativePublication.count({ where: { creativeAssetId: ASSET_ID } }), 3);

      const review = createProviderReviewSyncService({ repository, providerReadRegistry: { resolve: () => ({ readCreativeReview: async () => ({ status: "APPROVED", code: "OK", message: "Approved", providerVersion: "v25.0", providerCreativeId: "creative-123" }) }) }, audit });
      assert.throws(() => assertCreativeApprovedForActivation({ reviewStatus: "DRAFT" }), (error) => error.errors[0].reasonCode === "CREATIVE_REVIEW_NOT_APPROVED");
      const approved = await review.sync(first.id);
      assert.equal(approved.reviewStatus, "APPROVED");
      assert.equal(assertCreativeApprovedForActivation(approved).id, first.id);
      assert.equal(await client.marketingCreativePublicationReviewEvent.count({ where: { publicationId: first.id } }), 1);
    });

    await t.test("targeting discovery persists native IDs and revalidates expiry", async () => {
      let now = new Date("2026-07-22T10:00:00Z");
      let providerReads = 0;
      const repository = new TargetingDiscoveryRepository({ client, now: () => now });
      const service = createTargetingDiscoveryService({ client, repository, ttlMs: 60000, providerReadRegistry: { resolve: () => ({ discover: async () => { providerReads += 1; return [{ normalizedIdentifier: "rome", nativeIdentifier: "1021865", displayName: "Rome", metadata: { country: "IT" } }]; } }) } });
      const request = { provider: "META", apiVersion: "v25.0", connectionId: CONNECTION_ID, accountExternalId: "act_pg_1", criterion: { type: "LOCATION", query: "Rome" } };
      assert.equal((await service.resolve(request)).cache, "MISS");
      assert.equal((await service.resolve(request)).cache, "HIT");
      assert.equal(providerReads, 1);
      now = new Date(now.getTime() + 60001);
      assert.equal((await service.resolve(request)).cache, "MISS");
      assert.equal(providerReads, 2);
      const stored = await client.marketingTargetingDiscovery.findFirst({ where: { connectionId: CONNECTION_ID } });
      assert.equal(stored.nativeIdentifier, "1021865");
    });

    await t.test("SKIP LOCKED, exact approval qualification, and account serialization are enforced", async () => {
      const repository = new ExecutionJobRepository({ client });
      const primary = await createApprovedJob(client, { suffix: "primary" });
      const claims = await Promise.all([
        repository.claimEligibleApproved({ leaseOwner: "worker-a", enabledProviders: ["META"] }),
        repository.claimEligibleApproved({ leaseOwner: "worker-b", enabledProviders: ["META"] }),
      ]);
      assert.equal(claims.flat().filter((row) => row.id === primary.job.id).length, 1);
      const sameAccount = await createApprovedJob(client, { suffix: "same-account" });
      assert.deepEqual(await repository.claimEligibleApproved({ leaseOwner: "worker-c", enabledProviders: ["META"] }), []);
      assert.equal((await client.marketingExecutionJob.findUnique({ where: { id: sameAccount.job.id } })).status, "PENDING");
      const differentAccount = await createApprovedJob(client, { suffix: "different-account", connectionId: SECOND_CONNECTION_ID, accountExternalId: "act_pg_2" });
      assert.equal((await repository.claimEligibleApproved({ leaseOwner: "worker-d", enabledProviders: ["META"] }))[0].id, differentAccount.job.id);
      const expired = await createApprovedJob(client, { suffix: "expired", expiresAt: new Date(Date.now() - 1000) });
      const stale = await createApprovedJob(client, { suffix: "stale", runFingerprint: "e".repeat(64) });
      const blocked = await repository.claimEligibleApproved({ leaseOwner: "worker-e", enabledProviders: ["META"] });
      assert.equal(blocked.some((row) => [expired.job.id, stale.job.id].includes(row.id)), false);
    });

    await t.test("reconciliation worker reads back, verifies, and updates durable aggregates", async () => {
      const seeded = await createApprovedJob(client, { suffix: "reconciliation", connectionId: SECOND_CONNECTION_ID, accountExternalId: "act_pg_2" });
      await client.marketingExecutionJob.update({ where: { id: seeded.job.id }, data: { status: "RECONCILING", reconciliationRequired: true } });
      await client.marketingExecutionRun.update({ where: { id: seeded.run.id }, data: { status: "RECONCILING" } });
      const operation = await client.marketingProviderOperation.create({ data: {
        runId: seeded.run.id, itemId: seeded.item.id, providerOperationKey: sha("reconciliation-operation"), status: "UNKNOWN", outcomeCertainty: "UNKNOWN",
        idempotencyIdentity: { version: 2, provider: "META", connectionId: SECOND_CONNECTION_ID, accountExternalId: "act_pg_2", approvedPlanId: seeded.plan.id, approvedPlanVersion: 1, itemId: seeded.item.id, operationType: "UPDATE", resourceType: "CAMPAIGN", materialHash: seeded.item.materialHash },
      } });
      const desired = { status: "PAUSED", budget: "100.00" };
      const hashed = hashExecutionJson(desired, "normalizedState");
      await client.marketingExecutionStateSnapshot.create({ data: { operationId: operation.id, kind: "DESIRED", sequence: 1, normalizedState: hashed.sanitized, hash: hashed.hash, capturedAt: new Date() } });
      const repository = new ReconciliationRepository({ client });
      const queued = await repository.enqueue({ operationId: operation.id, runId: seeded.run.id, planId: seeded.plan.id, reason: "UNKNOWN_PROVIDER_OUTCOME", providerIdentity: { providerRequestId: "fake-request" } });
      const service = createReconciliationService({ client, audit });
      const worker = createReconciliationWorker({ enabled: true, repository, reconciliationService: service, providerReadRegistry: { resolve: () => ({ apiVersion: "v25.0", readResource: async () => ({ budget: "100.0", status: "PAUSED" }) }) } });
      assert.equal(worker.start(), true);
      const result = await worker.processNext({ owner: "reconciliation-test" });
      assert.equal(result.status, "VERIFIED");
      assert.equal((await client.marketingExecutionReconciliationJob.findUnique({ where: { id: queued.id } })).status, "SUCCEEDED");
      assert.equal((await client.marketingProviderOperation.findUnique({ where: { id: operation.id } })).status, "VERIFIED");
      assert.equal((await client.marketingExecutionRun.findUnique({ where: { id: seeded.run.id } })).status, "SUCCEEDED");
      assert.equal((await client.marketingExecutionPlan.findUnique({ where: { id: seeded.plan.id } })).status, "SUCCEEDED");
      assert.deepEqual(await worker.shutdown(), { stopped: true, inFlightCheckpointed: true });
    });
  } finally {
    await client.$disconnect();
    await dropDatabase(BASE_DATABASE_URL, replay.databaseName);
  }
});
