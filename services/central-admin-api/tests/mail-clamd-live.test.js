"use strict";

// Opt-in test against a REAL clamd (e.g. the clamav/clamav container). Skipped
// unless MAIL_CLAMD_LIVE_HOST is set. Run by the manual "Mail ClamAV live"
// workflow; never part of the default CI path.
//   MAIL_CLAMD_LIVE_HOST=127.0.0.1 MAIL_CLAMD_LIVE_PORT=3310 npm run test:mail:clamd-live

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { clamdScanner, evaluateAttachment, EICAR } = require("../src/modules/mail/scanning/attachment-scanner");

const host = process.env.MAIL_CLAMD_LIVE_HOST;
const port = Number(process.env.MAIL_CLAMD_LIVE_PORT || 3310);

test("real clamd: PING/VERSION, EICAR detected, clean accepted, oversize quarantined", { skip: host ? false : "MAIL_CLAMD_LIVE_HOST not set" }, async () => {
  require("./helpers/network-guard").registerLocalPort(port);
  const scanner = clamdScanner({ host, port, timeoutMs: 60000, connectTimeoutMs: 5000, maxStreamBytes: 25 * 1024 * 1024 });
  assert.equal(await scanner.ping(), true);
  assert.match(await scanner.version(), /^ClamAV \d+\.\d+/);
  const infected = await evaluateAttachment(scanner, { filename: "eicar.txt", contentType: "text/plain", buffer: Buffer.from(EICAR), maxBytes: 1024 * 1024 });
  assert.equal(infected.scanStatus, "INFECTED");
  assert.equal(infected.quarantined, true);
  assert.match(infected.scanDetail, /eicar/i);
  const clean = await evaluateAttachment(scanner, { filename: "report.pdf", contentType: "application/pdf", buffer: crypto.randomBytes(2 * 1024 * 1024), maxBytes: 10 * 1024 * 1024 });
  assert.equal(clean.scanStatus, "CLEAN");
  const small = clamdScanner({ host, port, timeoutMs: 60000, connectTimeoutMs: 5000, maxStreamBytes: 1024 });
  assert.equal((await small.scan(crypto.randomBytes(4096))).detail, "OVERSIZE_NOT_SCANNED");
});
