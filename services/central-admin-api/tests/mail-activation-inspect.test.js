"use strict";

// The staging activation inspection (scripts/mail/activation-inspect.js) is
// read-only and must never print a secret, key, bucket or host value. Runs the
// script as a child process with fake staging-like settings, all on loopback.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "mail", "activation-inspect.js");
const SECRETS = {
  RESEND_API_KEY: "re_inspectfake_0123456789abcdef",
  RESEND_WEBHOOK_SECRET: "whsec_inspectfake0123456789",
  MAIL_ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 7).toString("base64")}`,
  MAIL_S3_ACCESS_KEY_ID: "AKIAINSPECTFAKE0001",
  MAIL_S3_SECRET_ACCESS_KEY: "inspect-fake-secret-access-key-0001",
  MAIL_S3_BUCKET: "inspectfake-bucket-staging",
};

function run(extra = {}) {
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL || "",
    MAIL_DEPLOYMENT_ENV: "staging",
    MAIL_STORAGE_PROVIDER: "s3",
    MAIL_S3_ENDPOINT: "http://127.0.0.1:1",
    MAIL_SCANNER_PROVIDER: "clamd",
    MAIL_CLAMD_HOST: "127.0.0.1",
    MAIL_CLAMD_PORT: "1",
    MAIL_SCANNER_CONNECT_TIMEOUT_MS: "500",
    MAIL_ENCRYPTION_ACTIVE_KEY: "v1",
    ...SECRETS,
    ...extra,
  };
  const result = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8", timeout: 60000 });
  const line = (result.stdout || "").split("\n").find((l) => l.startsWith("MAIL_ACTIVATION_INSPECTION "));
  return { result, output: `${result.stdout}${result.stderr}`, report: line ? JSON.parse(line.slice("MAIL_ACTIVATION_INSPECTION ".length)) : null };
}

test("inspection prints presence only, never secret or bucket values", () => {
  const { output, report } = run();
  assert.ok(report, output);
  for (const [name, value] of Object.entries(SECRETS)) assert.ok(!output.includes(value), `${name} value leaked`);
  assert.equal(output.includes(Buffer.alloc(32, 7).toString("base64")), false, "raw key leaked");
  assert.equal(output.includes("127.0.0.1"), false, "host leaked");
  assert.equal(report.secretsPresent.RESEND_API_KEY, true);
  assert.equal(report.storage.bucketSet, true);
  assert.equal(report.storage.bucketNameMarksStaging, true);
  assert.equal(report.encryption.keyringEntries, 1);
  assert.equal(report.encryption.activeKeyInKeyring, true);
  assert.equal(report.encryption.rawEntriesWellFormed, true);
  assert.match(report.storage.endpointTcp, /^UNREACHABLE_|^TIMEOUT$/);
  assert.equal(report.scanner.health, "UNAVAILABLE");
  assert.ok(report.blockers.includes("virus scanner (clamd) not answering PING"));
  assert.equal(report.allMailFlagsOff, true);
});

test("inspection reports a Mail flag that is already on as a blocker", () => {
  const { report } = run({ MAIL_ENABLED: "true" });
  assert.equal(report.allMailFlagsOff, false);
  assert.ok(report.blockers.includes("a Mail flag is already on (expected all off before approval)"));
});

test("inspection opens a read-only database session and changes nothing", { skip: !process.env.DATABASE_URL && "DATABASE_URL not set" }, () => {
  const { report, output } = run();
  assert.equal(report.database.connect, "OK", output);
  assert.equal(report.database.sessionReadOnly, true);
  assert.equal(report.database.isAdminDatabase, true);
  assert.equal(report.database.ledger.manifestMigrations, 37);
  assert.ok(report.database.mailSchema.core);
});

test("helpers: failures become fixed codes and violations are redacted", () => {
  process.env.MAIL_INSPECT_LOAD_ONLY = "1";
  const { errorCode, redactViolation } = require(SCRIPT);
  delete process.env.MAIL_INSPECT_LOAD_ONLY;
  const leaky = Object.assign(new Error("connect to db.internal.example:5432 as admin password=hunter2 failed"), { code: "ECONNREFUSED" });
  assert.equal(errorCode(leaky), "ECONNREFUSED");
  assert.equal(errorCode(new Error("password=hunter2")), "INSPECTION_ERROR", "message-only errors never surface");
  assert.equal(errorCode({ code: "bad code with spaces password=hunter2" }), "INSPECTION_ERROR");
  const redacted = redactViolation("MAIL_RESERVED_SENDER_ADDRESSES entry secret.sender@leak.example is not on a MAIL_DOMAIN_ALLOWLIST domain; endpoint https://kms.internal.example/x host db.internal.example");
  assert.ok(!/secret\.sender|leak\.example|internal\.example/.test(redacted), redacted);
  assert.match(redacted, /MAIL_RESERVED_SENDER_ADDRESSES entry \[address\] is not on a MAIL_DOMAIN_ALLOWLIST domain/);
});

test("inspection never prints an address from a policy violation", () => {
  const { output, report } = run({ MAIL_DOMAIN_ALLOWLIST: "karryam.example", MAIL_RESERVED_SENDER_ADDRESSES: "secret.sender@leak-domain.example" });
  assert.ok(report, output);
  assert.ok(report.currentViolations.some((v) => v.includes("[address]")), JSON.stringify(report.currentViolations));
  assert.equal(output.includes("secret.sender"), false, "address leaked");
  assert.equal(output.includes("leak-domain.example"), false, "domain leaked");
});

test("a secret-bearing database failure is reported as a code only", { skip: !process.env.DATABASE_URL && "DATABASE_URL not set" }, () => {
  const url = new URL(process.env.DATABASE_URL);
  url.password = "LeakedPassw0rdValue";
  url.pathname = "/leak_db_SECRETNAME_0001";
  const { output, report } = run({ DATABASE_URL: url.toString() });
  assert.ok(report, output);
  assert.match(report.database.connect, /^FAILED_[A-Za-z0-9_]+$/);
  for (const secret of ["LeakedPassw0rdValue", "SECRETNAME", "leak_db"]) assert.equal(output.includes(secret), false, `${secret} leaked`);
});

test("a top-level failure prints only a fixed code", () => {
  const env = { PATH: process.env.PATH, INSPECT_APP_ROOT: "/nonexistent/SECRET_PATH_TOKEN_0001", DATABASE_URL: "postgresql://u:TopLevelSecret0001@db.internal.example/x" };
  const result = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8", timeout: 30000 });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^MAIL_ACTIVATION_INSPECTION_FAILED \{"errorCode":"[A-Za-z0-9_]+"\}\n$/);
  for (const secret of ["SECRET_PATH_TOKEN", "TopLevelSecret0001", "db.internal.example"]) assert.equal(output.includes(secret), false, `${secret} leaked`);
});
