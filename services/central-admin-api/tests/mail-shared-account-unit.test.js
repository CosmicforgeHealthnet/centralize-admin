"use strict";

// Offline unit tests for the shared-Resend-account guards (one account, one
// key and one webhook for CA staging, CA production and KarryGo).

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMailConfig, infrastructureViolations, publicStatus } = require("../src/modules/mail/mail.config");
const { recipientApproved, unapprovedRecipients, withProviderTags, eventTags, taggedForOtherDeployment } = require("../src/modules/mail/security/shared-account");
const { withTransportContract, withMarketingContract } = require("../src/modules/mail/adapters/provider-contract");
const { createResendAdapter } = require("../src/modules/mail/adapters/resend.adapter");
const { createFakeAdapter } = require("../src/modules/mail/adapters/fake.adapter");
const { createFakeMarketingAdapter } = require("../src/modules/mail/adapters/marketing/fake-marketing.adapter");

const STAGING = { MAIL_DEPLOYMENT_ENV: "staging", MAIL_PROVIDER: "resend", MAIL_DOMAIN_ALLOWLIST: "karryam.com", RESEND_WEBHOOK_SECRET: "whsec_test", MAIL_ENABLED: "true" };
const send = (to, extra = {}) => ({ idempotencyKey: "outbound:1:0", from: { address: "support@karryam.com", name: "Karryam Support" }, to: to.map((address) => ({ address })), subject: "s", text: "t", ...extra });

test("config: allowlist and inbound ownership parsing", () => {
  const config = loadMailConfig({ ...STAGING, MAIL_TEST_RECIPIENT_ALLOWLIST: " QA@Gmail.example ,@approved.example, other.example, not valid@@", MAIL_INBOUND_ACTIVE_ENVIRONMENT: "Staging" });
  assert.deepEqual(config.testRecipients.addresses, ["qa@gmail.example"]);
  assert.deepEqual(config.testRecipients.domains, ["approved.example", "other.example"]);
  assert.equal(config.testRecipients.invalid.length, 1);
  assert.deepEqual([config.inbound.activeEnvironment, config.inbound.ownedHere], ["staging", true]);
  assert.deepEqual(config.providerTags, { app: "cosmicforge-mail", environment: "staging" });
  assert.equal(loadMailConfig({ ...STAGING, MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production" }).inbound.ownedHere, false);
  assert.equal(loadMailConfig(STAGING).inbound.ownedHere, true, "undeclared = this deployment (dev/test only; staging/production must declare it to receive)");
  const status = publicStatus(config);
  assert.equal(status.testRecipientAllowlist, 3);
  assert.deepEqual(status.inbound, { activeEnvironment: "staging", ownedHere: true });
});

test("config: staging must declare a test allowlist to send and an inbound owner to receive", () => {
  const sending = infrastructureViolations(loadMailConfig({ ...STAGING, MAIL_SENDING_ENABLED: "true" }));
  assert.ok(sending.includes("staging requires MAIL_TEST_RECIPIENT_ALLOWLIST when sending is enabled"));
  const receiving = infrastructureViolations(loadMailConfig({ ...STAGING, MAIL_RECEIVING_ENABLED: "true" }));
  assert.ok(receiving.includes("staging requires MAIL_INBOUND_ACTIVE_ENVIRONMENT when receiving is enabled"));
  const productionReceiving = infrastructureViolations(loadMailConfig({ ...STAGING, MAIL_DEPLOYMENT_ENV: "production", MAIL_RECEIVING_ENABLED: "true" }));
  assert.ok(productionReceiving.includes("production requires MAIL_INBOUND_ACTIVE_ENVIRONMENT when receiving is enabled"));
  const ok = infrastructureViolations(loadMailConfig({ ...STAGING, MAIL_SENDING_ENABLED: "true", MAIL_RECEIVING_ENABLED: "true", MAIL_TEST_RECIPIENT_ALLOWLIST: "@approved.example", MAIL_INBOUND_ACTIVE_ENVIRONMENT: "staging" }));
  assert.ok(!ok.some((problem) => /ALLOWLIST|INBOUND_ACTIVE/.test(problem)), JSON.stringify(ok));
  assert.ok(infrastructureViolations(loadMailConfig({ ...STAGING, MAIL_INBOUND_ACTIVE_ENVIRONMENT: "prod" })).includes("MAIL_INBOUND_ACTIVE_ENVIRONMENT must be development, test, staging or production"));
  assert.ok(infrastructureViolations(loadMailConfig({ ...STAGING, MAIL_TEST_RECIPIENT_ALLOWLIST: "x@@y" })).some((problem) => problem.startsWith("MAIL_TEST_RECIPIENT_ALLOWLIST has 1 invalid")));
});

test("helpers: allowlist matching, tag merging and event tag parsing", () => {
  const policy = loadMailConfig({ MAIL_TEST_RECIPIENT_ALLOWLIST: "qa@gmail.example,@approved.example" }).testRecipients;
  assert.equal(recipientApproved(policy, "QA@gmail.example"), true);
  assert.equal(recipientApproved(policy, "x@approved.example"), true);
  assert.equal(recipientApproved(policy, "x@sub.approved.example"), false, "exact domains only");
  assert.equal(recipientApproved(policy, "rider@gmail.example"), false);
  assert.equal(recipientApproved({ active: false }, "anyone@anywhere.example"), true);
  assert.deepEqual(unapprovedRecipients(policy, { to: [{ address: "qa@gmail.example" }], cc: [{ address: "boss@corp.example" }], bcc: [{ address: "hidden@corp.example" }] }), ["boss@corp.example", "hidden@corp.example"]);
  const tagged = withProviderTags({ tags: [{ name: "category", value: "support" }, { name: "cf_env", value: "forged" }] }, { app: "cosmicforge-mail", environment: "staging" });
  assert.deepEqual(tagged.tags, [{ name: "category", value: "support" }, { name: "cf_app", value: "cosmicforge-mail" }, { name: "cf_env", value: "staging" }]);
  assert.deepEqual(eventTags({ tags: [{ name: "a", value: 1 }] }), { a: "1" });
  assert.deepEqual(eventTags({ tags: "nonsense" }), {});
  const ours = { app: "cosmicforge-mail", environment: "staging" };
  assert.equal(taggedForOtherDeployment({ tags: { cf_app: "cosmicforge-mail", cf_env: "production" } }, ours), true);
  assert.equal(taggedForOtherDeployment({ tags: { cf_app: "cosmicforge-mail", cf_env: "staging" } }, ours), false);
  assert.equal(taggedForOtherDeployment({ tags: { cf_env: "production" } }, ours), false, "only CA's own app tag counts");
  assert.equal(taggedForOtherDeployment({}, ours), false);
});

test("provider contract: refuses unapproved recipients before any call and tags every send", async () => {
  const fake = createFakeAdapter();
  const policy = loadMailConfig({ MAIL_TEST_RECIPIENT_ALLOWLIST: "@approved.example" }).testRecipients;
  const provider = withTransportContract(fake, { recipientPolicy: policy, providerTags: { app: "cosmicforge-mail", environment: "staging" } });
  await assert.rejects(provider.sendMessage(send(["qa@approved.example"], { bcc: [{ address: "leak@customer.example" }] })), (error) => error.code === "RECIPIENT_NOT_APPROVED" && error.kind === "PERMANENT" && error.category === "VALIDATION_FAILED");
  assert.equal(fake.state.sent.length, 0, "nothing reached the provider");
  await provider.sendMessage(send(["qa@approved.example"]));
  assert.deepEqual(fake.state.sent[0].tags, [{ name: "cf_app", value: "cosmicforge-mail" }, { name: "cf_env", value: "staging" }]);
  // No policy: unchanged behaviour (production).
  const open = withTransportContract(createFakeAdapter(), {});
  await open.sendMessage(send(["anyone@customer.example"]));
});

test("marketing contract: broadcasts and unapproved audience contacts are blocked under a test allowlist", async () => {
  const policy = loadMailConfig({ MAIL_TEST_RECIPIENT_ALLOWLIST: "@approved.example" }).testRecipients;
  const marketing = withMarketingContract(createFakeMarketingAdapter(), { recipientPolicy: policy, providerTags: { app: "cosmicforge-mail", environment: "staging" } });
  await assert.rejects(marketing.sendBroadcast("bc_1"), (error) => error.code === "BROADCAST_BLOCKED_BY_TEST_ALLOWLIST");
  await assert.rejects(marketing.syncAudience({ segmentId: "seg_1", add: [{ email: "real@customer.example", consentVerified: true }] }), (error) => error.code === "RECIPIENT_NOT_APPROVED");
  await assert.rejects(marketing.sendEmail(send(["real@customer.example"])), (error) => error.code === "RECIPIENT_NOT_APPROVED");
});

test("Resend adapter: request tags are sent in the /emails body", async () => {
  const calls = [];
  const adapter = createResendAdapter({
    config: { resend: { apiKey: "re_test_offline", baseUrl: "https://api.resend.test", timeoutMs: 2000, attachmentHostAllowlist: [] } },
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ id: "re_1" }) };
    },
  });
  await adapter.sendMessage(send(["qa@approved.example"], { tags: [{ name: "cf_app", value: "cosmicforge-mail" }, { name: "cf_env", value: "staging" }] }));
  assert.deepEqual(calls[0].tags, [{ name: "cf_app", value: "cosmicforge-mail" }, { name: "cf_env", value: "staging" }]);
  await adapter.sendMessage(send(["qa@approved.example"]));
  assert.equal(calls[1].tags, undefined, "no empty tags array");
});
