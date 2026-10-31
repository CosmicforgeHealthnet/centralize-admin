"use strict";

// M10 unit tests (no database, no network): rollout decisions.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMailConfig } = require("../src/modules/mail/mail.config");
const { createRolloutService } = require("../src/modules/mail/ops/rollout.service");

function stubClient({ rules = [], stops = [], members = [], addresses = {} } = {}) {
  return {
    mailRolloutRule: { findMany: async () => rules },
    mailEmergencyStop: { findMany: async () => stops },
    mailRolloutCohortMember: { findMany: async ({ where }) => members.filter((m) => m.adminUserId === where.adminUserId).map((m) => ({ cohortId: m.cohortId })) },
    mailAddress: { findUnique: async ({ where }) => (addresses[where.id] ? { domainId: addresses[where.id] } : null) },
  };
}
const rule = (capability, scopeType, scopeId, effect = "ALLOW") => ({ capability, scopeType, scopeId, effect });

test("enforcement defaults ON only in production; MAIL_ROLLOUT_ENFORCED overrides", () => {
  assert.equal(loadMailConfig({ NODE_ENV: "production" }).rollout.enforced, true);
  assert.equal(loadMailConfig({ MAIL_DEPLOYMENT_ENV: "production" }).rollout.enforced, true);
  assert.equal(loadMailConfig({ MAIL_DEPLOYMENT_ENV: "staging" }).rollout.enforced, false);
  assert.equal(loadMailConfig({ NODE_ENV: "test" }).rollout.enforced, false);
  assert.equal(loadMailConfig({ MAIL_DEPLOYMENT_ENV: "staging", MAIL_ROLLOUT_ENFORCED: "true" }).rollout.enforced, true);
  assert.equal(loadMailConfig({ NODE_ENV: "production", MAIL_ROLLOUT_ENFORCED: "false" }).rollout.enforced, false);
});

test("rollout decisions: default deny, scope matching, DENY precedence, cohorts, domains", async () => {
  const config = loadMailConfig({ MAIL_ROLLOUT_ENFORCED: "true" });
  const make = (data) => createRolloutService({ client: stubClient(data), config, audit: {}, stepUp: {} });
  assert.equal(await make({}).decide("STAFF_MAIL", {}), "MAIL_ROLLOUT_NOT_ENABLED");
  assert.equal(await make({ rules: [rule("STAFF_MAIL", "ENVIRONMENT", null)] }).decide("STAFF_MAIL", {}), null);
  assert.equal(await make({ rules: [rule("STAFF_MAIL", "ENVIRONMENT", null)] }).decide("SUPPORT", {}), "MAIL_ROLLOUT_NOT_ENABLED", "capabilities are independent");
  const org = make({ rules: [rule("STAFF_MAIL", "ORGANIZATION", "o1")] });
  assert.equal(await org.decide("STAFF_MAIL", { organizationId: "o1" }), null);
  assert.equal(await org.decide("STAFF_MAIL", { organizationId: "o2" }), "MAIL_ROLLOUT_NOT_ENABLED");
  const deny = make({ rules: [rule("STAFF_MAIL", "ENVIRONMENT", null), rule("STAFF_MAIL", "MAILBOX", "m1", "DENY")] });
  assert.equal(await deny.decide("STAFF_MAIL", { mailboxId: "m1" }), "MAIL_ROLLOUT_DENIED");
  assert.equal(await deny.decide("STAFF_MAIL", { mailboxId: "m2" }), null);
  const cohort = make({ rules: [rule("STAFF_MAIL", "COHORT", "c1")], members: [{ adminUserId: "u1", cohortId: "c1" }] });
  assert.equal(await cohort.decide("STAFF_MAIL", { adminUserId: "u1" }), null);
  assert.equal(await cohort.decide("STAFF_MAIL", { adminUserId: "u2" }), "MAIL_ROLLOUT_NOT_ENABLED");
  const domain = make({ rules: [rule("STAFF_MAIL", "DOMAIN", "d1")], addresses: { a1: "d1", a2: "d2" } });
  assert.equal(await domain.decide("STAFF_MAIL", { senderAddressId: "a1" }), null, "domain resolved from the sender address");
  assert.equal(await domain.decide("STAFF_MAIL", { senderAddressId: "a2" }), "MAIL_ROLLOUT_NOT_ENABLED");
  assert.deepEqual(await make({ rules: [rule("WORKER_OUTBOUND", "ENVIRONMENT", null)] }).workerQueuesAllowed(["OUTBOUND", "MARKETING"]), [], "a rollout rule never overrides disabled backend Mail flags");
});

test("core Mail workers follow backend flags and resume without UI rollout permissions", async () => {
  const config = loadMailConfig({
    NODE_ENV: "production", MAIL_ENABLED: "true", MAIL_WORKER_ENABLED: "true",
    MAIL_SENDING_ENABLED: "true", MAIL_RECEIVING_ENABLED: "true",
    MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production", MAIL_ROLLOUT_ENFORCED: "true",
  });
  const make = (rules = [], cfg = config) => createRolloutService({ client: stubClient({ rules }), config: cfg, audit: {}, stepUp: {} });
  assert.deepEqual(await make().workerQueuesAllowed(["OUTBOUND", "INBOUND", "EVENTS", "MARKETING"]), ["OUTBOUND", "INBOUND", "EVENTS"]);
  assert.deepEqual(await make([rule("WORKER_INBOUND", "ENVIRONMENT", null, "DENY")]).workerQueuesAllowed(["OUTBOUND", "INBOUND", "EVENTS"]), ["OUTBOUND", "EVENTS"], "explicit operator DENY is respected");
  const receiveOff = loadMailConfig({ NODE_ENV: "production", MAIL_ENABLED: "true", MAIL_WORKER_ENABLED: "true", MAIL_SENDING_ENABLED: "true", MAIL_RECEIVING_ENABLED: "false", MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production" });
  assert.deepEqual(await make([], receiveOff).workerQueuesAllowed(["OUTBOUND", "INBOUND", "EVENTS"]), ["OUTBOUND", "EVENTS"]);
  const wrongOwner = loadMailConfig({ NODE_ENV: "production", MAIL_ENABLED: "true", MAIL_WORKER_ENABLED: "true", MAIL_SENDING_ENABLED: "true", MAIL_RECEIVING_ENABLED: "true", MAIL_INBOUND_ACTIVE_ENVIRONMENT: "staging" });
  assert.deepEqual(await make([], wrongOwner).workerQueuesAllowed(["OUTBOUND", "INBOUND", "EVENTS"]), ["OUTBOUND", "EVENTS"]);
  const sendingOff = loadMailConfig({ NODE_ENV: "production", MAIL_ENABLED: "true", MAIL_WORKER_ENABLED: "true", MAIL_SENDING_ENABLED: "false", MAIL_RECEIVING_ENABLED: "true", MAIL_INBOUND_ACTIVE_ENVIRONMENT: "production" });
  assert.deepEqual(await make([], sendingOff).workerQueuesAllowed(["OUTBOUND", "INBOUND", "EVENTS"]), ["INBOUND", "EVENTS"]);
  assert.deepEqual(await make([rule("WORKER_MARKETING", "ENVIRONMENT", null)]).workerQueuesAllowed(["INBOUND", "MARKETING"]), ["INBOUND", "MARKETING"], "marketing rollout remains opt-in");
});

test("emergency stops apply even without enforcement and only to their scope", async () => {
  const config = loadMailConfig({});
  const make = (stops) => createRolloutService({ client: stubClient({ stops }), config, audit: {}, stepUp: {} });
  assert.equal(await make([]).decide("STAFF_MAIL", {}), null, "not enforced: allowed");
  assert.equal(await make([{ scope: "ALL" }]).decide("STAFF_MAIL", {}), "MAIL_EMERGENCY_STOP");
  assert.equal(await make([{ scope: "MARKETING" }]).decide("STAFF_MAIL", {}), null);
  assert.equal(await make([{ scope: "MARKETING" }]).decide("MARKETING_AUTOMATION", {}), "MAIL_EMERGENCY_STOP");
  assert.equal(await make([{ scope: "ORGANIZATION", organizationId: "o1" }]).decide("SUPPORT", { organizationId: "o1" }), "MAIL_EMERGENCY_STOP");
  assert.equal(await make([{ scope: "ORGANIZATION", organizationId: "o1" }]).decide("SUPPORT", { organizationId: "o2" }), null);
  assert.equal(await make([{ scope: "ALL" }]).decide("PRODUCT_INTEGRATION", {}), null, "stops halt sending, not product event ingestion");
});
