#!/usr/bin/env node
"use strict";

// Generate a new KMS-wrapped Mail data key (AES-256) for the keyring.
//
//   MAIL_DEPLOYMENT_ENV=staging MAIL_KMS_KEY_ID=alias/cosmicforge-mail-staging \
//   MAIL_KMS_REGION=eu-west-1 npm run mail:kms:generate-data-key -- --version=v2
//
// Prints ONLY the wrapped entry ("v2:kms:<CiphertextBlob>") to append to
// MAIL_ENCRYPTION_KEYS in the secret store. The plaintext data key is never
// printed or written anywhere and is zeroed after use. The wrapped key is bound
// to {purpose, environment, keyVersion}: it cannot be unwrapped for another
// environment or under another version id.

require("dotenv").config();

async function main(argv = process.argv.slice(2), { env = process.env, out = (text) => process.stdout.write(text), err = (text) => process.stderr.write(text) } = {}) {
  const versionArg = argv.find((arg) => arg.startsWith("--version="));
  const version = versionArg ? versionArg.split("=")[1] : "";
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(version)) throw new Error("--version=<id> is required (1-16 of A-Z a-z 0-9 _ -)");
  const { loadMailConfig, infrastructureViolations } = require("../../src/modules/mail/mail.config");
  const { createAwsKmsClient, encryptionContext } = require("../../src/modules/mail/security/kms-keyring");
  const config = loadMailConfig({ ...env, MAIL_KMS_PROVIDER: "aws-kms" });
  const problems = infrastructureViolations(config).filter((problem) => problem.includes("KMS"));
  if (problems.length) throw new Error(problems.join("; "));
  if (config.encryption.keys.split(",").some((entry) => entry.trim().startsWith(`${version}:`))) throw new Error(`Key version ${version} already exists in MAIL_ENCRYPTION_KEYS`);
  const client = createAwsKmsClient({
    region: config.kms.region,
    endpoint: config.kms.endpoint,
    keyId: config.kms.keyId,
    timeoutMs: config.kms.timeoutMs,
    credentials: { accessKeyId: config.kms.accessKeyId, secretAccessKey: config.kms.secretAccessKey, sessionToken: config.kms.sessionToken || undefined },
  });
  const generated = await client.generateDataKey(encryptionContext({ environment: config.deploymentEnvironment, version }));
  generated.plaintext.fill(0);
  out(`${version}:kms:${generated.ciphertext.toString("base64")}\n`);
  err(`Generated ${version} for ${config.deploymentEnvironment} under ${config.kms.keyId}. Append it to MAIL_ENCRYPTION_KEYS, then set MAIL_ENCRYPTION_ACTIVE_KEY=${version} and run mail:keys:rotate.\n`);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`generate-data-key failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { main };
