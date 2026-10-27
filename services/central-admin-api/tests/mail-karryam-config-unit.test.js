"use strict";

// Offline checks for the Karryam staging profile: safe defaults, staged flag
// activation, readiness without Resend credentials and the reserved-sender
// list (MAIL_RESERVED_SENDER_ADDRESSES). No database, no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMailConfig, infrastructureViolations, addressPolicyViolations, providerConfigured, publicStatus } = require("../src/modules/mail/mail.config");
const { parseReservedSenders, reservedSenderSet, isReservedSender, eventSenderAddress } = require("../src/modules/mail/security/reserved-senders");
const { externalSendBlockReason } = require("../src/modules/mail/authz/sending-gate");
const { createDependencyReadiness } = require("../src/modules/mail/ops/dependency-readiness");
const { createResendWebhookHandler } = require("../src/modules/mail/webhooks/resend-webhook.controller");
const { parseArgs } = require("../scripts/mail/provision-karryam");

// The documented starting profile (docs/cosmicforge-mail-karryam-resend-activation.md).
const STAGING_PROFILE = Object.freeze({
  MAIL_DEPLOYMENT_ENV: "staging",
  MAIL_PROVIDER: "resend",
  MAIL_PROVIDER_ENVIRONMENT_TAG: "staging",
  MAIL_DOMAIN_ALLOWLIST: "karryam.com",
  MAIL_RESERVED_SENDER_ADDRESSES: "no-reply@karryam.com",
  MAIL_ENABLED: "false",
  MAIL_SENDING_ENABLED: "false",
  MAIL_RECEIVING_ENABLED: "false",
  MAIL_WORKER_ENABLED: "false",
  MAIL_MARKETING_ENABLED: "false",
  MAIL_PROVIDER_DOMAIN_MANAGEMENT_ENABLED: "false",
  MAIL_MIXED_RECIPIENT_MODE: "external-only",
  MAIL_MARKETING_PROVIDER_RESUBSCRIBE_ENABLED: "false",
  RESEND_API_KEY: "",
  RESEND_WEBHOOK_SECRET: "",
});

const karryamDomain = { domain: "karryam.com", status: "VERIFIED", sendingStatus: "VERIFIED", organization: { slug: "karryam" } };

test("reserved senders: parsed, normalised, de-duplicated; invalid entries reported", () => {
  const parsed = parseReservedSenders(" No-Reply@Karryam.com ,no-reply@karryam.com, not an address ,,noreply@karryam.com");
  assert.deepEqual(parsed.addresses, ["no-reply@karryam.com", "noreply@karryam.com"]);
  assert.deepEqual(parsed.invalid, ["not an address"]);
  assert.equal(reservedSenderSet({ MAIL_RESERVED_SENDER_ADDRESSES: "no-reply@karryam.com" }).has("no-reply@karryam.com"), true);
  assert.equal(reservedSenderSet({ reservedSenders: ["a@b.co"] }).has("a@b.co"), true);
  assert.equal(isReservedSender("NO-REPLY@karryam.com", ["no-reply@karryam.com"]), true);
  assert.equal(isReservedSender("support@karryam.com", ["no-reply@karryam.com"]), false);
  assert.equal(eventSenderAddress('"Karryam" <No-Reply@Karryam.com>'), "no-reply@karryam.com");
  assert.equal(eventSenderAddress(["Karryam <no-reply@karryam.com>"]), "no-reply@karryam.com");
  assert.equal(eventSenderAddress(null), null);
  const config = loadMailConfig({ ...STAGING_PROFILE, MAIL_RESERVED_SENDER_ADDRESSES: "no-reply@karryam.com,bad@@x,ops@healthnet.example" });
  assert.deepEqual(addressPolicyViolations(config), [
    "MAIL_RESERVED_SENDER_ADDRESSES has 1 invalid entry",
    "MAIL_RESERVED_SENDER_ADDRESSES entry ops@healthnet.example is not on a MAIL_DOMAIN_ALLOWLIST domain",
  ]);
});

test("16/17: the staging profile deploys with every capability off and no violations", () => {
  const config = loadMailConfig(STAGING_PROFILE);
  assert.equal(config.deploymentEnvironment, "staging");
  for (const key of ["enabled", "sendingEnabled", "receivingEnabled", "workerEnabled", "marketingEnabled", "broadcastDispatchEnabled", "automationEnabled", "providerDomainManagementEnabled", "providerResubscribeEnabled"]) assert.equal(config[key], false, key);
  assert.equal(config.mixedRecipients.mode, "external-only");
  assert.deepEqual(config.domainAllowlist, ["karryam.com"]);
  assert.deepEqual(config.reservedSenders, ["no-reply@karryam.com"]);
  assert.deepEqual(infrastructureViolations(config), []);
  assert.deepEqual(addressPolicyViolations(config), []);
  assert.equal(providerConfigured(config), false);
  assert.equal(publicStatus(config).reservedSenders, 1);
  assert.equal(externalSendBlockReason({ config, providerReady: () => providerConfigured(config), domain: karryamDomain }), "MAIL_SENDING_DISABLED");
});

test("17: a sub-flag never turns anything on while MAIL_ENABLED is off", () => {
  const config = loadMailConfig({ ...STAGING_PROFILE, MAIL_SENDING_ENABLED: "true", MAIL_RECEIVING_ENABLED: "true", MAIL_WORKER_ENABLED: "true", MAIL_MARKETING_ENABLED: "true", MAIL_BROADCAST_DISPATCH_ENABLED: "true" });
  for (const key of ["sendingEnabled", "receivingEnabled", "workerEnabled", "marketingEnabled", "broadcastDispatchEnabled"]) assert.equal(config[key], false, key);
});

test("16: staging with sending/receiving on but no Resend credentials is refused and never sends", async () => {
  const config = loadMailConfig({ ...STAGING_PROFILE, MAIL_ENABLED: "true", MAIL_SENDING_ENABLED: "true", MAIL_RECEIVING_ENABLED: "true" });
  assert.ok(infrastructureViolations(config).includes("staging requires RESEND_WEBHOOK_SECRET when sending or receiving is enabled"));
  assert.equal(externalSendBlockReason({ config, providerReady: () => providerConfigured(config), domain: karryamDomain }), "MAIL_PROVIDER_NOT_CONFIGURED");
  const readiness = createDependencyReadiness({
    config,
    schema: { check: async () => ({ ready: true }) },
    encryption: { available: true },
    storage: { health: async () => ({ ok: true }) },
    scanner: { available: true, health: async () => ({ ok: true }) },
    provider: { healthProbe: async () => ({ state: "NOT_CONFIGURED" }) },
    jobs: { stats: async () => [] },
    infrastructureViolations,
  });
  const report = await readiness.evaluate();
  assert.equal(report.ready, false);
  assert.equal(report.state, "NOT_READY");
  assert.equal(report.dependencies.webhooks, "NOT_CONFIGURED");
  assert.equal(report.dependencies.infrastructure, "MISCONFIGURED");
  // Mail off: honest DISABLED, never "ready".
  const off = await createDependencyReadiness({ config: loadMailConfig(STAGING_PROFILE), schema: {}, encryption: { available: false }, storage: {}, scanner: { available: false }, provider: {}, jobs: {}, infrastructureViolations }).evaluate();
  assert.deepEqual([off.ready, off.state, off.dependencies.provider, off.dependencies.webhooks], [false, "DISABLED", "NOT_CONFIGURED", "NOT_CONFIGURED"]);
  // A staging key tagged for another environment is refused.
  assert.ok(infrastructureViolations(loadMailConfig({ ...STAGING_PROFILE, MAIL_PROVIDER_ENVIRONMENT_TAG: "production" })).some((problem) => problem.includes("does not match the staging deployment")));
});

test("11/16: the webhook endpoint answers 503 (provider retries later) while Mail is off", async () => {
  const handler = createResendWebhookHandler({ client: null, config: loadMailConfig(STAGING_PROFILE), jobs: null, audit: null, logger: null });
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ headers: {}, rawBody: Buffer.from("{}"), params: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "MAIL_DISABLED");
});

test("18: the provisioning CLI is dry-run by default and needs an actor to apply", () => {
  assert.deepEqual(parseArgs([]), { apply: false, actor: null, allowRemote: false, orgKind: null });
  assert.throws(() => parseArgs(["--apply"]), /--actor/);
  assert.deepEqual(parseArgs(["--apply", "--actor=abc", "--org-kind=company", "--allow-remote"]), { apply: true, actor: "abc", allowRemote: true, orgKind: "COMPANY" });
  assert.throws(() => parseArgs(["--org-kind=PERSONAL"]), /BRAND or COMPANY/);
  assert.throws(() => parseArgs(["--delete"]), /Unknown argument/);
});
