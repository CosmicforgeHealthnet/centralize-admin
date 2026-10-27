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
