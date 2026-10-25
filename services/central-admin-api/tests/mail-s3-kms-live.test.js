"use strict";

// Opt-in test against a REAL S3-compatible endpoint and a REAL KMS-compatible
// endpoint (AWS, or an S3/KMS emulator such as moto_server for a local check).
// Skipped unless MAIL_S3_LIVE_ENDPOINT is set. Never part of the default CI path.
//
//   MAIL_S3_LIVE_ENDPOINT=http://127.0.0.1:5005 \
//   MAIL_S3_LIVE_BUCKET=cfmail-live-test \
//   MAIL_S3_LIVE_CREATE_BUCKET=true          # emulator only: create the bucket
//   MAIL_KMS_LIVE_ENDPOINT=http://127.0.0.1:5005 \
//   MAIL_KMS_LIVE_KEY_ID=<key id>            # optional; the emulator path creates one
//   MAIL_S3_LIVE_ACCESS_KEY_ID=... MAIL_S3_LIVE_SECRET_ACCESS_KEY=... \
//   npm run test:mail:s3-kms-live
//
// What it proves against the real endpoints: KMS data key generation and
// unwrap bound to the encryption context, a wrong context is refused,
// AES-256-GCM envelopes stored privately with SSE, raw stored bytes never
// contain the plaintext, read-back integrity, tampering detected, no
// anonymous read, deletion, and fail-closed behaviour without a keyring or
// when storage is unreachable.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { s3Backend } = require("../src/modules/mail/storage/s3-backend");
const { createEncryptedStore } = require("../src/modules/mail/storage/mail-storage");
const { createMailEncryption } = require("../src/modules/mail/security/mail-encryption.service");
const { createAwsKmsClient, resolveMailKeyring, encryptionContext } = require("../src/modules/mail/security/kms-keyring");
const { signRequest } = require("../src/modules/mail/security/aws-sigv4");

const endpoint = process.env.MAIL_S3_LIVE_ENDPOINT;
const kmsEndpoint = process.env.MAIL_KMS_LIVE_ENDPOINT || "";
const region = process.env.MAIL_S3_LIVE_REGION || "us-east-1";
const bucket = process.env.MAIL_S3_LIVE_BUCKET || "cfmail-live-test";
const credentials = {
  accessKeyId: process.env.MAIL_S3_LIVE_ACCESS_KEY_ID || "",
  secretAccessKey: process.env.MAIL_S3_LIVE_SECRET_ACCESS_KEY || "",
  sessionToken: process.env.MAIL_S3_LIVE_SESSION_TOKEN || undefined,
};

function registerEndpoint(url) {
  if (!url) return;
  const parsed = new URL(url);
  if (["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    require("./helpers/network-guard").registerLocalPort(Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)));
  }
}

async function kmsCall(target, payload) {
  const url = `${kmsEndpoint.replace(/\/+$/, "")}/`;
  const body = Buffer.from(JSON.stringify(payload));
  const { headers } = signRequest({ method: "POST", url, headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `TrentService.${target}` }, body, region, service: "kms", credentials });
  const response = await fetch(url, { method: "POST", headers, body });
  const text = await response.text();
  assert.ok(response.ok, `KMS ${target} failed: ${response.status}`);
  return JSON.parse(text || "{}");
}

test("real S3 + KMS: encrypted private storage, integrity and fail-closed", { skip: endpoint ? false : "MAIL_S3_LIVE_ENDPOINT not set", timeout: 120000 }, async () => {
  registerEndpoint(endpoint);
  registerEndpoint(kmsEndpoint);
  assert.ok(credentials.accessKeyId && credentials.secretAccessKey, "MAIL_S3_LIVE_ACCESS_KEY_ID / MAIL_S3_LIVE_SECRET_ACCESS_KEY are required");

  if (process.env.MAIL_S3_LIVE_CREATE_BUCKET === "true") {
    const url = `${endpoint.replace(/\/+$/, "")}/${bucket}`;
    const { headers } = signRequest({ method: "PUT", url, region, service: "s3", credentials });
    const response = await fetch(url, { method: "PUT", headers });
    await response.arrayBuffer();
    assert.ok(response.ok || response.status === 409, `create bucket failed: ${response.status}`);
  }

  // 1. KMS: wrapped data key, unwrapped only with the matching context.
  let keyId = process.env.MAIL_KMS_LIVE_KEY_ID || "";
  if (!keyId) {
    assert.ok(kmsEndpoint, "MAIL_KMS_LIVE_ENDPOINT or MAIL_KMS_LIVE_KEY_ID is required");
    keyId = (await kmsCall("CreateKey", { Description: "cfmail live test", KeyUsage: "ENCRYPT_DECRYPT" })).KeyMetadata.KeyId;
  }
  const kms = createAwsKmsClient({ region, endpoint: kmsEndpoint || undefined, credentials, keyId });
  const environment = "staging-live-test";
  const generated = await kms.generateDataKey(encryptionContext({ environment, version: "v9" }));
  assert.equal(generated.plaintext.length, 32);
  const wrappedEntry = `v9:kms:${generated.ciphertext.toString("base64")}`;
  const keyring = await resolveMailKeyring({ provider: "aws-kms", keys: wrappedEntry, activeKey: "v9", environment, kmsClient: kms });
  assert.equal(keyring.active, "v9");
  assert.ok(keyring.keys.get("v9").equals(generated.plaintext), "unwrapped data key matches");
  await assert.rejects(
    () => resolveMailKeyring({ provider: "aws-kms", keys: wrappedEntry, activeKey: "v9", environment: "another-environment", kmsClient: kms }),
    "a data key wrapped for one environment must not unwrap under another context",
  );
  await assert.rejects(() => resolveMailKeyring({ provider: "aws-kms", keys: `v1:${crypto.randomBytes(32).toString("base64")}`, environment, kmsClient: kms }), /not KMS-wrapped/);

  // 2. Encrypted private object storage with SSE.
  const backend = s3Backend({ endpoint, region, bucket, prefix: `live-test/${crypto.randomUUID()}`, accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken, sse: process.env.MAIL_S3_LIVE_SSE || "AWS:KMS", sseKmsKeyId: keyId, healthCacheMs: 0 });
  const health = await backend.health();
  assert.deepEqual(health, { ok: true, detail: "s3-canary-ok" });
  const encryption = createMailEncryption({ keyring });
  const store = createEncryptedStore({ encryption, backend });
  const secret = `private mail body ${crypto.randomUUID()}`;
  const stored = await store.put("body", secret, { purpose: "message-body" });
  const raw = await backend.read(stored.key);
  assert.equal(raw.includes(Buffer.from(secret)), false, "raw stored object must be ciphertext");
  assert.equal((await store.get(stored.key, { purpose: "message-body", sha256: stored.sha256 })).toString("utf8"), secret);

  // Wrong purpose (AAD) and a wrong checksum are integrity failures.
  await assert.rejects(() => store.get(stored.key, { purpose: "attachment" }), { code: "MAIL_STORAGE_INTEGRITY" });
  await assert.rejects(() => store.get(stored.key, { purpose: "message-body", sha256: "0".repeat(64) }), { code: "MAIL_STORAGE_INTEGRITY" });

  // Objects are immutable: a normal write cannot overwrite an existing key.
  await assert.rejects(() => backend.write(stored.key, Buffer.from("overwrite")));

  // Tampering with the stored bytes (via the explicit replace path) is detected.
  const tampered = Buffer.from(raw);
  tampered[tampered.length - 1] ^= 0xff;
  await backend.replace(stored.key, tampered);
  await assert.rejects(() => store.get(stored.key, { purpose: "message-body" }), { code: "MAIL_STORAGE_INTEGRITY" });

  // No anonymous read of a private object.
  const prefixUrl = `${endpoint.replace(/\/+$/, "")}/${bucket}/${backend.describe().prefix}/${stored.key}`;
  const anonymous = await fetch(prefixUrl);
  await anonymous.arrayBuffer();
  if (process.env.MAIL_S3_LIVE_EXPECT_ANON_DENIED !== "false") assert.ok([401, 403].includes(anonymous.status), `anonymous GET must be denied, got ${anonymous.status}`);

  // Deletion, then reads fail as missing content.
  await store.remove(stored.key);
  await assert.rejects(() => store.get(stored.key, { purpose: "message-body" }), { code: "MAIL_STORAGE_INTEGRITY" });

  // 3. Fail closed: no keyring, and unreachable storage.
  const noKeys = createEncryptedStore({ encryption: createMailEncryption({ deferred: true }), backend });
  await assert.rejects(() => noKeys.put("body", "x", { purpose: "message-body" }), { code: "MAIL_STORAGE_UNAVAILABLE" });
  const dead = s3Backend({ endpoint: "http://127.0.0.1:1", region, bucket, accessKeyId: "a", secretAccessKey: "b", maxRetries: 0, timeoutMs: 2000, healthCacheMs: 0 });
  require("./helpers/network-guard").registerLocalPort(1);
  assert.equal((await dead.health()).ok, false);
  await assert.rejects(() => createEncryptedStore({ encryption, backend: dead }).put("body", "x", { purpose: "message-body" }), { code: "MAIL_STORAGE_UNAVAILABLE" });
});
