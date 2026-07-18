const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const {
  createMediaStorageAdapter,
} = require("../src/modules/marketing/social-operations/media/storage/media-storage.factory");
const {
  resolveMediaStorageConfig,
} = require("../src/modules/marketing/social-operations/media/storage/media-storage.config");
const {
  LocalMediaStorageAdapter,
} = require("../src/modules/marketing/social-operations/media/storage/local-media-storage.adapter");
const {
  CloudinaryMediaStorageAdapter,
} = require("../src/modules/marketing/social-operations/media/storage/cloudinary-media-storage.adapter");
const {
  MediaStorageConfigurationError,
  MediaStoragePermanentError,
  MediaStorageTransientError,
  MediaStorageValidationError,
} = require("../src/modules/marketing/social-operations/media/storage/media-storage.errors");
const socialApi = require("../src/modules/marketing/social-operations/services/social-api.service");

const tempDirs = [];
const pngBuffer = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const mp4Buffer = Buffer.from("0000ftypisom0000");

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-media-test-"));
  tempDirs.push(dir);
  return dir;
}

function storageConfig(overrides = {}) {
  return resolveMediaStorageConfig({
    mode: "test",
    overrides: {
      provider: "local",
      localStorageDir: tempDir(),
      ...overrides,
    },
  });
}

test("storage factory selects safe adapters and rejects unsafe modes", () => {
  assert.equal(
    createMediaStorageAdapter({
      mode: "test",
      overrides: { localStorageDir: tempDir() },
    }).constructor.name,
    "LocalMediaStorageAdapter",
  );
  assert.equal(
    createMediaStorageAdapter({
      mode: "development",
      overrides: { localStorageDir: tempDir() },
    }).constructor.name,
    "LocalMediaStorageAdapter",
  );
  assert.throws(
    () => createMediaStorageAdapter({ mode: "staging", overrides: { provider: "local" } }),
    MediaStorageConfigurationError,
  );
  assert.throws(
    () => createMediaStorageAdapter({ mode: "production", overrides: { provider: "local" } }),
    MediaStorageConfigurationError,
  );
  assert.equal(
    createMediaStorageAdapter({
      mode: "staging",
      overrides: {
        provider: "cloudinary",
        cloudinaryCloudName: "cloud",
        cloudinaryApiKey: "key",
        cloudinaryApiSecret: "secret",
      },
      cloudinarySdk: { config() {}, uploader: {} },
    }).constructor.name,
    "CloudinaryMediaStorageAdapter",
  );
  assert.throws(
    () => createMediaStorageAdapter({ mode: "test", overrides: { provider: "unknown" } }),
    MediaStorageConfigurationError,
  );
});

test("local adapter uploads, preserves checksum, blocks traversal, and deletes idempotently", async () => {
  const adapter = new LocalMediaStorageAdapter({
    config: storageConfig({ imageMaxBytes: 100 }),
    randomBytes: () => Buffer.from("0011223344556677", "hex"),
  });
  const checksumSha256 = crypto.createHash("sha256").update(pngBuffer).digest("hex");
  const result = await adapter.upload({
    ownerId: "admin-1",
    filename: "asset.png",
    mimeType: "image/png",
    buffer: pngBuffer,
    sizeBytes: pngBuffer.length,
    checksumSha256,
  });
  assert.equal(result.storageProvider, "LOCAL");
  assert.equal(result.checksumSha256, checksumSha256);
  assert.equal(result.secureUrl.startsWith("local://social-media/image/admin-1/"), true);
  assert.equal(path.isAbsolute(result.storageKey), false);
  assert.equal(result.storageKey.includes(".."), false);
  assert.deepEqual(await adapter.delete({ storageKey: result.storageKey }), {
    deleted: true,
    alreadyDeleted: false,
  });
  assert.deepEqual(await adapter.delete({ storageKey: result.storageKey }), {
    deleted: true,
    alreadyDeleted: true,
  });
  await assert.rejects(
    adapter.upload({
      ownerId: "admin-1",
      filename: "../asset.png",
      mimeType: "image/png",
      buffer: pngBuffer,
      sizeBytes: pngBuffer.length,
      checksumSha256,
    }),
    MediaStorageValidationError,
  );
  await assert.rejects(
    adapter.upload({
      ownerId: "admin-1",
      filename: "asset.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("x"),
      sizeBytes: 1,
      checksumSha256: crypto.createHash("sha256").update("x").digest("hex"),
    }),
    MediaStorageValidationError,
  );
  await assert.rejects(
    adapter.upload({
      ownerId: "admin-1",
      filename: "asset.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(101),
      sizeBytes: 101,
      checksumSha256: crypto.createHash("sha256").update(Buffer.alloc(101)).digest("hex"),
    }),
    MediaStorageValidationError,
  );
});

function cloudinaryMock({ secureUrl = "https://res.cloudinary.test/image/upload/v1/public-id.png", error, noCallback = false, deleteResult = "ok" } = {}) {
  const calls = [];
  return {
    calls,
    config(config) {
      calls.push({ op: "config", config });
    },
    uploader: {
      upload_stream(options, callback) {
        calls.push({ op: "upload", options });
        return {
          end(buffer) {
            calls.push({ op: "end", bytes: buffer.length });
            if (noCallback) return;
            if (error) callback(error);
            else {
              callback(null, {
                public_id: `${options.folder}/${options.public_id}`,
                secure_url: secureUrl,
                resource_type: options.resource_type,
                format: options.resource_type === "video" ? "mp4" : "png",
                bytes: buffer.length,
                width: 640,
                height: 480,
                duration: options.resource_type === "video" ? 3.5 : undefined,
                signature: "must-not-persist",
              });
            }
          },
        };
      },
      async destroy(publicId, options) {
        calls.push({ op: "destroy", publicId, options });
        return { result: deleteResult };
      },
      async explicit(publicId) {
        return { public_id: publicId, resource_type: "image", bytes: 12 };
      },
    },
  };
}

function cloudinaryAdapter(sdk, overrides = {}) {
  const config = resolveMediaStorageConfig({
    mode: "production",
    overrides: {
      provider: "cloudinary",
      cloudinaryCloudName: "cloud",
      cloudinaryApiKey: "key",
      cloudinaryApiSecret: "secret",
      ...overrides,
    },
  });
  config.uploadTimeoutMs = overrides.uploadTimeoutMs || 25;
  return new CloudinaryMediaStorageAdapter({
    cloudinarySdk: sdk,
    config,
  });
}

test("Cloudinary adapter uploads images and videos with controlled public IDs and safe metadata", async () => {
  const sdk = cloudinaryMock();
  const adapter = cloudinaryAdapter(sdk);
  const checksumSha256 = crypto.createHash("sha256").update(pngBuffer).digest("hex");
  const result = await adapter.upload({
    ownerId: "admin-1",
    filename: "upload.png",
    mimeType: "image/png",
    buffer: pngBuffer,
    sizeBytes: pngBuffer.length,
    checksumSha256,
    idempotencyKey: "idem-1",
  });
  assert.equal(result.storageProvider, "CLOUDINARY");
  assert.equal(result.storageKey.includes("cosmicforge/social-operations/production/admin-1/"), true);
  assert.equal(result.providerMetadata.signature, undefined);
  assert.equal(sdk.calls.find((call) => call.op === "upload").options.overwrite, true);

  const videoSdk = cloudinaryMock({ secureUrl: "https://res.cloudinary.test/video/upload/v1/video.mp4" });
  const video = await cloudinaryAdapter(videoSdk).upload({
    ownerId: "admin-1",
    filename: "video.mp4",
    mimeType: "video/mp4",
    buffer: mp4Buffer,
    sizeBytes: mp4Buffer.length,
    checksumSha256: crypto.createHash("sha256").update(mp4Buffer).digest("hex"),
  });
  assert.equal(video.resourceType, "video");
  assert.equal(video.durationSeconds, 3.5);
});

test("Cloudinary adapter classifies malformed, timeout, retryable and idempotent delete behavior", async () => {
  await assert.rejects(
    cloudinaryAdapter(cloudinaryMock({ secureUrl: "" })).upload({
      ownerId: "admin-1",
      filename: "upload.png",
      mimeType: "image/png",
      buffer: pngBuffer,
      sizeBytes: pngBuffer.length,
      checksumSha256: crypto.createHash("sha256").update(pngBuffer).digest("hex"),
    }),
    MediaStoragePermanentError,
  );
  await assert.rejects(
    cloudinaryAdapter(cloudinaryMock({ noCallback: true })).upload({
      ownerId: "admin-1",
      filename: "upload.png",
      mimeType: "image/png",
      buffer: pngBuffer,
      sizeBytes: pngBuffer.length,
      checksumSha256: crypto.createHash("sha256").update(pngBuffer).digest("hex"),
    }),
    MediaStorageTransientError,
  );
  await assert.rejects(
    cloudinaryAdapter(cloudinaryMock({ error: { http_code: 503, message: "temporary" } })).upload({
      ownerId: "admin-1",
      filename: "upload.png",
      mimeType: "image/png",
      buffer: pngBuffer,
      sizeBytes: pngBuffer.length,
      checksumSha256: crypto.createHash("sha256").update(pngBuffer).digest("hex"),
    }),
    MediaStorageTransientError,
  );
  const notFound = await cloudinaryAdapter(cloudinaryMock({ deleteResult: "not found" })).delete({
    storageKey: "public-id",
    resourceType: "image",
  });
  assert.equal(notFound.alreadyDeleted, true);
});

function fakeMediaDb({ adminExists = true, existing = null, createFails = false, locked = false } = {}) {
  const rows = [];
  return {
    rows,
    adminUser: {
      async findUnique() {
        return adminExists ? { id: "admin-1" } : null;
      },
    },
    socialMediaAsset: {
      async findUnique() {
        return existing;
      },
      async create({ data }) {
        if (createFails) throw new Error("db unavailable");
        const row = { id: "asset-1", createdAt: new Date(), updatedAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
      async update({ data }) {
        const row = { ...(existing || rows[0] || { id: "asset-1", ownerId: "admin-1" }), ...data };
        rows[0] = row;
        return row;
      },
    },
    socialPostMedia: {
      async findFirst() {
        return locked ? { id: "usage-1" } : null;
      },
    },
  };
}

test("media service uploads after owner validation, dedupes by checksum, and rolls back on DB failure", async () => {
  const audit = [];
  const deleted = [];
  const storageAdapter = {
    async upload(input) {
      return {
        storageProvider: "LOCAL",
        storageKey: "image/admin/checksum.png",
        secureUrl: "local://social-media/image/admin/checksum.png",
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        checksumSha256: input.checksumSha256,
        resourceType: "image",
        providerMetadata: { apiSecret: "must-not-return", width: 1 },
        complete: true,
      };
    },
    async delete(input) {
      deleted.push(input);
      return { deleted: true };
    },
  };
  const db = fakeMediaDb();
  const created = await socialApi.createMedia({
    body: {},
    file: { buffer: pngBuffer, originalname: "asset.png", mimetype: "image/png", size: pngBuffer.length },
    context: { adminUser: { id: "admin-1" } },
    db,
    storageAdapter,
    storageConfig: storageConfig(),
    auditWriter: async (entry) => audit.push(entry),
  });
  assert.equal(created.storageProvider, "LOCAL");
  assert.equal(JSON.stringify(created).includes("must-not-return"), false);
  assert.equal(audit.some((entry) => entry.operation === "SOCIAL_MEDIA_UPLOADED"), true);

  const existing = { ...db.rows[0], deletedAt: null, status: "READY" };
  const deduped = await socialApi.createMedia({
    body: {},
    file: { buffer: pngBuffer, originalname: "asset.png", mimetype: "image/png", size: pngBuffer.length },
    context: { adminUser: { id: "admin-1" } },
    db: fakeMediaDb({ existing }),
    storageAdapter,
    storageConfig: storageConfig(),
    auditWriter: async (entry) => audit.push(entry),
  });
  assert.equal(deduped.id, existing.id);

  await assert.rejects(
    socialApi.createMedia({
      body: {},
      file: { buffer: pngBuffer, originalname: "asset.png", mimetype: "image/png", size: pngBuffer.length },
      context: { adminUser: { id: "admin-1" } },
      db: fakeMediaDb({ createFails: true }),
      storageAdapter,
      storageConfig: storageConfig(),
      auditWriter: async (entry) => audit.push(entry),
    }),
    /db unavailable/,
  );
  assert.equal(deleted.length, 1);
});

test("media service rejects bad owner, oversized MIME, unsafe remote URL, and locked deletion", async () => {
  await assert.rejects(
    socialApi.createMedia({
      body: {},
      file: { buffer: pngBuffer, originalname: "asset.png", mimetype: "image/png", size: pngBuffer.length },
      context: { adminUser: { id: "admin-1" } },
      db: fakeMediaDb({ adminExists: false }),
      storageConfig: storageConfig(),
    }),
    /owner/,
  );
  await assert.rejects(
    socialApi.createMedia({
      body: {},
      file: { buffer: Buffer.from("x"), originalname: "asset.exe", mimetype: "application/octet-stream", size: 1 },
      context: { adminUser: { id: "admin-1" } },
      db: fakeMediaDb(),
      storageConfig: storageConfig(),
    }),
    /MIME/,
  );
  await assert.rejects(
    socialApi.createMedia({
      body: { url: "https://metadata.example.test/file.png" },
      context: { adminUser: { id: "admin-1" } },
      db: fakeMediaDb(),
      storageConfig: storageConfig(),
      remoteMediaFetcher: async () => ({ status: 200, headers: { "content-type": "image/png" }, body: pngBuffer }),
      remoteMediaResolver: async () => [{ address: "127.0.0.1", family: 4 }],
    }),
    /not allowed/,
  );
  await assert.rejects(
    socialApi.deleteMedia({
      id: "asset-1",
      context: { adminUser: { id: "admin-1" } },
      db: fakeMediaDb({
        locked: true,
        existing: {
          id: "asset-1",
          ownerId: "admin-1",
          storageProvider: "LOCAL",
          storageKey: "image/admin/checksum.png",
          mimeType: "image/png",
          status: "READY",
        },
      }),
      storageAdapter: { async delete() {} },
    }),
    /locked/,
  );
});
