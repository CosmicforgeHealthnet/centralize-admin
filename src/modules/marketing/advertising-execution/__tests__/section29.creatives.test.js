"use strict";

// Section 29 — Creative mandatory suite (file signature, size/aspect/duration,
// hash, revision, review rejection). Durable revision concurrency runs against
// PostgreSQL in tests/advertising-execution-sections18-24-postgres.test.js;
// this suite drives the production media validator, hash service, publication
// validator and review synchronization with binary fixtures built in-process.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { validateMedia, extractMediaMetadata } = require("../creatives/media.validator");
const { hashCreative } = require("../creatives/creative-hash.service");
const { validateCreativePublication, unicodeLength } = require("../creatives/creative-publication.validator");
const { providerCreativeRules, supportedCreativeFormats } = require("../creatives/provider-creative-rules.registry");
const { BLOCKING_REVIEW_STATES, assertCreativeApprovedForActivation, createProviderReviewSyncService } = require("../creatives/provider-review-sync.service");

function png(width = 1080, height = 1080) {
  const bytes = Buffer.alloc(64);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[25] = 6;
  return bytes;
}

const IMAGE_LIMITS = { allowedMimeTypes: ["image/png", "image/jpeg"], maxBytes: 5 * 1024 * 1024, minWidth: 600, minHeight: 600, aspectRatios: ["1:1"], malwareScanRequired: false };
const cleanScanner = { scan: async () => ({ status: "CLEAN", scanner: "fake-scanner", checkedAt: "2026-07-23T10:00:00.000Z" }) };

function publicationInput(overrides = {}) {
  return {
    creativeAssetId: "asset-1", platform: "META", connectionId: "11111111-1111-4111-8111-111111111111",
    accountExternalId: "act_123", apiVersion: "v25.0", providerFormat: "IMAGE",
    copy: { headline: "Care that listens", headlines: [], body: "Book a visit today", primaryText: null, description: null, descriptions: [], callToAction: "LEARN_MORE", displayUrl: null, path1: null, path2: null, locale: "en" },
    destinationUrl: "https://health.example.com/care?utm_source=meta",
    identityReference: "page-1", pageReference: "page-1", instagramIdentityReference: null,
    campaignExternalId: null, groupExternalId: null, sourceMediaIds: ["media-1"],
    accessibility: { altText: "Clinician with a patient", caption: null, transcriptRef: null, language: "en", label: null, humanSupplied: true },
    thumbnailChecksum: null, renderedProviderReference: null, materialTrackingKeys: [],
    ...overrides,
  };
}

test("29-CREATIVE signatures: declared MIME mismatch, truncation, executables and polyglots are rejected", async () => {
  // Correct signature passes with real extracted metadata.
  const valid = await validateMedia({ bytes: png(800, 800), mimeType: "image/png" }, { limits: IMAGE_LIMITS, malwareScanner: cleanScanner });
  assert.equal(valid.width, 800);
  assert.equal(valid.height, 800);
  assert.match(valid.checksum, /^[a-f0-9]{64}$/);
  // Declared MIME does not match the actual bytes (extension/MIME mismatch).
  await assert.rejects(validateMedia({ bytes: png(), mimeType: "image/jpeg" }, { limits: IMAGE_LIMITS }), (error) => error.errors[0].reasonCode === "MIME_OR_SIGNATURE_NOT_ALLOWED");
  // Truncated and malformed files fail signature or metadata extraction.
  await assert.rejects(validateMedia({ bytes: png().subarray(0, 10), mimeType: "image/png" }, { limits: IMAGE_LIMITS }), (error) => error.code === "INVALID_EXECUTION_PLAN");
  assert.throws(() => extractMediaMetadata(Buffer.from("ffd8ffe0", "hex"), "image/jpeg"), (error) => error.errors[0].reasonCode === "MIME_OR_SIGNATURE_NOT_ALLOWED");
  // Executable signatures (PE) and shebang polyglots are always blocked.
  const pePolyglot = Buffer.concat([Buffer.from("4d5a", "hex"), png()]);
  assert.throws(() => extractMediaMetadata(pePolyglot, "image/png"), (error) => error.errors[0].reasonCode === "MIME_OR_SIGNATURE_NOT_ALLOWED");
  const shebang = Buffer.concat([Buffer.from("2321", "hex"), Buffer.alloc(40)]);
  assert.throws(() => extractMediaMetadata(shebang, "image/png"), (error) => error.errors[0].reasonCode === "MIME_OR_SIGNATURE_NOT_ALLOWED");
  // Unsupported types fail the allowlist before any parsing.
  await assert.rejects(validateMedia({ bytes: png(), mimeType: "image/gif" }, { limits: IMAGE_LIMITS }), (error) => error.errors[0].reasonCode === "MIME_OR_SIGNATURE_NOT_ALLOWED");
  // A failed validation means no provider upload can ever start (no transport is even reachable here).
});

test("29-CREATIVE size, dimension, aspect-ratio, duration and scan limits enforce provider rules", async () => {
  // Byte bounds.
  await assert.rejects(validateMedia({ bytes: png(), mimeType: "image/png" }, { limits: { ...IMAGE_LIMITS, maxBytes: 10 } }), (error) => error.errors[0].reasonCode === "MEDIA_TOO_LARGE");
  await assert.rejects(validateMedia({ bytes: Buffer.alloc(0), mimeType: "image/png" }, { limits: IMAGE_LIMITS }), (error) => error.errors[0].reasonCode === "MEDIA_INPUT_BOUNDS_EXCEEDED");
  // Width/height minimums and aspect ratios come from measured pixels, not caller claims.
  await assert.rejects(validateMedia({ bytes: png(300, 300), mimeType: "image/png" }, { limits: IMAGE_LIMITS }), (error) => error.errors[0].reasonCode === "MEDIA_DIMENSIONS_UNSUPPORTED");
  await assert.rejects(validateMedia({ bytes: png(1200, 600), mimeType: "image/png" }, { limits: IMAGE_LIMITS }), (error) => error.errors[0].reasonCode === "MEDIA_ASPECT_RATIO_UNSUPPORTED");
  // Malware policy: required scans block unless CLEAN; INFECTED and PENDING always block.
  await assert.rejects(validateMedia({ bytes: png(800, 800), mimeType: "image/png" }, { limits: { ...IMAGE_LIMITS, malwareScanRequired: true } }), (error) => error.errors[0].reasonCode === "MEDIA_MALWARE_NOT_CONFIGURED");
  await assert.rejects(validateMedia({ bytes: png(800, 800), mimeType: "image/png" }, { limits: IMAGE_LIMITS, malwareScanner: { scan: async () => ({ status: "INFECTED" }) } }), (error) => error.errors[0].reasonCode === "MEDIA_MALWARE_INFECTED");
  // Provider registry rules: format-specific limits exist per provider/version and unlisted formats fail closed.
  const tiktokVideo = providerCreativeRules({ provider: "TIKTOK", apiVersion: "v1.3", format: "VIDEO_REFERENCE" });
  assert.equal(tiktokVideo.minDurationSeconds, 5);
  assert.equal(tiktokVideo.maxDurationSeconds, 60);
  assert.equal(providerCreativeRules({ provider: "X", apiVersion: "12", format: "VIDEO" }).maxDurationSeconds, 140);
  assert.throws(() => providerCreativeRules({ provider: "META", apiVersion: "v25.0", format: "CAROUSEL" }), (error) => error.errors[0].reasonCode === "CREATIVE_RULES_UNAVAILABLE");
  assert.throws(() => providerCreativeRules({ provider: "META", apiVersion: "", format: "IMAGE" }), (error) => error.errors[0].reasonCode === "PROVIDER_API_VERSION_REQUIRED");
  assert.deepEqual(supportedCreativeFormats("LINKEDIN"), ["SINGLE_IMAGE", "VIDEO"]);
});

test("29-CREATIVE copy limits are Unicode-aware with emoji and combining characters", () => {
  // Emoji count as code points, never UTF-16 code units: a ZWJ profession
  // emoji is 4 code points but 5 UTF-16 units.
  assert.equal(unicodeLength("👩‍⚕️"), 4);
  assert.equal("👩‍⚕️".length, 5);
  assert.ok(unicodeLength("🩺".repeat(10)) === 10, "surrogate pairs count once per emoji");
  const limits = { textLengths: { headline: 10 } };
  // 10 emoji are exactly at the limit even though they are 20 UTF-16 units.
  const boundary = publicationInput({ copy: { ...publicationInput().copy, headline: "🩺".repeat(10) } });
  assert.equal(validateCreativePublication(boundary, { formatLimits: limits, destinationPolicy: { allowedDomains: ["health.example.com"] } }).copy.headline, "🩺".repeat(10));
  const over = publicationInput({ copy: { ...publicationInput().copy, headline: "🩺".repeat(11) } });
  assert.throws(() => validateCreativePublication(over, { formatLimits: limits, destinationPolicy: { allowedDomains: ["health.example.com"] } }), (error) => error.errors[0].reasonCode === "CREATIVE_TEXT_LIMIT_EXCEEDED");
  // Combining characters normalize before counting.
  assert.equal(unicodeLength("é"), 1, "NFC normalization folds combining accents");
});

test("29-CREATIVE hash covers material content and ignores review state, request ids and timestamps", () => {
  const base = {
    platform: "META", connectionId: "11111111-1111-4111-8111-111111111111", accountExternalId: "act_123",
    providerFormat: "IMAGE",
    copy: { headline: "Care that listens", body: "Book today" },
    destinationUrl: "https://health.example.com/care?utm_source=meta&utm_campaign=summer&irrelevant=1",
    media: { checksum: "a".repeat(64) }, thumbnailChecksum: null, renderedProviderReference: null,
    pageReference: "page-1", instagramIdentityReference: null,
    accessibility: { altText: "Clinician", language: "en" },
    materialTrackingKeys: [],
  };
  const baseline = hashCreative(base).contentHash;
  assert.match(baseline, /^[a-f0-9]{64}$/);
  // Material changes alter the hash.
  const materialChanges = {
    copy: { copy: { headline: "Different headline", body: "Book today" } },
    url: { destinationUrl: "https://health.example.com/other?utm_source=meta&utm_campaign=summer" },
    utm: { destinationUrl: "https://health.example.com/care?utm_source=meta&utm_campaign=winter" },
    mediaChecksum: { media: { checksum: "b".repeat(64) } },
    format: { providerFormat: "VIDEO" },
    identity: { pageReference: "page-2" },
    accessibility: { accessibility: { altText: "Someone else", language: "en" } },
  };
  for (const [dimension, change] of Object.entries(materialChanges)) {
    assert.notEqual(hashCreative({ ...base, ...change }).contentHash, baseline, `${dimension} must change the creative hash`);
  }
  // Non-material metadata (review state, request ids, timestamps, attempt numbers) never enters the projection.
  const decorated = { ...base, reviewStatus: "REJECTED", providerRequestId: "req-99", updatedAt: "2026-07-23T10:00:00.000Z", attemptNumber: 7, auditMetadata: { by: "x" } };
  assert.equal(hashCreative(decorated).contentHash, baseline);
  // The tracking projection is sorted and allowlisted to utm_*/material keys;
  // the raw destination URL itself remains fully material.
  const { projection } = hashCreative(base);
  assert.deepEqual(projection.destination.tracking, { utm_campaign: "summer", utm_source: "meta" });
});

test("29-CREATIVE review rejection is durable, blocks activation and demands a new human revision", async () => {
  assert.deepEqual([...BLOCKING_REVIEW_STATES].sort(), ["DRAFT", "FAILED", "LIMITED", "PENDING_REVIEW", "REJECTED", "UNKNOWN"].sort());
  // REJECTED can never activate; LIMITED is blocked by default policy.
  assert.throws(() => assertCreativeApprovedForActivation({ reviewStatus: "REJECTED" }), (error) => error.errors[0].reasonCode === "CREATIVE_REVIEW_NOT_APPROVED");
  assert.throws(() => assertCreativeApprovedForActivation({ reviewStatus: "LIMITED" }), (error) => error.errors[0].reasonCode === "CREATIVE_REVIEW_NOT_APPROVED");
  assert.equal(assertCreativeApprovedForActivation({ reviewStatus: "LIMITED" }, { limitedPolicy: "ALLOW" }).reviewStatus, "LIMITED");

  // Review sync is append-only: it records provider state and audits transitions,
  // it never modifies or resubmits the rejected revision.
  const recorded = [];
  const audits = [];
  const events = [];
  const publication = { id: "publication-1", platform: "META", apiVersion: "v25.0", reviewStatus: "PENDING_REVIEW", providerMediaId: null, providerCreativeId: null, providerAdId: null };
  const service = createProviderReviewSyncService({
    repository: {
      findById: async () => publication,
      recordReviewState: async (entry) => { recorded.push(entry); return { ...publication, reviewStatus: entry.reviewStatus }; },
    },
    providerReadRegistry: { resolve: () => ({ readCreativeReview: async () => ({ status: "rejected", code: "POLICY_TEXT", message: "Too much text", providerVersion: "v25.0" }) }) },
    audit: { event: async (entry) => audits.push(entry) },
    events: { emit: async (name, payload) => events.push({ name, payload }) },
  });
  const synced = await service.sync("publication-1");
  assert.equal(synced.reviewStatus, "REJECTED");
  assert.equal(recorded.length, 1, "sync records exactly one append-only review row");
  assert.equal(audits[0].action, "MARKETING_CREATIVE_REVIEW_CHANGED");
  assert.equal(events[0].name, "CREATIVE_REVIEW_CHANGED");
  // A hash change is required for any material change: the rejected revision's
  // hash cannot be reused for altered copy.
  const rejectedContent = { platform: "META", connectionId: "11111111-1111-4111-8111-111111111111", accountExternalId: "act_123", providerFormat: "IMAGE", copy: { headline: "Rejected copy" }, destinationUrl: "https://health.example.com/care", media: { checksum: "a".repeat(64) }, identityReference: "page-1", pageReference: "page-1", accessibility: {} };
  const humanRevision = { ...rejectedContent, copy: { headline: "Human-rewritten copy" } };
  assert.notEqual(hashCreative(rejectedContent).contentHash, hashCreative(humanRevision).contentHash);
  // Review synchronization failure becomes UNKNOWN (never silently APPROVED).
  const failing = createProviderReviewSyncService({
    repository: { findById: async () => publication, recordReviewState: async (entry) => ({ ...publication, reviewStatus: entry.reviewStatus }) },
    providerReadRegistry: { resolve: () => ({ readCreativeReview: async () => { throw new Error("provider unavailable"); } }) },
  });
  assert.equal((await failing.sync("publication-1")).reviewStatus, "UNKNOWN");
});

test("29-CREATIVE deterministic media checksum deduplicates identical content and diverges on any byte change", async () => {
  const original = await validateMedia({ bytes: png(800, 800), mimeType: "image/png" }, { limits: IMAGE_LIMITS, malwareScanner: cleanScanner });
  const identical = await validateMedia({ bytes: png(800, 800), mimeType: "image/png" }, { limits: IMAGE_LIMITS, malwareScanner: cleanScanner, checksumLookup: async (checksum) => checksum === original.checksum ? { id: "media-1" } : null });
  assert.equal(identical.checksum, original.checksum);
  assert.equal(identical.duplicateMediaId, "media-1", "exact duplicates resolve to the existing media");
  const changed = png(800, 800);
  changed[40] = 0xff;
  const different = crypto.createHash("sha256").update(changed).digest("hex");
  assert.notEqual(different, original.checksum);
});
