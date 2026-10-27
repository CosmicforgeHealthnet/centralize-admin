"use strict";

// §18 staging proof: provider identity guards in infrastructureViolations
// (no fake provider in staging/production, webhook secret + domain allowlist
// for live capabilities, optional provider environment marker).

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMailConfig, infrastructureViolations } = require("../src/modules/mail/mail.config");

const stagingOk = {
  MAIL_ENABLED: "true",
  MAIL_SENDING_ENABLED: "true",
  MAIL_RECEIVING_ENABLED: "true",
  MAIL_DEPLOYMENT_ENV: "staging",
  // Shared Resend account: staging sends only to approved test recipients
  // and declares which deployment owns inbound mail.
  MAIL_TEST_RECIPIENT_ALLOWLIST: "@approved.example",
  MAIL_INBOUND_ACTIVE_ENVIRONMENT: "staging",
  MAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_test_not_a_real_key_value",
  RESEND_WEBHOOK_SECRET: "whsec_dGVzdA==",
  MAIL_DOMAIN_ALLOWLIST: "cosmicforge.example",
  MAIL_STORAGE_PROVIDER: "s3",
  MAIL_S3_BUCKET: "cf-mail-staging",
  MAIL_S3_ENDPOINT: "https://s3.example",
};
const providerProblems = (env) => infrastructureViolations(loadMailConfig(env)).filter((problem) => /PROVIDER|WEBHOOK|ALLOWLIST|ENVIRONMENT_TAG/.test(problem));

test("staging/production provider identity guards", () => {
  assert.deepEqual(providerProblems(stagingOk), []);
  assert.ok(providerProblems({ ...stagingOk, MAIL_PROVIDER: "fake" }).some((p) => /refuses MAIL_PROVIDER=fake/.test(p)));
  assert.ok(providerProblems({ ...stagingOk, MAIL_DEPLOYMENT_ENV: "production", MAIL_PROVIDER: "fake" }).some((p) => /production refuses MAIL_PROVIDER=fake/.test(p)));
  // Undeclared environment + NODE_ENV=production is production.
  assert.ok(providerProblems({ ...stagingOk, MAIL_DEPLOYMENT_ENV: "", NODE_ENV: "production", MAIL_PROVIDER: "fake" }).some((p) => /production refuses/.test(p)));
  assert.ok(providerProblems({ ...stagingOk, RESEND_WEBHOOK_SECRET: "" }).some((p) => /RESEND_WEBHOOK_SECRET/.test(p)));
  assert.ok(providerProblems({ ...stagingOk, MAIL_SENDING_ENABLED: "false" , RESEND_WEBHOOK_SECRET: "" }).some((p) => /RESEND_WEBHOOK_SECRET/.test(p)), "receiving alone needs it too");
  assert.ok(providerProblems({ ...stagingOk, MAIL_DOMAIN_ALLOWLIST: "" }).some((p) => /MAIL_DOMAIN_ALLOWLIST/.test(p)));
  // Mail enabled but no live capability: nothing to guard yet.
  assert.deepEqual(providerProblems({ ...stagingOk, MAIL_SENDING_ENABLED: "false", MAIL_RECEIVING_ENABLED: "false", RESEND_WEBHOOK_SECRET: "", MAIL_DOMAIN_ALLOWLIST: "" }), []);
  // Development / test keep the offline fake.
  assert.deepEqual(providerProblems({ ...stagingOk, MAIL_DEPLOYMENT_ENV: "test", MAIL_PROVIDER: "fake", RESEND_WEBHOOK_SECRET: "", MAIL_DOMAIN_ALLOWLIST: "" }), []);
});

test("optional provider environment marker must match the deployment", () => {
  assert.deepEqual(providerProblems({ ...stagingOk, MAIL_PROVIDER_ENVIRONMENT_TAG: "staging" }), []);
  assert.deepEqual(providerProblems({ ...stagingOk, RESEND_API_KEY_ENVIRONMENT: "STAGING" }), []);
  const mismatch = providerProblems({ ...stagingOk, RESEND_API_KEY_ENVIRONMENT: "production" });
  assert.equal(mismatch.length, 1);
  assert.match(mismatch[0], /does not match the staging deployment/);
  assert.ok(!mismatch[0].includes(stagingOk.RESEND_API_KEY), "key values are never echoed");
  assert.ok(providerProblems({ ...stagingOk, MAIL_DEPLOYMENT_ENV: "development", MAIL_PROVIDER_ENVIRONMENT_TAG: "production" }).length === 1);
});

test("provider domain management flag defaults off and needs Mail enabled", () => {
  assert.equal(loadMailConfig({}).providerDomainManagementEnabled, false);
  assert.equal(loadMailConfig({ MAIL_PROVIDER_DOMAIN_MANAGEMENT_ENABLED: "true" }).providerDomainManagementEnabled, false);
  assert.equal(loadMailConfig({ MAIL_ENABLED: "true", MAIL_PROVIDER_DOMAIN_MANAGEMENT_ENABLED: "true" }).providerDomainManagementEnabled, true);
});
