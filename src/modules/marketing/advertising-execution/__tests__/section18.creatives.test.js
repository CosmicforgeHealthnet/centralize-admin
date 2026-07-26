const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeDestinationUrl, assertDestinationNetworkSafe } = require("../creatives/destination-url.policy");
const { validateMedia } = require("../creatives/media.validator");
const { validateCreativePublication, unicodeLength } = require("../creatives/creative-publication.validator");
const { CreativePublicationRepository } = require("../creatives/creative-publication.repository");
const { createValidatedPublicationDto } = require("../creatives/validated-publication.dto");
const { hashCreative } = require("../creatives/creative-hash.service");
const { mapCreativePublication } = require("../creatives/creative-publication.response");

const CONNECTION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
function publication(overrides = {}) { return { creativeAssetId: "asset-1", platform: "META", connectionId: CONNECTION, accountExternalId: "act_1", apiVersion: "v25.0", providerFormat: "IMAGE", copy: { headline: "Care that listens", headlines: [], body: "Book today", primaryText: null, description: null, descriptions: [], callToAction: "LEARN_MORE", displayUrl: null, path1: null, path2: null, locale: "en" }, destinationUrl: "https://health.example.com/care?utm_source=meta#section", identityReference: "page-1", pageReference: "page-1", instagramIdentityReference: null, campaignExternalId: null, groupExternalId: null, sourceMediaIds: ["media-1"], accessibility: { altText: "Clinician speaking with a patient", caption: null, transcriptRef: null, language: "en", label: null, humanSupplied: true }, thumbnailChecksum: null, renderedProviderReference: null, materialTrackingKeys: [], ...overrides }; }
function png(width = 1080, height = 1080) { const bytes = Buffer.alloc(33); Buffer.from("89504e470d0a1a0a", "hex").copy(bytes); bytes.write("IHDR", 12, "ascii"); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); bytes[25] = 2; return bytes; }

test("creative publication is strict, Unicode-aware, accessible, and destination-safe", () => {
  const value = validateCreativePublication(publication(), { providerFormats: ["IMAGE"], formatLimits: { altTextRequired: true, textLengths: { headline: 40 } }, destinationPolicy: { allowedDomains: ["health.example.com"], requireUtm: true } });
  assert.equal(value.destinationUrl, "https://health.example.com/care?utm_source=meta");
  assert.equal(unicodeLength("🧑🏽‍⚕️"), Array.from("🧑🏽‍⚕️").length);
  assert.throws(() => validateCreativePublication(publication({ unknown: true }), { destinationPolicy: { allowedDomains: ["health.example.com"] } }), (error) => error.code === "INVALID_EXECUTION_PLAN");
  assert.throws(() => validateCreativePublication(publication({ accessibility: { altText: null, caption: null, transcriptRef: null, language: "en", label: null, humanSupplied: true } }), { formatLimits: { altTextRequired: true }, destinationPolicy: { allowedDomains: ["health.example.com"] } }), (error) => error.errors[0].reasonCode === "ALT_TEXT_REQUIRED");
});

test("destination URL rejects SSRF ranges, credentials, secrets, duplicate UTM conflicts, and unsafe DNS", async () => {
  for (const url of ["http://health.example.com", "https://localhost", "https://127.0.0.1", "https://[::1]"]) assert.throws(() => normalizeDestinationUrl(url, { allowedDomains: [new URL(url).hostname] }), (error) => error.code === "INVALID_EXECUTION_PLAN");
  assert.throws(() => normalizeDestinationUrl("https://evil.example.com", { allowedDomains: ["health.example.com"] }), (error) => error.errors[0].reasonCode === "DESTINATION_DOMAIN_NOT_ALLOWED");
  assert.throws(() => normalizeDestinationUrl("https://health.example.com/?access_token=secret", { allowedDomains: ["health.example.com"] }), (error) => error.errors[0].reasonCode === "SIGNED_OR_SECRET_URL_FORBIDDEN");
  assert.throws(() => normalizeDestinationUrl("https://health.example.com/?utm_source=a&utm_source=b", { allowedDomains: ["health.example.com"] }), (error) => error.errors[0].reasonCode === "CONFLICTING_DUPLICATE_PARAMETER");
  await assert.rejects(assertDestinationNetworkSafe("https://health.example.com/", { resolver: async () => [{ address: "10.0.0.1" }] }), (error) => error.errors[0].reasonCode === "DESTINATION_ADDRESS_BLOCKED");
});

test("media validation extracts actual metadata, rejects caller dimensions, and persists safe scan evidence", async () => {
  const result = await validateMedia({ bytes: png(), mimeType: "image/png", width: 1, height: 1 }, { limits: { allowedMimeTypes: ["image/png"], maxBytes: 1000, minWidth: 600, aspectRatios: ["1:1"], malwareScanRequired: true }, checksumLookup: async (checksum) => ({ id: `existing:${checksum.slice(0, 8)}` }), malwareScanner: { scan: async () => ({ status: "CLEAN", scanner: "fake" }) } });
  assert.equal(result.width, 1080); assert.equal(result.height, 1080); assert.match(result.checksum, /^[a-f0-9]{64}$/); assert.equal(result.malwareScanStatus, "CLEAN");
  await assert.rejects(validateMedia({ bytes: Buffer.from("not png"), mimeType: "image/png" }, { limits: { allowedMimeTypes: ["image/png"] } }), (error) => error.errors[0].reasonCode === "MIME_OR_SIGNATURE_NOT_ALLOWED");
  await assert.rejects(validateMedia({ bytes: png(), mimeType: "image/png" }, { limits: { allowedMimeTypes: ["image/png"], malwareScanRequired: true }, malwareScanner: { scan: async () => ({ status: "INFECTED" }) } }), (error) => error.errors[0].reasonCode === "MEDIA_MALWARE_INFECTED");
});

test("canonical hash includes rendered material but excludes revision and provider request metadata", () => {
  const media = { checksum: "a".repeat(64) };
  const first = hashCreative({ ...publication(), destinationUrl: "https://health.example.com/?utm_source=meta", media });
  const same = hashCreative({ ...publication(), destinationUrl: "https://health.example.com/?utm_source=meta", media, revision: 99, providerRequestId: "ignored" });
  const changed = hashCreative({ ...publication(), destinationUrl: "https://health.example.com/?utm_source=meta&utm_content=new", media });
  assert.equal(first.contentHash, same.contentHash); assert.notEqual(first.contentHash, changed.contentHash);
});

test("repository rejects unvalidated writes and advisory-lock allocation reuses exact material", async () => {
  let latest = null; const creates = [];
  const tx = { $executeRaw: async () => 1, marketing_creative_assets: { findFirst: async () => ({ id: "asset-1" }) }, marketingCreativePublication: { findFirst: async ({ where }) => where.contentHash ? (latest?.contentHash === where.contentHash ? latest : null) : latest, create: async ({ data }) => { creates.push(data); latest = { id: `pub-${data.revision}`, createdAt: new Date(), updatedAt: new Date(), ...data }; return latest; } }, marketingCreativeMediaValidationEvidence: { create: async () => ({ id: "evidence" }) } };
  const repository = new CreativePublicationRepository({ client: { $transaction: (callback) => callback(tx) } });
  await assert.rejects(repository.createRevision(publication()), (error) => error.errors[0].reasonCode === "UNVALIDATED_PUBLICATION_REPOSITORY_WRITE");
  const dto = () => createValidatedPublicationDto({ creativeAssetId: "asset-1", platform: "META", connectionId: CONNECTION, accountExternalId: "act_1", apiVersion: "v25.0", creativeFormat: "IMAGE", identityReference: "page-1", contentHash: "b".repeat(64), contentProjection: {}, reuseClassification: "ACCOUNT_REUSABLE", sourceMediaChecksum: "a".repeat(64), malwareStatus: "CLEAN", publicationMetadata: {}, mediaEvidence: { checksum: "a".repeat(64), mimeType: "image/png", byteLength: 33, width: 1, height: 1, durationMs: null, frameCount: 1, codec: "png", container: "png", hasAudio: false, hasTransparency: false, scannerEvidence: {} }, createdByAdminUserId: "admin-1" });
  const first = await repository.createRevision(dto()); const same = await repository.createRevision(dto());
  assert.equal(first.revision, 1); assert.equal(same.reusedRevision, true); assert.equal(creates.length, 1);
});

test("review synchronization is append-only and safe mapper excludes provider/storage secrets", async () => {
  const current = { id: "pub-1", reviewStatus: "PENDING_REVIEW" }; let event;
  const tx = { marketingCreativePublication: { findUnique: async () => current, update: async ({ data }) => ({ ...current, ...data }) }, marketingCreativePublicationReviewEvent: { create: async ({ data }) => { event = data; return data; } } };
  const repository = new CreativePublicationRepository({ client: { $transaction: (callback) => callback(tx) } });
  const limited = await repository.recordReviewState({ id: "pub-1", reviewStatus: "LIMITED", providerVersion: "v25.0", providerCode: "LIMITED", providerMessage: "Policy restriction" });
  assert.equal(limited.reviewStatus, "LIMITED"); assert.equal(event.previousStatus, "PENDING_REVIEW");
  const safe = mapCreativePublication({ ...limited, providerUploadToken: "secret", publicationMetadata: { storagePath: "private" }, contentProjection: {} });
  assert.equal(JSON.stringify(safe).includes("secret"), false); assert.equal(JSON.stringify(safe).includes("private"), false);
});
