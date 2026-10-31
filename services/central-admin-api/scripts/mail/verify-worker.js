#!/usr/bin/env node
"use strict";

// Deploy verification of the Mail worker, run inside the API container (the
// API's own database and Mail settings) by the deploy scripts:
//   node scripts/mail/verify-worker.js [--expect-release <image>] [--no-self-test] [--wait <seconds>]
// Prints one line `CA_MAIL_WORKER_VERIFY <json>` (states, counts, codes only).
// Exit codes: 0 verified, 1 not verified, 2 not applicable (Mail or the worker
// disabled by configuration).

require("dotenv").config({ quiet: true });
const { loadMailConfig } = require("../../src/modules/mail/mail.config");
const { verifyWorker } = require("../../src/modules/mail/ops/worker-verification");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index > -1 ? process.argv[index + 1] : null;
}

async function main() {
  const config = loadMailConfig(process.env);
  const { prisma } = require("../../src/shared/config/database");
  const { createMailJobRepository } = require("../../src/modules/mail/jobs/mail-job.repository");
  try {
    const result = await verifyWorker({
      client: prisma,
      config,
      jobs: createMailJobRepository({ client: prisma }),
      expectRelease: argValue("--expect-release"),
      selfTest: !process.argv.includes("--no-self-test"),
      waitSeconds: Math.min(Math.max(Number(argValue("--wait")) || 120, 5), 600),
    });
    process.stdout.write(`CA_MAIL_WORKER_VERIFY ${JSON.stringify(result)}\n`);
    return result.applicable === false ? 2 : result.ok ? 0 : 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  process.stdout.write(`CA_MAIL_WORKER_VERIFY ${JSON.stringify({ ok: false, reason: "VERIFY_ERROR", error: String(error?.code || error?.name || "error") })}\n`);
  process.exit(1);
});
