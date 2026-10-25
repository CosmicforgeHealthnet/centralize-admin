"use strict";

// M10 drills in CI: the offline canary and the rollback drill each build
// their own disposable replay database. The rollback drill keeps
// docs/sql/cosmicforge-mail-m7-m10-rollback.sql in sync with the migrations.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFile } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

function run(script, args = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, env: process.env, timeout: 240000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const start = stdout.search(/^\{/m);
      let report = null;
      try { report = JSON.parse(stdout.slice(start)); } catch { report = null; }
      resolve({ code: error ? error.code ?? 1 : 0, report, stderr });
    });
  });
}

test("offline canary simulation passes end to end", { timeout: 260000 }, async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const result = await run("scripts/mail/canary.js", ["simulate"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.report.ok, true);
  assert.equal(result.report.provider, "fake (offline)");
  assert.ok(result.report.steps.every((step) => step.pass));
});

test("rollback drill removes M7-M10 cleanly and rolls forward without drift", { timeout: 260000 }, async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const result = await run("scripts/mail/rollback-drill.js");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.report.ok, true, JSON.stringify(result.report));
  assert.equal(result.report.rollForwardDrift, "none");
});

test("live canary only prints a plan without explicit confirmation", async () => {
  const { live } = require("../scripts/mail/canary");
  const plan = await live({ environment: "staging", api: "https://hq.invalid", mailbox: "m", to: "seed@ops.invalid" });
  assert.equal(plan.executed, false);
  await assert.rejects(live({ environment: "production", execute: true, "confirm-live": "production", api: "https://hq.invalid", mailbox: "m", to: "x" }), /allow-production/);
});
