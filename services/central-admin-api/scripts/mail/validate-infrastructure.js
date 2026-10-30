#!/usr/bin/env node
"use strict";

// Offline check of the Mail storage / KMS / scanner configuration rules for the
// current environment (no network calls). Exits 1 when the configuration would
// be refused at runtime.
//   MAIL_DEPLOYMENT_ENV=production npm run mail:config:validate

require("dotenv").config();
const { loadMailConfig, infrastructureViolations, addressPolicyViolations, providerConfigured } = require("../../src/modules/mail/mail.config");

const config = loadMailConfig(process.env);
const problems = [...infrastructureViolations(config), ...addressPolicyViolations(config)];
// Flags and presence only: never a secret or key value.
const summary = {
  deploymentEnvironment: config.deploymentEnvironment,
  mailEnabled: config.enabled,
  flags: { sending: config.sendingEnabled, receiving: config.receivingEnabled, worker: config.workerEnabled, marketing: config.marketingEnabled, broadcastDispatch: config.broadcastDispatchEnabled, providerDomainManagement: config.providerDomainManagementEnabled, providerResubscribe: config.providerResubscribeEnabled },
  provider: config.provider,
  providerKeyPresent: providerConfigured(config),
  webhookSecretPresent: Boolean(config.resend.webhookSecret),
  domainAllowlist: config.domainAllowlist,
  reservedSenders: config.reservedSenders,
  mixedRecipientMode: config.mixedRecipients.mode,
  storage: config.storage.provider,
  kms: config.kms.provider,
  scanner: config.scanning.provider,
  violations: problems,
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exit(problems.length ? 1 : 0);
