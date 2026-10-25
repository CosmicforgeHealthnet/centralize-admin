#!/usr/bin/env node
"use strict";

// Re-encrypt Mail ciphertext under MAIL_ENCRYPTION_ACTIVE_KEY.
//
//   npm run mail:keys:rotate                       # dry run (default): counts only
//   npm run mail:keys:rotate -- --apply            # rewrap everything
//   npm run mail:keys:rotate -- --apply --limit=500 --batch-size=100
//   npm run mail:keys:rotate -- --apply --skip-objects   # e.g. Object Lock buckets
//   --operator=<adminUserId> records who ran it in the Mail audit trail.
//
// Uses the same configuration as the API (MAIL_STORAGE_*, MAIL_KMS_*,
// MAIL_ENCRYPTION_KEYS). Both the old and new key versions must be in the
// keyring. Never prints key material or content. Re-running is safe.

require("dotenv").config();

function parseArgs(argv) {
  const args = { apply: false, skipObjects: false, batchSize: 200, limit: Infinity, operator: null };
  for (const raw of argv) {
    if (raw === "--apply") args.apply = true;
    else if (raw === "--skip-objects") args.skipObjects = true;
    else if (raw.startsWith("--batch-size=")) args.batchSize = Math.max(1, Math.min(1000, Number.parseInt(raw.split("=")[1], 10) || 200));
    else if (raw.startsWith("--limit=")) args.limit = Math.max(1, Number.parseInt(raw.split("=")[1], 10) || 1);
    else if (raw.startsWith("--operator=")) args.operator = raw.split("=")[1] || null;
    else throw new Error(`Unknown argument ${raw}`);
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { loadMailConfig } = require("../../src/modules/mail/mail.config");
  const config = loadMailConfig(process.env);
  const { prisma } = require("../../src/shared/config/database");
  const { createMailApplication } = require("../../src/modules/mail/application");
  const { rotateMailEncryption } = require("../../src/modules/mail/security/key-rotation");
  const mail = createMailApplication({ client: prisma, config });
  await mail.ready();
  if (!mail.encryption.available) throw new Error(`Mail keyring unavailable (${mail.encryption.loadError || "not configured"})`);
  if (!args.skipObjects && !mail.storage.available) throw new Error("Private storage unavailable; fix it or pass --skip-objects");
  const summary = await rotateMailEncryption({ client: prisma, storage: mail.storage, encryption: mail.encryption, audit: mail.audit, dryRun: !args.apply, batchSize: args.batchSize, limit: args.limit, skipObjects: args.skipObjects, operator: args.operator });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  await prisma.$disconnect();
  return summary.failed ? 2 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`mail-key-rotation failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
