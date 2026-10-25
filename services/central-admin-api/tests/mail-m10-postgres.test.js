"use strict";

// CosmicForge Mail M10 (rollout) on real PostgreSQL: enforcement default
// deny, cohort onboarding/offboarding, step-up-gated widening, DENY
// precedence, worker queue gating, database emergency stops (immediate
// activation, step-up release), product-integration rollout and the
// progressive readiness gates.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp } = require("./helpers/mail-test-harness");
const { signServiceRequest } = require("../src/modules/mail/integrations/service-auth");
const { closeServer } = require("./helpers/server-close");

const SERVICE_SECRET = "karryam-rollout-secret-0123456789abcdef";

test("CosmicForge Mail M10 rollout controls on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client, {
    env: {
      MAIL_ROLLOUT_ENFORCED: "true",
      MAIL_INTEGRATIONS_ENABLED: "true",
      MAIL_INTEGRATION_HASH_SECRET: crypto.randomBytes(32).toString("hex"),
      MAIL_INTEGRATION_SERVICE_SECRETS: `karryam-notification-service=${SERVICE_SECRET}`,
    },
  });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const kg = brands.karryam;
  const { server, origin, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  const worker = harness.mail.createWorker({ queues: ["OUTBOUND", "EVENTS"] });
  const work = async (rounds = 3) => {
    for (let index = 0; index < rounds; index += 1) {
      harness.advance(6000); // past the 5s rule cache
      await worker.drain({ maxTicks: 20 });
    }
  };
  const stepUp = async (purpose) => {
    harness.advance(31000);
    const response = await call("ops", "POST", "/security/step-up", { code: totp(harness.clock), purpose });
    assert.equal(response.status, 201, response.text);
    return response.body.data.stepUpId;
  };
  const rule = (input, stepUpId) => call("ops", "POST", "/admin/rollout/rules", { reason: "Pilot rollout (test)", ...input, ...(stepUpId ? { stepUpId } : {}) });
  const mailboxFor = async (key, localPart) => {
    const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids[key], address: { domainId: cf.domain.id, localPart } });
    assert.equal(box.status, 201, box.text);
    return box.body.data.id;
  };
  const send = async (key, mailboxId, to = "pilot@partner.example") => {
    const draft = await call(key, "POST", `/mailboxes/${mailboxId}/drafts`, { to: [to], subject: "Pilot", text: "hello" });
    assert.equal(draft.status, 201, draft.text);
    return call(key, "POST", `/drafts/${draft.body.data.id}/send`, { revision: draft.body.data.revision });
  };
  const state = {};

  try {
    await t.test("enforced with no rules: external sends are refused and workers stay idle", async () => {
      state.daveBox = await mailboxFor("dave", "dave");
      state.erinBox = await mailboxFor("erin", "erin");
      const overview = await call("ops", "GET", "/admin/rollout");
      assert.equal(overview.body.data.enforced, true);
      assert.equal(overview.body.data.rules.length, 0);
      const refused = await send("dave", state.daveBox);
      assert.equal(refused.status, 403, refused.text);
      assert.match(refused.text, /MAIL_ROLLOUT_NOT_ENABLED/);
      // Internal-only mail is not gated by the external rollout.
      const internal = await send("dave", state.daveBox, "erin@cosmicforge.example");
      assert.equal(internal.status, 202, internal.text);
      assert.equal((await call("dave", "GET", "/admin/rollout")).status, 403, "mail admins only");
    });

    await t.test("onboarding: cohort + step-up-gated ALLOW rule enables only cohort members", async () => {
      const cohort = await call("ops", "POST", "/admin/rollout/cohorts", { key: "pilot-wave-1", name: "Pilot wave 1" });
      assert.equal(cohort.status, 201, cohort.text);
      state.cohortId = cohort.body.data.id;
      assert.equal((await call("ops", "POST", `/admin/rollout/cohorts/${state.cohortId}/members`, { adminUserId: ids.dave })).status, 201);
      assert.equal((await call("ops", "POST", `/admin/rollout/cohorts/${state.cohortId}/members`, { adminUserId: ids.dave })).status, 400, "no duplicate membership");
      const noStepUp = await rule({ capability: "STAFF_MAIL", scopeType: "COHORT", scopeId: state.cohortId, effect: "ALLOW" });
      assert.equal(noStepUp.status, 403, "widening exposure needs a step-up");
      assert.equal((await rule({ capability: "WORKER_OUTBOUND", scopeType: "ORGANIZATION", scopeId: cf.organization.id, effect: "ALLOW" }, await stepUp("MAIL_ROLLOUT_CHANGE"))).status, 400, "worker rules are environment-wide");
      const allowed = await rule({ capability: "STAFF_MAIL", scopeType: "COHORT", scopeId: state.cohortId, effect: "ALLOW" }, await stepUp("MAIL_ROLLOUT_CHANGE"));
      assert.equal(allowed.status, 201, allowed.text);
      state.allowRuleId = allowed.body.data.id;
      const daveSend = await send("dave", state.daveBox);
      assert.equal(daveSend.status, 202, daveSend.text);
      state.queuedMessageId = daveSend.body.data.messageId;
      assert.equal((await send("erin", state.erinBox)).status, 403, "non-members are still refused");
      const pilot = await call("ops", "GET", `/admin/rollout/pilot/${ids.dave}`);
      assert.equal(pilot.body.data.decisions.STAFF_MAIL, "ALLOWED");
      assert.deepEqual(pilot.body.data.cohorts, ["pilot-wave-1"]);
      assert.equal(pilot.body.data.mfaEnrolled, true);
      assert.equal(pilot.body.data.ready, true);
    });

    await t.test("worker queues need their own environment rules", async () => {
      await work();
      let recipient = await client.mailMessageRecipient.findFirst({ where: { messageId: state.queuedMessageId } });
      assert.equal(recipient.status, "PENDING", "no WORKER_OUTBOUND rule: the job is not claimed");
      for (const capability of ["WORKER_OUTBOUND", "WORKER_EVENTS"]) {
        assert.equal((await rule({ capability, scopeType: "ENVIRONMENT", effect: "ALLOW" }, await stepUp("MAIL_ROLLOUT_CHANGE"))).status, 201);
      }
      await work();
      recipient = await client.mailMessageRecipient.findFirst({ where: { messageId: state.queuedMessageId } });
      assert.equal(recipient.status, "PROVIDER_ACCEPTED");
    });

    await t.test("DENY beats ALLOW; revoking a DENY needs a step-up; offboarding revokes access", async () => {
      const deny = await rule({ capability: "STAFF_MAIL", scopeType: "MAILBOX", scopeId: state.daveBox, effect: "DENY" });
      assert.equal(deny.status, 201, "narrowing needs no step-up");
      const denied = await send("dave", state.daveBox);
      assert.equal(denied.status, 403);
      assert.match(denied.text, /MAIL_ROLLOUT_DENIED/);
      assert.equal((await call("ops", "POST", `/admin/rollout/rules/${deny.body.data.id}/revoke`, {})).status, 403, "un-denying widens exposure");
      assert.equal((await call("ops", "POST", `/admin/rollout/rules/${deny.body.data.id}/revoke`, { stepUpId: await stepUp("MAIL_ROLLOUT_CHANGE") })).status, 200);
      assert.equal((await send("dave", state.daveBox)).status, 202);
      const off = await call("ops", "DELETE", `/admin/rollout/cohorts/${state.cohortId}/members/${ids.dave}`);
      assert.equal(off.status, 200);
      const after = await send("dave", state.daveBox);
      assert.equal(after.status, 403, "offboarded members lose access immediately");
      assert.equal((await call("ops", "GET", `/admin/rollout/pilot/${ids.dave}`)).body.data.ready, false);
      await call("ops", "POST", `/admin/rollout/cohorts/${state.cohortId}/members`, { adminUserId: ids.dave });
      const audit = await client.mailAuditEvent.findMany({ where: { action: { in: ["MAIL_PILOT_MEMBER_ONBOARDED", "MAIL_PILOT_MEMBER_OFFBOARDED", "MAIL_ROLLOUT_RULE_CREATED", "MAIL_ROLLOUT_RULE_REVOKED"] } } });
      assert.ok(audit.length >= 7);
    });

    await t.test("database emergency stop: immediate, held mail resumes, release needs a step-up", async () => {
      await work(1); // drain anything already queued
      const queued = await send("dave", state.daveBox, "held@partner.example");
      assert.equal(queued.status, 202);
      const stop = await call("ops", "POST", "/admin/emergency-stops", { scope: "ALL", reason: "Suspected account compromise (test)" });
      assert.equal(stop.status, 201, stop.text);
      assert.equal((await call("ops", "POST", "/admin/emergency-stops", { scope: "ALL", reason: "duplicate stop" })).status, 400, "one active stop per scope");
      const refused = await send("dave", state.daveBox);
      assert.equal(refused.status, 503, "takes effect at once in the API that set it");
      assert.match(refused.text, /MAIL_EMERGENCY_STOP/);
      await work(2);
      const held = await client.mailMessage.findUnique({ where: { id: queued.body.data.messageId }, include: { recipients: true, outboxJobs: true } });
      assert.equal(held.recipients[0].status, "PENDING");
      assert.equal(held.outboxJobs[0].lastErrorCode, "MAIL_EMERGENCY_STOP");
      const snapshot = await call("ops", "GET", "/admin/ops/snapshot");
      assert.equal(snapshot.body.data.runtimeHalt.staffMail, "MAIL_EMERGENCY_STOP");
      assert.equal((await call("ops", "POST", `/admin/emergency-stops/${stop.body.data.id}/release`, {})).status, 403);
      assert.equal((await call("dave", "POST", `/admin/emergency-stops/${stop.body.data.id}/release`, {})).status, 403);
      const released = await call("ops", "POST", `/admin/emergency-stops/${stop.body.data.id}/release`, { stepUpId: await stepUp("MAIL_EMERGENCY_STOP_RELEASE") });
      assert.equal(released.status, 200, released.text);
      harness.advance(301000);
      await work(2);
      assert.equal((await client.mailMessageRecipient.findFirst({ where: { messageId: queued.body.data.messageId } })).status, "PROVIDER_ACCEPTED");
      // An organization stop only affects that brand.
      const orgStop = await call("ops", "POST", "/admin/emergency-stops", { scope: "ORGANIZATION", organizationId: kg.organization.id, reason: "Karryam brand incident (test)" });
      assert.equal(orgStop.status, 201);
      assert.equal((await send("dave", state.daveBox)).status, 202, "CosmicForge unaffected");
    });

    await t.test("product integrations need a PRODUCT_INTEGRATION rule even when active", async () => {
      await client.mailProductIntegration.create({ data: { product: "karryam", serviceName: "karryam-notification-service", organizationId: kg.organization.id, status: "ACTIVE", allowedEventTypes: ["ops.alert"], ownerApprovalReference: "KG-1", ownerApprovedBy: "Owner", approvedAt: harness.clock(), createdBy: ids.super, updatedBy: ids.super } });
      const PATH = "/api/mail/v1/integrations/v1/events";
      const post = async () => {
        const body = JSON.stringify({ contractVersion: 1, product: "karryam", organization: "karryam", eventId: `e-${crypto.randomUUID()}`, eventType: "ops.alert", eventVersion: 1, occurredAt: harness.clock().toISOString(), data: { severity: "info", code: "PING", summary: "rollout check", component: "outbox" } });
        const headers = signServiceRequest({ method: "POST", requestUri: PATH, body, serviceName: "karryam-notification-service", secret: SERVICE_SECRET, now: harness.clock().getTime() });
        const response = await fetch(`${origin}${PATH}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
        return { status: response.status, body: await response.json() };
      };
      const blocked = await post();
      assert.equal(blocked.status, 503);
      assert.equal(blocked.body.code, "MAIL_ROLLOUT_NOT_ENABLED");
      assert.equal(blocked.body.retryable, true, "products retry later; nothing is lost");
      assert.equal((await rule({ capability: "PRODUCT_INTEGRATION", scopeType: "ORGANIZATION", scopeId: kg.organization.id, effect: "ALLOW" }, await stepUp("MAIL_ROLLOUT_CHANGE"))).status, 201);
      assert.equal((await post()).status, 202);
    });

    await t.test("readiness gates report automated PASS/FAIL and leave manual sign-offs MANUAL", async () => {
      const readiness = await call("ops", "GET", "/admin/rollout/readiness");
      assert.equal(readiness.status, 200, readiness.text);
      const stage = (id) => readiness.body.data.stages.find((entry) => entry.id === id);
      const gate = (stageId, gateId) => stage(stageId).gates.find((entry) => entry.id === gateId);
      assert.equal(gate("S1_PILOT", "enforced").status, "PASS");
      assert.equal(gate("S1_PILOT", "cohort").status, "PASS");
      assert.equal(gate("S1_PILOT", "cohort-rule").status, "PASS");
      assert.equal(gate("S1_PILOT", "dns").status, "MANUAL");
      assert.equal(gate("S0_STAGING", "metrics").status, "FAIL", "no metrics token in this environment");
      assert.equal(gate("S2_BRAND", "bounce").status, "FAIL", "not enough sample yet");
      assert.ok(readiness.body.data.stages.every((entry) => entry.manualPending >= 1));
      assert.equal((await call("dave", "GET", "/admin/rollout/readiness")).status, 403);
    });
  } finally {
    await closeServer(server);
    await db.close();
  }
});
