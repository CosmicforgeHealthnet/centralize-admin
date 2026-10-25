#!/usr/bin/env node
"use strict";

// Offline check of the Mail storage / KMS / scanner configuration rules for the
// current environment (no network calls). Exits 1 when the configuration would
// be refused at runtime.
//   MAIL_DEPLOYMENT_ENV=production npm run mail:config:validate

require("dotenv").config();
const { loadMailConfig, infrastructureViolations } = require("../../src/modules/mail/mail.config");

const config = loadMailConfig(process.env);
const problems = infrastructureViolations(config);
const summary = { deploymentEnvironment: config.deploymentEnvironment, mailEnabled: config.enabled, storage: config.storage.provider, kms: config.kms.provider, scanner: config.scanning.provider, violations: problems };
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exit(problems.length ? 1 : 0);
