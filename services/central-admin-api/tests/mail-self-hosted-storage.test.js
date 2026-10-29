"use strict";

// Self-hosted Mail storage and keys (no AWS): keyring file provider, key
// management CLI, recovery escrow, hardened filesystem backend, application
// wiring, and the restore verifier (against PostgreSQL when DATABASE_URL is set).

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("pg");

const keyringLib = require("../src/modules/mail/security/file-keyring");
const { run: keyringCli } = require("../scripts/mail/keyring");
const { createMailEncryption } = require("../src/modules/mail/security/mail-encryption.service");
const { createEncryptedStore, filesystemBackend, STORE_MARKER } = require("../src/modules/mail/storage/mail-storage");
const { loadMailConfig, infrastructureViolations } = require("../src/modules/mail/mail.config");
const { createMailApplication } = require("../src/modules/mail/application");
const { verifyRestoredContent } = require("../scripts/mail/verify-restored-content");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const capture = () => {
  const lines = [];
  return { lines, stdout: { write: (chunk) => lines.push(JSON.parse(String(chunk))) } };
};
const silent = () => {
  const lines = [];
  return { lines, info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) };
};
const rsaPair = (bits = 3072) => crypto.generateKeyPairSync("rsa", { modulusLength: bits, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });

test("keyring file: generated on the server, 0400, bound to its environment, fails closed", () => {
  const dir = tmp("cfmail-kr-");
  const file = path.join(dir, "keyring.json");
  const out = capture();
  keyringCli(["generate", "--environment=production", `--out=${file}`], out);
  assert.equal(fs.statSync(file).mode & 0o777, 0o400);
  assert.equal(out.lines[0].active, "v1");
  assert.match(out.lines[0].versions[0].fingerprint, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(out.lines).includes(JSON.parse(fs.readFileSync(file, "utf8")).keys.v1), "CLI never prints key material");
  const keyring = keyringLib.readKeyringFile(file, { environment: "production" });
  assert.equal(keyring.keys.get("v1").length, 32);
  assert.throws(() => keyringCli(["generate", "--environment=production", `--out=${file}`], capture()), /refusing to overwrite/);
  assert.throws(() => keyringLib.readKeyringFile(file, { environment: "staging" }), (e) => e.code === "MAIL_KMS_CONFIG" && /belongs to production/.test(e.message));
  fs.chmodSync(file, 0o440);
  assert.throws(() => keyringLib.readKeyringFile(file, { environment: "production" }), /group\/other/);
  assert.doesNotThrow(() => keyringLib.readKeyringFile(file, { environment: "production", strictPermissions: false }));
  assert.throws(() => keyringLib.readKeyringFile(path.join(dir, "missing.json")), /missing/);
  assert.throws(() => keyringLib.readKeyringFile("relative.json"), /absolute/);
  const bad = path.join(dir, "bad.json");
  for (const document of [
    { format: "x" },
    { format: keyringLib.FORMAT, environment: "production", active: "v1", keys: { v1: crypto.randomBytes(16).toString("base64") } },
    { format: keyringLib.FORMAT, environment: "production", active: "v2", keys: { v1: crypto.randomBytes(32).toString("base64") } },
    { format: keyringLib.FORMAT, active: "v1", keys: { v1: crypto.randomBytes(32).toString("base64") } },
  ]) {
    fs.rmSync(bad, { force: true });
    fs.writeFileSync(bad, JSON.stringify(document), { mode: 0o400 });
    assert.throws(() => keyringLib.readKeyringFile(bad, { environment: "production" }), (e) => e.code === "MAIL_KMS_CONFIG");
  }
});

test("keyring CLI: import-env keeps existing keys readable; rotation adds and activates versions", () => {
  const dir = tmp("cfmail-kr-");
  const raw = crypto.randomBytes(32).toString("base64");
  const legacy = createMailEncryption({ keys: `v1:${raw}`, activeKey: "v1" });
  const envelope = legacy.encrypt(Buffer.from("staging pilot content"), "mail-body:body/aa/x");
  const file = path.join(dir, "keyring.json");
  keyringCli(["import-env", "--environment=staging", `--out=${file}`], { ...capture(), env: { MAIL_ENCRYPTION_KEYS: `v1:${raw}`, MAIL_ENCRYPTION_ACTIVE_KEY: "v1" } });
  const imported = createMailEncryption({ keyring: keyringLib.readKeyringFile(file, { environment: "staging" }) });
  assert.equal(imported.decrypt(envelope, "mail-body:body/aa/x").toString(), "staging pilot content", "ciphertext written before the import still decrypts");
  assert.throws(() => keyringCli(["import-env", "--environment=staging", `--out=${path.join(dir, "k2.json")}`], { ...capture(), env: {} }), /empty/);
  const out = capture();
  keyringCli(["add-key", `--file=${file}`, "--activate"], out);
  assert.equal(out.lines[0].added, "v2");
  assert.equal(out.lines[0].active, "v2");
  assert.equal(fs.statSync(file).mode & 0o777, 0o400, "rotation keeps the file 0400");
  const rotated = createMailEncryption({ keyring: keyringLib.readKeyringFile(file, { environment: "staging" }) });
  assert.equal(rotated.decrypt(envelope, "mail-body:body/aa/x").toString(), "staging pilot content", "old version kept for existing ciphertext");
  assert.equal(rotated.envelopeKeyVersion(rotated.encrypt(Buffer.from("new"), "p")), "v2");
  keyringCli(["activate", `--file=${file}`, "--version=v1"], capture());
  assert.equal(keyringLib.readKeyringFile(file, { environment: "staging" }).active, "v1");
  assert.throws(() => keyringCli(["activate", `--file=${file}`, "--version=v9"], capture()), /not in the keyring/);
});

test("recovery escrow: sealed to an offline RSA key, verifiable without it, recoverable with it", () => {
  const dir = tmp("cfmail-escrow-");
  const file = path.join(dir, "keyring.json");
  keyringCli(["generate", "--environment=production", `--out=${file}`], capture());
  const { publicKey, privateKey } = rsaPair();
  fs.writeFileSync(path.join(dir, "recovery.pub"), publicKey);
  fs.writeFileSync(path.join(dir, "recovery.key"), privateKey);
  const escrowFile = path.join(dir, "escrow.json");
  keyringCli(["seal", `--file=${file}`, `--recipient=${path.join(dir, "recovery.pub")}`, `--out=${escrowFile}`], capture());
  const escrow = JSON.parse(fs.readFileSync(escrowFile, "utf8"));
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(!fs.readFileSync(escrowFile, "utf8").includes(original.keys.v1), "escrow never holds the key in clear");
  const verify = capture();
  keyringCli(["verify-escrow", `--file=${file}`, `--escrow=${escrowFile}`], verify);
  assert.equal(verify.lines[0].ok, true);
  const recovered = path.join(dir, "recovered.json");
  keyringCli(["open", `--escrow=${escrowFile}`, `--private-key=${path.join(dir, "recovery.key")}`, `--out=${recovered}`], capture());
  assert.deepEqual(JSON.parse(fs.readFileSync(recovered, "utf8")).keys, original.keys, "recovery restores the exact keys");
  // Tampering, the wrong private key and weak recovery keys are refused.
  assert.throws(() => keyringLib.openEscrow({ ...escrow, ciphertext: Buffer.from("x".repeat(40)).toString("base64") }, privateKey));
  assert.throws(() => keyringLib.openEscrow({ ...escrow, active: "v9" }, privateKey), "the header is authenticated");
  assert.throws(() => keyringLib.openEscrow(escrow, rsaPair().privateKey));
  assert.throws(() => keyringLib.sealKeyring(original, rsaPair(2048).publicKey), /at least 3072/);
  // After a rotation the old escrow no longer matches: a fresh seal is needed.
  keyringCli(["add-key", `--file=${file}`, "--activate"], capture());
  const stale = capture();
  const previousExitCode = process.exitCode;
  keyringCli(["verify-escrow", `--file=${file}`, `--escrow=${escrowFile}`], stale);
  process.exitCode = previousExitCode;
  assert.equal(stale.lines[0].ok, false);
});

test("filesystem store: environment marker, own volume, free-space floor, ciphertext only, survives restart", async () => {
  const dir = tmp("cfmail-store-");
  const keyring = { keys: new Map([["v1", crypto.randomBytes(32)]]), active: "v1" };
  const encryption = createMailEncryption({ keyring });
  const store = createEncryptedStore({ encryption, backend: filesystemBackend(dir, { environment: "production" }) });
  const secret = Buffer.from("inbound body: invoice 4471");
  const put = await store.put("attachment", secret, { purpose: "mail-attachment" });
  const raw = fs.readFileSync(path.join(dir, put.key));
  assert.ok(!raw.includes(secret), "disk holds ciphertext only");
  assert.equal(fs.statSync(path.join(dir, put.key)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, STORE_MARKER), "utf8")).environment, "production");
  // A new process (container restart / new image) over the same volume reads it back.
  const restarted = createEncryptedStore({ encryption: createMailEncryption({ keyring }), backend: filesystemBackend(dir, { environment: "production" }) });
  assert.deepEqual(await restarted.get(put.key, { purpose: "mail-attachment", sha256: put.sha256 }), secret);
  await assert.rejects(restarted.get(put.key, { purpose: "mail-body", sha256: put.sha256 }), (e) => e.code === "MAIL_STORAGE_INTEGRITY", "wrong purpose (AAD) is refused");
  fs.writeFileSync(path.join(dir, put.key), Buffer.concat([raw.subarray(0, raw.length - 1), Buffer.from([raw[raw.length - 1] ^ 1])]));
  await assert.rejects(restarted.get(put.key, { purpose: "mail-attachment", sha256: put.sha256 }), (e) => e.code === "MAIL_STORAGE_INTEGRITY", "tampering is detected");
  // The same volume mounted into another environment is refused.
  const other = filesystemBackend(dir, { environment: "staging" });
  assert.deepEqual(await other.health(), { ok: false, detail: "store-belongs-to-another-environment" });
  await assert.rejects(other.write("body/ab/abcdef0123456789", Buffer.from("x")), (e) => e.code === "MAIL_STORAGE_UNAVAILABLE");
  // A plain directory on the same device as its parent is not a volume.
  const unmounted = filesystemBackend(tmp("cfmail-plain-"), { environment: "production", requireMount: true });
  assert.deepEqual(await unmounted.health(), { ok: false, detail: "not-a-mounted-volume" });
  await assert.rejects(unmounted.write("body/ab/abcdef0123456789", Buffer.from("x")), /not-a-mounted-volume/);
  // Below the free-space floor writes are refused and health fails.
  const full = filesystemBackend(tmp("cfmail-full-"), { environment: "production", minFreeBytes: Number.MAX_SAFE_INTEGER });
  assert.equal((await full.health()).detail, "low-space");
  await assert.rejects(full.write("body/ab/abcdef0123456789", Buffer.from("x")), /low on space/);
  // Healthy store reports free space; object keys can never escape the root.
  const healthy = await filesystemBackend(dir, { environment: "production", minFreeBytes: 1024 }).health();
  assert.equal(healthy.ok, true);
  assert.ok(healthy.freeBytes > 0);
  await assert.rejects(store.get("../../etc/passwd", { purpose: "x" }), /Unsafe/);
  // Rotation replaces objects atomically.
  const rotated = createMailEncryption({ keyring: { keys: new Map([...keyring.keys, ["v2", crypto.randomBytes(32)]]), active: "v2" } });
  const second = await store.put("body", Buffer.from("rotate me"), { purpose: "mail-body" });
  const rotatingStore = createEncryptedStore({ encryption: rotated, backend: filesystemBackend(dir, { environment: "production" }) });
  assert.deepEqual(await rotatingStore.reencrypt(second.key, { purpose: "mail-body" }), { key: second.key, changed: true, from: "v1", to: "v2" });
  assert.equal(await rotatingStore.keyVersionOf(second.key), "v2");
  assert.equal(fs.readdirSync(path.dirname(path.join(dir, second.key))).filter((name) => name.includes(".rotate-")).length, 0, "no temporary files left");
});

test("application with MAIL_KMS_PROVIDER=file loads the keyring, fails closed on the wrong environment, never logs keys", async () => {
  const dir = tmp("cfmail-app-");
  const file = path.join(dir, "keyring.json");
  keyringCli(["generate", "--environment=staging", `--out=${file}`], capture());
  const key = JSON.parse(fs.readFileSync(file, "utf8")).keys.v1;
  const store = tmp("cfmail-app-store-");
  const env = { MAIL_ENABLED: "true", MAIL_DEPLOYMENT_ENV: "staging", MAIL_PROVIDER: "resend", MAIL_STORAGE_PROVIDER: "filesystem", MAIL_STORAGE_LOCAL_DIR: store, MAIL_STORAGE_REQUIRE_MOUNT: "false", MAIL_KMS_PROVIDER: "file", MAIL_ENCRYPTION_KEYRING_FILE: file, MAIL_SCANNER_PROVIDER: "clamd" };
  assert.deepEqual(infrastructureViolations(loadMailConfig(env)), []);
  const logger = silent();
  const mail = createMailApplication({ client: {}, config: loadMailConfig(env), logger });
  await mail.ready();
  assert.equal(mail.encryption.available, true);
  const health = await mail.health();
  assert.equal(health.encryption.provider, "file");
  assert.equal(health.storage.ok, true);
  assert.equal(health.storage.backend, "encrypted-filesystem");
  assert.ok(logger.lines.some((line) => line.includes("keyring loaded from file (1 key version(s), active v1)")));
  assert.ok(!logger.lines.join("\n").includes(key));
  const wrongLogger = silent();
  const wrong = createMailApplication({ client: {}, config: loadMailConfig({ ...env, MAIL_DEPLOYMENT_ENV: "production" }), logger: wrongLogger });
  await wrong.ready();
  assert.equal(wrong.encryption.available, false);
  assert.equal(wrong.encryption.loadError, "MAIL_KMS_CONFIG");
  assert.equal(wrong.storage.available, false);
  assert.ok(wrongLogger.lines.some((line) => /belongs to staging, not production/.test(line)));
  assert.ok(!wrongLogger.lines.join("\n").includes(key));
});

test("restore verifier: every object and encrypted column decrypts and matches its recorded SHA-256", { skip: !process.env.DATABASE_URL && "DATABASE_URL not set" }, async (t) => {
  const name = `cfmail_restore_verify_${crypto.randomBytes(4).toString("hex")}`;
  const admin = new URL(process.env.DATABASE_URL);
  admin.pathname = "/postgres";
  const target = new URL(process.env.DATABASE_URL);
  target.pathname = `/${name}`;
  const query = async (url, sql, params) => {
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      return await client.query(sql, params);
    } finally {
      await client.end();
    }
  };
  await query(admin, `CREATE DATABASE "${name}"`);
  t.after(() => query(admin, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {}));
  for (const ddl of [
    "CREATE TABLE mail_messages (id uuid PRIMARY KEY, content_object_key varchar(512), content_sha256 char(64), encrypted_snippet bytea)",
    "CREATE TABLE mail_attachments (id uuid PRIMARY KEY, storage_key varchar(512), sha256 char(64))",
    "CREATE TABLE mail_message_archives (id uuid PRIMARY KEY, headers_object_key varchar(512), headers_sha256 char(64), raw_mime_object_key varchar(512), raw_mime_sha256 char(64))",
    "CREATE TABLE mail_drafts (id uuid PRIMARY KEY, encrypted_body bytea)",
    "CREATE TABLE mail_threads (id uuid PRIMARY KEY, encrypted_snippet bytea)",
  ]) await query(target, ddl);

  const keyDir = tmp("cfmail-rv-");
  const file = path.join(keyDir, "keyring.json");
  keyringCli(["generate", "--environment=staging", `--out=${file}`], capture());
  const encryption = createMailEncryption({ keyring: keyringLib.readKeyringFile(file, { environment: "staging" }) });
  const storeDir = tmp("cfmail-rv-store-");
  const store = createEncryptedStore({ encryption, backend: filesystemBackend(storeDir, { environment: "staging" }) });
  const body = await store.put("body", Buffer.from('{"text":"hello"}'), { purpose: "mail-body" });
  const attachment = await store.put("attachment", crypto.randomBytes(4096), { purpose: "mail-attachment" });
  const headers = await store.put("archive", Buffer.from("[]"), { purpose: "mail-archive-headers" });
  const rawMime = await store.put("archive", Buffer.from("From: a@b\r\n\r\nx"), { purpose: "mail-raw-mime" });
  await query(target, "INSERT INTO mail_messages VALUES ($1,$2,$3,$4), ($5,$2,$3,NULL)", [crypto.randomUUID(), body.key, body.sha256, encryption.encrypt(Buffer.from("snippet"), "mail-snippet"), crypto.randomUUID()]);
  await query(target, "INSERT INTO mail_attachments VALUES ($1,$2,$3)", [crypto.randomUUID(), attachment.key, attachment.sha256]);
  await query(target, "INSERT INTO mail_message_archives VALUES ($1,$2,$3,$4,$5)", [crypto.randomUUID(), headers.key, headers.sha256, rawMime.key, rawMime.sha256]);
  await query(target, "INSERT INTO mail_drafts VALUES ($1,$2)", [crypto.randomUUID(), encryption.encrypt(Buffer.from("draft"), "mail-draft")]);
  await query(target, "INSERT INTO mail_threads VALUES ($1,$2)", [crypto.randomUUID(), encryption.encrypt(Buffer.from("thread"), "mail-snippet")]);

  const verify = () => verifyRestoredContent({ databaseUrl: target.toString(), storageDir: storeDir, keyringFile: file, environment: "staging" });
  const good = await verify();
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.objectsChecked, 4, "shared objects are checked once");
  assert.equal(good.columnsChecked, 3);
  assert.equal(good.storeEnvironment, "staging");

  // A missing object, a tampered object and an undecryptable column are all reported.
  fs.rmSync(path.join(storeDir, attachment.key));
  const tampered = path.join(storeDir, headers.key);
  const bytes = fs.readFileSync(tampered);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(tampered, bytes);
  await query(target, "INSERT INTO mail_drafts VALUES ($1,$2)", [crypto.randomUUID(), crypto.randomBytes(64)]);
  const bad = await verify();
  assert.equal(bad.ok, false);
  assert.equal(bad.objects["mail_attachments.storage_key"].missing, 1);
  assert.equal(bad.objects["mail_message_archives.headers_object_key"].integrity, 1);
  assert.equal(bad.columns["mail_drafts.encrypted_body"].failed, 1);
  // The wrong keyring (another environment) is refused outright.
  await assert.rejects(verifyRestoredContent({ databaseUrl: target.toString(), storageDir: storeDir, keyringFile: file, environment: "production" }), /belongs to staging/);
});
