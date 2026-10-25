"use strict";

// Workstreams C + D: private S3 storage, KMS-wrapped keyring, environment
// separation and the clamd adapter, all against local fakes (no network).

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { signRequest } = require("../src/modules/mail/security/aws-sigv4");
const { s3Backend } = require("../src/modules/mail/storage/s3-backend");
const { createEncryptedStore, MailStorageIntegrityError } = require("../src/modules/mail/storage/mail-storage");
const { createMailEncryption } = require("../src/modules/mail/security/mail-encryption.service");
const { resolveMailKeyring, createAwsKmsClient, encryptionContext } = require("../src/modules/mail/security/kms-keyring");
const { loadMailConfig, infrastructureViolations } = require("../src/modules/mail/mail.config");
const { createMailApplication } = require("../src/modules/mail/application");
const { clamdScanner, evaluateAttachment, parseClamdReply, EICAR } = require("../src/modules/mail/scanning/attachment-scanner");
const { startFakeS3, startFakeKms, startFakeClamd, closedPort } = require("./helpers/mail-infra-fakes");

const key32 = () => crypto.randomBytes(32).toString("base64");
const silentLogger = () => {
  const lines = [];
  const log = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, info: log("info"), warn: log("warn"), error: log("error"), debug: () => {} };
};

test("SigV4 signer matches the published AWS S3 GET example", () => {
  const { headers, signature } = signRequest({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    headers: { range: "bytes=0-9" },
    region: "us-east-1",
    service: "s3",
    credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    now: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.match(headers.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
  // AWS SigV4 test suite "get-vanilla" (non-S3 services such as KMS).
  assert.equal(signRequest({ method: "GET", url: "https://example.amazonaws.com/", region: "us-east-1", service: "service", credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" }, now: new Date("2015-08-30T12:36:00Z") }).signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.throws(() => signRequest({ method: "GET", url: "https://x.example/", region: "r", service: "s3", credentials: {} }), /not configured/);
});

test("S3 backend: private, signed, checksummed, immutable writes and verified reads", async (t) => {
  const s3 = await startFakeS3();
  t.after(() => s3.close());
  const backend = s3Backend(s3.config({ sse: "AWS:KMS", sseKmsKeyId: "alias/cf-mail-test" }));
  const payload = crypto.randomBytes(300 * 1024);
  await backend.write("attachment/ab/abcdef0123456789", payload);
  const put = s3.requests.find((request) => request.method === "PUT");
  assert.equal(put.signature.ok, true, "request is SigV4-signed and verifiable");
  assert.equal(put.headers["x-amz-acl"], "private");
  assert.equal(put.headers["if-none-match"], "*");
  assert.equal(put.headers["x-amz-server-side-encryption"], "aws:kms");
  assert.equal(put.headers["x-amz-server-side-encryption-aws-kms-key-id"], "alias/cf-mail-test");
  assert.equal(put.headers["x-amz-checksum-sha256"], crypto.createHash("sha256").update(payload).digest("base64"));
  assert.ok(!Object.keys(put.headers).some((name) => /presign|x-amz-expires/i.test(name)));
  assert.ok((await backend.read("attachment/ab/abcdef0123456789")).equals(payload));
  await assert.rejects(backend.write("attachment/ab/abcdef0123456789", payload), (error) => error.code === "MAIL_STORAGE_UNAVAILABLE", "existing objects are never overwritten by write()");

  // Tampering with the stored object is detected on read.
  s3.objects.set("attachment/ab/abcdef0123456789", Buffer.concat([payload.subarray(1), Buffer.from("x")]));
  await assert.rejects(backend.read("attachment/ab/abcdef0123456789"), MailStorageIntegrityError);
  await assert.rejects(backend.read("attachment/ab/missing00000000"), MailStorageIntegrityError);

  // Bounded retries on 5xx, then success; exhausted retries fail closed.
  s3.fault({ status: 503 });
  s3.fault({ status: 500 });
  await backend.write("body/cd/0123456789abcdef", Buffer.from("ok"));
  for (let i = 0; i < 3; i += 1) s3.fault({ status: 503 });
  await assert.rejects(backend.write("body/cd/0123456789abcdee", Buffer.from("no")), (error) => error.code === "MAIL_STORAGE_UNAVAILABLE");
  // Timeouts are retried and then fail closed.
  for (let i = 0; i < 3; i += 1) s3.fault({ delayMs: 1500 });
  await assert.rejects(backend.read("body/cd/0123456789abcdef"), (error) => error.code === "MAIL_STORAGE_UNAVAILABLE");

  // Wrong credentials are rejected by the server and surface as unavailable.
  const forged = s3Backend(s3.config({ secretAccessKey: "wrong", maxRetries: 0 }));
  await assert.rejects(forged.read("body/cd/0123456789abcdef"), (error) => error.code === "MAIL_STORAGE_UNAVAILABLE");

  // Public ACLs are refused by the bucket; the backend never asks for one.
  assert.ok(s3.requests.filter((request) => request.method === "PUT").every((request) => !request.headers["x-amz-acl"] || request.headers["x-amz-acl"] === "private"));
});

test("S3 backend health: HEAD bucket plus put/get/delete canary, cached and fail-closed", async (t) => {
  const s3 = await startFakeS3();
  t.after(() => s3.close());
  const healthy = await s3Backend(s3.config()).health();
  assert.deepEqual(healthy, { ok: true, detail: "s3-canary-ok" });
  assert.equal(s3.objects.size, 0, "canary object is removed");
  const wrongBucket = await s3Backend(s3.config({ bucket: "cf-mail-other" })).health();
  assert.equal(wrongBucket.ok, false);
  const port = await closedPort();
  const unreachable = await s3Backend({ ...s3.config({ maxRetries: 0 }), endpoint: `http://127.0.0.1:${port}` }).health();
  assert.deepEqual(unreachable, { ok: false, detail: "unreachable" });
  assert.deepEqual(await s3Backend(s3.config({ healthCanary: false })).health(), { ok: true, detail: "s3-head-ok" });
  const cached = s3Backend(s3.config({ healthCacheMs: 60000 }));
  await cached.health();
  const before = s3.requests.length;
  await cached.health();
  assert.equal(s3.requests.length, before, "second probe within the cache window makes no requests");
});

test("encrypted store over S3 keeps only ciphertext in the bucket and rotates keys in place", async (t) => {
  const s3 = await startFakeS3();
  t.after(() => s3.close());
  const v1 = key32();
  const encryption = createMailEncryption({ keys: `v1:${v1}`, activeKey: "v1" });
  const store = createEncryptedStore({ encryption, backend: s3Backend(s3.config()) });
  const canary = `plaintext-canary-${crypto.randomUUID()}`;
  const stored = await store.put("body", Buffer.from(canary), { purpose: "mail-body" });
  for (const object of s3.objects.values()) assert.ok(!object.includes(Buffer.from(canary)), "bucket never sees plaintext");
  assert.equal((await store.get(stored.key, { purpose: "mail-body", sha256: stored.sha256 })).toString(), canary);
  await assert.rejects(store.get(stored.key, { purpose: "mail-attachment", sha256: stored.sha256 }), MailStorageIntegrityError, "purpose-bound AAD");

  // Rotation: add v2, make it active, re-encrypt the object in place.
  const rotated = createMailEncryption({ keys: `v1:${v1},v2:${key32()}`, activeKey: "v2" });
  const rotatedStore = createEncryptedStore({ encryption: rotated, backend: s3Backend(s3.config()) });
  assert.equal(await rotatedStore.keyVersionOf(stored.key), "v1");
  assert.deepEqual(await rotatedStore.reencrypt(stored.key, { purpose: "mail-body" }), { key: stored.key, changed: true, from: "v1", to: "v2" });
  assert.equal(await rotatedStore.keyVersionOf(stored.key), "v2");
  assert.equal((await rotatedStore.reencrypt(stored.key, { purpose: "mail-body" })).changed, false, "idempotent");
  assert.equal((await rotatedStore.get(stored.key, { purpose: "mail-body", sha256: stored.sha256 })).toString(), canary);
  // The old key alone can no longer read it.
  await assert.rejects(store.get(stored.key, { purpose: "mail-body" }), MailStorageIntegrityError);
});

test("KMS keyring: wrapped data keys unwrap with the environment-bound context only", async (t) => {
  const kms = await startFakeKms();
  t.after(() => kms.close());
  const client = createAwsKmsClient({ region: kms.region, endpoint: kms.endpoint, keyId: "alias/cf-mail-test", credentials: kms.credentials });
  const generated = await client.generateDataKey(encryptionContext({ environment: "staging", version: "v2" }));
  assert.equal(generated.plaintext.length, 32);
  const keys = `v2:kms:${generated.ciphertext.toString("base64")}`;

  const keyring = await resolveMailKeyring({ provider: "aws-kms", keys, activeKey: "v2", environment: "staging", kmsClient: client });
  assert.ok(keyring.keys.get("v2").equals(generated.plaintext));
  assert.equal(keyring.active, "v2");
  const decrypt = kms.requests.filter((request) => request.target === "Decrypt").at(-1);
  assert.deepEqual(decrypt.context, { purpose: "cosmicforge-mail-keyring", environment: "staging", keyVersion: "v2" });
  assert.equal(decrypt.signature.ok, true);

  // A staging-wrapped key cannot be unwrapped as production (or renamed).
  await assert.rejects(resolveMailKeyring({ provider: "aws-kms", keys, activeKey: "v2", environment: "production", kmsClient: client }), (error) => error.code === "MAIL_KMS_DENIED");
  await assert.rejects(resolveMailKeyring({ provider: "aws-kms", keys: keys.replace("v2:", "v3:"), activeKey: "v3", environment: "staging", kmsClient: client }), (error) => error.code === "MAIL_KMS_DENIED");
  // Raw keys are refused with aws-kms; wrapped keys are refused without it.
  await assert.rejects(resolveMailKeyring({ provider: "aws-kms", keys: `v1:${key32()}`, environment: "staging", kmsClient: client }), (error) => error.code === "MAIL_KMS_CONFIG");
  await assert.rejects(resolveMailKeyring({ provider: "env", keys, environment: "staging" }), (error) => error.code === "MAIL_KMS_CONFIG");
  await assert.rejects(resolveMailKeyring({ provider: "aws-kms", keys, activeKey: "v9", environment: "staging", kmsClient: client }), (error) => error.code === "MAIL_KMS_CONFIG");
  // Forged credentials are rejected.
  const forged = createAwsKmsClient({ region: kms.region, endpoint: kms.endpoint, keyId: "alias/cf-mail-test", credentials: { ...kms.credentials, secretAccessKey: "nope" } });
  await assert.rejects(resolveMailKeyring({ provider: "aws-kms", keys, environment: "staging", kmsClient: forged }), (error) => error.code === "MAIL_KMS_DENIED");
});

test("Mail application with aws-kms fails closed until the keyring unwraps, and never logs key material", async (t) => {
  const kms = await startFakeKms({ keyIds: ["alias/cf-mail-stg"] });
  const s3 = await startFakeS3({ bucket: "cf-mail-stg-private" });
  t.after(() => Promise.all([kms.close(), s3.close()]));
  const client = createAwsKmsClient({ region: kms.region, endpoint: kms.endpoint, keyId: "alias/cf-mail-stg", credentials: kms.credentials });
  const generated = await client.generateDataKey(encryptionContext({ environment: "staging", version: "v1" }));
  const env = {
    MAIL_ENABLED: "true",
    MAIL_DEPLOYMENT_ENV: "staging",
    MAIL_STORAGE_PROVIDER: "s3",
    MAIL_S3_ENDPOINT: s3.endpoint.replace("http://", "https://"),
    MAIL_S3_BUCKET: s3.bucket,
    MAIL_S3_ACCESS_KEY_ID: s3.credentials.accessKeyId,
    MAIL_S3_SECRET_ACCESS_KEY: s3.credentials.secretAccessKey,
    MAIL_KMS_PROVIDER: "aws-kms",
    MAIL_KMS_KEY_ID: "alias/cf-mail-stg",
    MAIL_ENCRYPTION_KEYS: `v1:kms:${generated.ciphertext.toString("base64")}`,
    MAIL_ENCRYPTION_ACTIVE_KEY: "v1",
  };
  const config = loadMailConfig(env);
  assert.deepEqual(infrastructureViolations(config), []);
  const logger = silentLogger();
  // The staging rules require https; the fake listens on http, so inject the
  // backend the config would build, pointed at the fake.
  const mail = createMailApplication({ client: { mailOutboxJob: { groupBy: async () => [] } }, config, logger, kmsClient: client, storageBackend: s3Backend(s3.config({ bucket: s3.bucket })) });
  assert.equal(mail.encryption.available, false, "unavailable before unwrap");
  await assert.rejects(mail.storage.put("body", Buffer.from("x"), { purpose: "mail-body" }), (error) => error.code === "MAIL_STORAGE_UNAVAILABLE");
  await mail.ready();
  assert.equal(mail.encryption.available, true);
  assert.equal(mail.storage.available, true);
  const stored = await mail.storage.put("body", Buffer.from("hello"), { purpose: "mail-body" });
  assert.equal((await mail.storage.get(stored.key, { purpose: "mail-body", sha256: stored.sha256 })).toString(), "hello");
  const health = await mail.health();
  assert.equal(health.encryption.provider, "aws-kms");
  assert.equal(health.encryption.available, true);
  assert.equal(health.storage.ok, true);
  const secretMaterial = [generated.plaintext.toString("base64"), generated.ciphertext.toString("base64"), kms.credentials.secretAccessKey, s3.credentials.secretAccessKey];
  for (const line of logger.lines) for (const secret of secretMaterial) assert.ok(!line.includes(secret), "logs never include keys or credentials");
  assert.ok(!JSON.stringify(health).includes(generated.plaintext.toString("base64")));

  // KMS outage at startup: stays fail-closed with a reported error code.
  kms.setDown(true);
  const downLogger = silentLogger();
  const down = createMailApplication({ client: { mailOutboxJob: { groupBy: async () => [] } }, config, logger: downLogger, kmsClient: client, storageBackend: s3Backend(s3.config()) });
  await down.ready();
  assert.equal(down.encryption.available, false);
  assert.equal(down.encryption.loadError, "MAIL_KMS_UNAVAILABLE");
  assert.deepEqual(await down.storage.health(), { ok: false, detail: "keyring-mail_kms_unavailable" });
  assert.ok(downLogger.lines.some((line) => line.startsWith("error [Mail] KMS keyring unavailable")));
});

test("staging and production configuration is separated and fails closed", () => {
  const base = { MAIL_ENABLED: "true" };
  const productionOk = {
    ...base,
    MAIL_DEPLOYMENT_ENV: "production",
    MAIL_STORAGE_PROVIDER: "s3",
    MAIL_S3_ENDPOINT: "https://s3.eu-west-1.amazonaws.com",
    MAIL_S3_BUCKET: "cosmicforge-mail-production",
    MAIL_S3_SSE: "AWS:KMS",
    MAIL_KMS_PROVIDER: "aws-kms",
    MAIL_KMS_KEY_ID: "alias/cosmicforge-mail-production",
    MAIL_SCANNER_PROVIDER: "clamd",
  };
  assert.deepEqual(infrastructureViolations(loadMailConfig(productionOk)), []);
  const cases = [
    [{ MAIL_STORAGE_PROVIDER: "filesystem", MAIL_STORAGE_LOCAL_DIR: "/data" }, /requires MAIL_STORAGE_PROVIDER=s3/],
    [{ MAIL_STORAGE_PROVIDER: "memory" }, /refuses memory storage/],
    [{ MAIL_KMS_PROVIDER: "env" }, /requires MAIL_KMS_PROVIDER=aws-kms/],
    [{ MAIL_SCANNER_PROVIDER: "test-signature" }, /requires MAIL_SCANNER_PROVIDER=clamd/],
    [{ MAIL_S3_ENDPOINT: "http://minio.internal:9000" }, /must use https/],
    [{ MAIL_S3_BUCKET: "cosmicforge-mail" }, /must carry the production marker/],
    [{ MAIL_S3_BUCKET: "cosmicforge-mail-staging-production" }, /another environment's marker/],
    [{ MAIL_S3_SSE: "" }, /requires MAIL_S3_SSE/],
    [{ MAIL_KMS_KEY_ID: "alias/cosmicforge-mail-staging" }, /KMS_KEY_ID alias/],
    [{ MAIL_KMS_KEY_ID: "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab" }, /MAIL_KMS_KEY_ENVIRONMENT must be declared as production/],
    [{ MAIL_KMS_KEY_ID: "" }, /MAIL_KMS_KEY_ID is required/],
    [{ MAIL_KMS_ENDPOINT: "http://127.0.0.1:4566" }, /MAIL_KMS_ENDPOINT must use https/],
  ];
  for (const [override, expected] of cases) {
    const problems = infrastructureViolations(loadMailConfig({ ...productionOk, ...override }));
    assert.ok(problems.some((problem) => expected.test(problem)), `${JSON.stringify(override)} -> ${problems.join(" | ")}`);
  }
  assert.deepEqual(infrastructureViolations(loadMailConfig({ ...productionOk, MAIL_KMS_KEY_ID: "arn:aws:kms:eu-west-1:111122223333:key/1234", MAIL_KMS_KEY_ENVIRONMENT: "production" })), []);
  // Undeclared deployment environment on NODE_ENV=production is treated as production.
  assert.equal(loadMailConfig({ NODE_ENV: "production" }).deploymentEnvironment, "production");
  // Staging may use the filesystem adapter for the pilot but never production storage.
  assert.deepEqual(infrastructureViolations(loadMailConfig({ ...base, MAIL_DEPLOYMENT_ENV: "staging", MAIL_STORAGE_PROVIDER: "filesystem", MAIL_STORAGE_LOCAL_DIR: "/var/lib/cfmail" })), []);
  assert.ok(infrastructureViolations(loadMailConfig({ ...productionOk, MAIL_DEPLOYMENT_ENV: "staging" })).length >= 2);
  // Local development may use a local http MinIO.
  assert.deepEqual(infrastructureViolations(loadMailConfig({ ...base, MAIL_DEPLOYMENT_ENV: "development", MAIL_STORAGE_PROVIDER: "s3", MAIL_S3_ENDPOINT: "http://127.0.0.1:9000", MAIL_S3_BUCKET: "dev" })), []);
  // A refused configuration yields unavailable storage.
  const refused = createMailApplication({ client: {}, config: loadMailConfig({ ...productionOk, MAIL_STORAGE_PROVIDER: "filesystem", MAIL_STORAGE_LOCAL_DIR: "/tmp/x" }), logger: silentLogger() });
  assert.equal(refused.storage.available, false);
});

test("clamd: EICAR is FOUND, clean is OK, large streams are chunked intact", async (t) => {
  const clamd = await startFakeClamd();
  t.after(() => clamd.close());
  const scanner = clamdScanner({ host: clamd.host, port: clamd.port, timeoutMs: 2000, connectTimeoutMs: 1000, chunkBytes: 4096 });
  assert.deepEqual(await scanner.scan(Buffer.from(`prefix ${EICAR} suffix`)), { status: "INFECTED", detail: "Win.Test.EICAR_HDB-1" });
  const large = crypto.randomBytes(1024 * 1024 + 17);
  assert.deepEqual(await scanner.scan(large), { status: "CLEAN", detail: "clamd" });
  assert.equal(clamd.state.streams.at(-1).sha256, crypto.createHash("sha256").update(large).digest("hex"), "clamd received the exact bytes");
  assert.deepEqual(await scanner.scan(Buffer.alloc(0)), { status: "CLEAN", detail: "clamd" });
  assert.equal(await scanner.ping(), true);
  assert.match(await scanner.version(), /^ClamAV 1\.4\.1/);
  const health = await scanner.health();
  assert.equal(health.ok, true);
  assert.equal(scanner.metrics.infected, 1);
  assert.equal(scanner.metrics.clean, 2);
  const verdict = await evaluateAttachment(scanner, { filename: "eicar.txt", contentType: "text/plain", buffer: Buffer.from(EICAR), maxBytes: 1024 });
  assert.deepEqual(verdict, { scanStatus: "INFECTED", scanDetail: "Win.Test.EICAR_HDB-1", quarantined: true });
});

test("clamd: every failure mode quarantines (fail closed)", async (t) => {
  const clamd = await startFakeClamd();
  t.after(() => clamd.close());
  const make = (extra = {}) => clamdScanner({ host: clamd.host, port: clamd.port, timeoutMs: 400, connectTimeoutMs: 300, ...extra });
  const quarantined = async (scanner, buffer = Buffer.from("hello")) => {
    const verdict = await evaluateAttachment(scanner, { filename: "a.txt", contentType: "text/plain", buffer, maxBytes: 10 * 1024 * 1024 });
    assert.equal(verdict.quarantined, true, JSON.stringify(verdict));
    assert.notEqual(verdict.scanStatus, "CLEAN");
    return verdict;
  };
  for (const [behaviour, expected] of [["error", /^CLAMD_ERROR/], ["malformed", /^CLAMD_UNEXPECTED_REPLY/], ["hang", /^CLAMD_TIMEOUT/], ["close", /CLAMD_(EMPTY_REPLY|SOCKET_)/], ["limit", /^CLAMD_STREAM_LIMIT/]]) {
    clamd.setBehaviour(behaviour);
    const verdict = await quarantined(make(), behaviour === "limit" ? crypto.randomBytes(200 * 1024) : Buffer.from("hello"));
    assert.match(verdict.scanDetail, expected, behaviour);
  }
  clamd.setBehaviour("slow");
  assert.equal((await make({ timeoutMs: 5000, chunkBytes: 512 }).scan(crypto.randomBytes(64 * 1024))).status, "CLEAN", "partial reads / backpressure still deliver a complete stream");
  clamd.setBehaviour("auto");

  // Oversize is quarantined without contacting clamd.
  const connectionsBefore = clamd.state.connections;
  const oversize = await quarantined(make({ maxStreamBytes: 1024 }), crypto.randomBytes(2048));
  assert.equal(oversize.scanDetail, "OVERSIZE_NOT_SCANNED");
  assert.equal(clamd.state.connections, connectionsBefore);

  // Connection refused => SCANNER_UNAVAILABLE.
  const port = await closedPort();
  const refused = clamdScanner({ host: "127.0.0.1", port, timeoutMs: 400, connectTimeoutMs: 300 });
  assert.equal((await quarantined(refused)).scanStatus, "SCANNER_UNAVAILABLE");
  assert.deepEqual(await refused.health(), { ok: false, detail: "clamd unreachable" });
  assert.equal(refused.metrics.unavailable, 1);

  // Strict reply parsing: only an exact "stream: OK" is clean.
  for (const reply of ["stream: OK", "stream: OK\0"]) assert.equal(parseClamdReply(reply).status, "CLEAN");
  for (const reply of ["", "OK", "/tmp/x: OK", "stream: OKAY", "stream: OK extra", "PONG", "stream: ERROR"]) assert.notEqual(parseClamdReply(reply).status, "CLEAN", reply);
  // A scanner that throws is treated as a failed scan.
  const throwing = { name: "broken", available: true, async scan() { throw new Error("boom"); } };
  assert.equal((await quarantined(throwing)).scanStatus, "SCAN_FAILED");
});

test("operator scripts: data-key generation prints only the wrapped key; rotation args are strict", async (t) => {
  const kms = await startFakeKms({ keyIds: ["alias/cosmicforge-mail-staging"] });
  t.after(() => kms.close());
  const writes = { out: "", err: "" };
  const env = {
    MAIL_DEPLOYMENT_ENV: "development",
    MAIL_KMS_ENDPOINT: kms.endpoint,
    MAIL_KMS_REGION: kms.region,
    MAIL_KMS_KEY_ID: "alias/cosmicforge-mail-staging",
    MAIL_KMS_ACCESS_KEY_ID: kms.credentials.accessKeyId,
    MAIL_KMS_SECRET_ACCESS_KEY: kms.credentials.secretAccessKey,
    MAIL_ENCRYPTION_KEYS: "",
  };
  const io = { env, out: (text) => { writes.out += text; }, err: (text) => { writes.err += text; } };
  const { main } = require("../scripts/mail/generate-data-key");
  assert.equal(await main(["--version=v7"], io), 0);
  const line = writes.out.trim();
  assert.match(line, /^v7:kms:[A-Za-z0-9+/=]+$/);
  // The printed entry is a usable keyring entry for this environment only.
  const client = createAwsKmsClient({ region: kms.region, endpoint: kms.endpoint, keyId: "alias/cosmicforge-mail-staging", credentials: kms.credentials });
  const keyring = await resolveMailKeyring({ provider: "aws-kms", keys: line, environment: "development", kmsClient: client });
  assert.equal(keyring.keys.get("v7").length, 32);
  assert.ok(!writes.out.includes(keyring.keys.get("v7").toString("base64")) && !writes.err.includes(keyring.keys.get("v7").toString("base64")), "plaintext data key is never printed");
  env.MAIL_ENCRYPTION_KEYS = line;
  await assert.rejects(main(["--version=v7"], io), /already exists/);
  await assert.rejects(main(["--version=bad version"], io), /--version/);

  const { parseArgs } = require("../scripts/mail/rotate-encryption");
  assert.deepEqual(parseArgs([]), { apply: false, skipObjects: false, batchSize: 200, limit: Infinity, operator: null });
  assert.deepEqual(parseArgs(["--apply", "--skip-objects", "--batch-size=50", "--limit=10", "--operator=abc"]), { apply: true, skipObjects: true, batchSize: 50, limit: 10, operator: "abc" });
  assert.throws(() => parseArgs(["--force"]), /Unknown argument/);
});
