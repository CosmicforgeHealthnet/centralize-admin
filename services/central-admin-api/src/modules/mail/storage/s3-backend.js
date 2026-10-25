"use strict";

// S3-compatible private object storage backend for CosmicForge Mail
// (AWS S3, Cloudflare R2, MinIO, Contabo Object Storage, ...).
//
// - Objects are already AES-256-GCM encrypted by the Mail keyring before they
//   reach this backend; optional server-side encryption (SSE-S3 / SSE-KMS) is
//   layered on top.
// - Objects are written private (no public ACL) and are never exposed through
//   public or presigned URLs: downloads are streamed through the authorized
//   Mail API only.
// - Each object carries the SHA-256 of the stored envelope in object metadata
//   and the request checksum header; reads are verified against it.
// - Requests time out and retry a bounded number of times on 5xx / network
//   errors only. Any other failure fails closed.

const crypto = require("crypto");
const { signRequest } = require("../security/aws-sigv4");

const METADATA_SHA = "x-amz-meta-cf-envelope-sha256";

class S3RequestError extends Error {
  constructor(message, { status = 0, retryable = false, code = "S3_REQUEST_FAILED" } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

function errors() {
  // Lazy require avoids a circular import with mail-storage.js.
  return require("./mail-storage");
}

function normalizeS3Config(s3 = {}) {
  const endpoint = String(s3.endpoint || "").replace(/\/+$/, "");
  return {
    endpoint,
    region: s3.region || "us-east-1",
    bucket: s3.bucket || "",
    prefix: String(s3.prefix || "").replace(/^\/+|\/+$/g, ""),
    forcePathStyle: s3.forcePathStyle !== false,
    accessKeyId: s3.accessKeyId || "",
    secretAccessKey: s3.secretAccessKey || "",
    sessionToken: s3.sessionToken || "",
    sse: String(s3.sse || "").toUpperCase(), // "", "AES256", "AWS:KMS"
    sseKmsKeyId: s3.sseKmsKeyId || "",
    sendPrivateAcl: s3.sendPrivateAcl !== false,
    conditionalWrites: s3.conditionalWrites !== false,
    checksumHeader: s3.checksumHeader !== false,
    healthCacheMs: Number.isInteger(s3.healthCacheMs) ? s3.healthCacheMs : 60000,
    timeoutMs: s3.timeoutMs || 10000,
    maxRetries: Number.isInteger(s3.maxRetries) ? s3.maxRetries : 2,
  };
}

function s3Configured(s3) {
  const cfg = normalizeS3Config(s3);
  return Boolean(cfg.endpoint && cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey);
}

function s3Backend(options = {}, { fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = () => new Date(), logger } = {}) {
  const cfg = normalizeS3Config(options);
  if (!s3Configured(cfg)) throw new Error("S3 storage is not fully configured");
  const credentials = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, sessionToken: cfg.sessionToken || undefined };

  function objectUrl(key = "") {
    const fullKey = [cfg.prefix, key].filter(Boolean).join("/");
    const base = new URL(cfg.endpoint);
    if (cfg.forcePathStyle) return `${base.origin}/${cfg.bucket}${fullKey ? `/${fullKey}` : ""}`;
    return `${base.protocol}//${cfg.bucket}.${base.host}${fullKey ? `/${fullKey}` : "/"}`;
  }

  async function send(method, url, { body, headers = {} } = {}) {
    let attempt = 0;
    for (;;) {
      const signed = signRequest({ method, url, headers, body, region: cfg.region, service: "s3", credentials, now: clock() });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, { method, headers: signed.headers, body: body && body.length ? body : undefined, signal: controller.signal, redirect: "error" });
      } catch (error) {
        clearTimeout(timer);
        const failure = new S3RequestError(error.name === "AbortError" ? "S3 request timed out" : "S3 network error", { retryable: true, code: error.name === "AbortError" ? "S3_TIMEOUT" : "S3_NETWORK" });
        if (attempt < cfg.maxRetries) {
          attempt += 1;
          await sleep(100 * 2 ** attempt);
          continue;
        }
        throw failure;
      }
      clearTimeout(timer);
      if (response.status >= 500 && attempt < cfg.maxRetries) {
        await response.arrayBuffer().catch(() => null);
        attempt += 1;
        await sleep(100 * 2 ** attempt);
        continue;
      }
      return response;
    }
  }

  async function failOnError(response, operation) {
    if (response.ok) return;
    await response.arrayBuffer().catch(() => null);
    logger?.warn?.(`[MailStorage] s3 ${operation} failed status=${response.status}`);
    throw new S3RequestError(`S3 ${operation} failed`, { status: response.status, retryable: response.status >= 500 });
  }

  async function putObject(key, data, { overwrite }) {
    const body = Buffer.from(data);
    const sha = crypto.createHash("sha256").update(body).digest();
    const headers = {
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
      [METADATA_SHA]: sha.toString("hex"),
    };
    if (cfg.checksumHeader) headers["x-amz-checksum-sha256"] = sha.toString("base64");
    // Objects are immutable: normal writes refuse to overwrite an existing key.
    if (cfg.conditionalWrites && !overwrite) headers["if-none-match"] = "*";
    if (cfg.sendPrivateAcl) headers["x-amz-acl"] = "private";
    if (cfg.sse === "AES256") headers["x-amz-server-side-encryption"] = "AES256";
    if (cfg.sse === "AWS:KMS") {
      headers["x-amz-server-side-encryption"] = "aws:kms";
      if (cfg.sseKmsKeyId) headers["x-amz-server-side-encryption-aws-kms-key-id"] = cfg.sseKmsKeyId;
    }
    let response;
    try {
      response = await send("PUT", objectUrl(key), { body, headers });
    } catch {
      throw new (errors().MailStorageUnavailableError)();
    }
    await response.arrayBuffer().catch(() => null);
    if (!response.ok) throw new (errors().MailStorageUnavailableError)(`Private mail storage write failed (${response.status})`);
  }

  async function getObject(key) {
    let response;
    try {
      response = await send("GET", objectUrl(key));
    } catch {
      throw new (errors().MailStorageUnavailableError)();
    }
    if (!response.ok) {
      await response.arrayBuffer().catch(() => null);
      if (response.status === 404) throw new (errors().MailStorageIntegrityError)();
      throw new (errors().MailStorageUnavailableError)();
    }
    const body = Buffer.from(await response.arrayBuffer());
    const expected = response.headers.get(METADATA_SHA);
    if (!expected || crypto.createHash("sha256").update(body).digest("hex") !== expected) throw new (errors().MailStorageIntegrityError)();
    return body;
  }

  async function deleteObject(key) {
    let response;
    try {
      response = await send("DELETE", objectUrl(key));
    } catch {
      throw new (errors().MailStorageUnavailableError)();
    }
    await response.arrayBuffer().catch(() => null);
    if (!response.ok && response.status !== 404) throw new (errors().MailStorageUnavailableError)();
  }

  // HEAD bucket, then a put/get/delete canary under a dedicated prefix.
  async function probe() {
    try {
      const head = await send("HEAD", objectUrl());
      await failOnError(head, "head-bucket");
      const canaryKey = `health/${crypto.randomUUID().replace(/-/g, "")}`;
      const payload = Buffer.from(`cfmail-health:${canaryKey}`);
      await putObject(canaryKey, payload, { overwrite: false });
      const echoed = await getObject(canaryKey);
      await deleteObject(canaryKey);
      if (!echoed.equals(payload)) return { ok: false, detail: "canary-mismatch" };
      return { ok: true, detail: "s3-canary-ok" };
    } catch (error) {
      return { ok: false, detail: error.code === "MAIL_STORAGE_INTEGRITY" ? "integrity-failed" : error.status ? `status-${error.status}` : "unreachable" };
    }
  }

  let healthCache = null;
  const api = {
    name: "s3",
    write: (key, data) => putObject(key, data, { overwrite: false }),
    // Used only by key rotation to rewrite an object under the active key.
    replace: (key, data) => putObject(key, data, { overwrite: true }),
    read: getObject,
    remove: deleteObject,
    // Cached briefly so frequent health polling does not hammer the bucket.
    async health() {
      if (healthCache && clock().getTime() - healthCache.at < cfg.healthCacheMs) return healthCache.result;
      const result = await probe();
      healthCache = { at: clock().getTime(), result };
      return result;
    },
    describe() {
      return { endpoint: new URL(cfg.endpoint).host, bucket: cfg.bucket, prefix: cfg.prefix, sse: cfg.sse || "none" };
    },
  };

  return api;
}

module.exports = { s3Backend, s3Configured, normalizeS3Config, S3RequestError, METADATA_SHA };
