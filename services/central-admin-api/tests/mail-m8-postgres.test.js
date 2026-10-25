"use strict";

// CosmicForge Mail M8 (product integration) on real PostgreSQL. A mock
// Karryam Go consumer and a mock HealthNet ops service call the real HQ
// ingestion route with Karryam-compatible service HMAC signatures.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp } = require("./helpers/mail-test-harness");
const { signServiceRequest } = require("../src/modules/mail/integrations/service-auth");
const { closeServer } = require("./helpers/server-close");

const SECRETS = { karryam: "karryam-test-secret-0123456789abcdef", healthnet: "healthnet-test-secret-0123456789abcd", rogue: "rogue-secret-0123456789abcdef0123" };
const ENV = {
  MAIL_INTEGRATIONS_ENABLED: "true",
  MAIL_INTEGRATION_HASH_SECRET: crypto.randomBytes(32).toString("hex"),
  MAIL_INTEGRATION_SERVICE_SECRETS: `karryam-notification-service=${SECRETS.karryam},healthnet-ops-service=${SECRETS.healthnet},rogue-service=${SECRETS.rogue}`,
};

test("CosmicForge Mail M8 product integration on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client, { env: ENV });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const { server, origin, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  const kg = brands.karryam;
  const cf = brands.cosmicforge;
  const healthnetOrg = await client.mailOrganization.create({ data: { slug: "healthnet", name: "CosmicForge HealthNet", kind: "BRAND", createdBy: ids.super } });
  const healthnetDomain = await client.mailDomain.create({ data: { organizationId: healthnetOrg.id, domain: "healthnet.example", status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "NOT_CONFIGURED" } });
  const kgSystem = await client.mailAddress.create({ data: { organizationId: kg.organization.id, domainId: kg.domain.id, localPart: "noreply", address: "noreply@karryam.example", kind: "SYSTEM", status: "ACTIVE" } });
  const hnSystem = await client.mailAddress.create({ data: { organizationId: healthnetOrg.id, domainId: healthnetDomain.id, localPart: "ops", address: "ops@healthnet.example", kind: "SYSTEM", status: "ACTIVE" } });
  const viewer = crypto.randomUUID();
  await client.adminUser.create({ data: { id: viewer, email: "kg-owner@staff.example.invalid", password: "x", name: "Karryam owner", tier: "EMPLOYEE", status: "ACTIVE", mustChangePassword: false } });
  await client.adminSectionGrant.create({ data: { adminUserId: viewer, module: "mail", section: "integration:karryam", mode: "VIEW", grantedBy: ids.super } });
  ids.kgOwner = viewer;

  const stepUp = async (key, purpose) => {
    harness.advance(31000);
    const response = await call(key, "POST", "/security/step-up", { code: totp(harness.clock), purpose });
    assert.equal(response.status, 201, response.text);
    return response.body.data.stepUpId;
  };
  const PATH = "/api/mail/v1/integrations/v1/events";
  const send = async (serviceName, secret, payload, { rawOverride, nowOffset = 0, tamper = false } = {}) => {
    const body = rawOverride ?? JSON.stringify(payload);
    const headers = signServiceRequest({ method: "POST", requestUri: PATH, body, serviceName, secret, now: harness.clock().getTime() + nowOffset });
    if (tamper) headers["X-Service-Signature"] = headers["X-Service-Signature"].replace(/^./, (char) => (char === "a" ? "b" : "a"));
    const response = await fetch(`${origin}${PATH}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const envelope = (overrides = {}, data = {}) => ({
    contractVersion: 1, product: "karryam", organization: "karryam", eventId: `evt-${crypto.randomUUID()}`, eventType: "mail.delivery_status", eventVersion: 1,
    correlationId: "booking-123", occurredAt: harness.clock().toISOString(),
    data: { productMessageId: `msg-${crypto.randomUUID().slice(0, 8)}`, provider: "resend", providerMessageId: "re_123", sender: "noreply@karryam.example", recipient: "Rider@Example.com", status: "DELIVERED", category: "booking_confirmation", ...data },
    ...overrides,
  });
  const karryam = (payload, options) => send("karryam-notification-service", SECRETS.karryam, payload, options);
  const healthnet = (payload, options) => send("healthnet-ops-service", SECRETS.healthnet, payload, options);

  let kgId;
  let hnId;
  try {
    await t.test("administration: registration, HealthNet restrictions, sender authorization, MFA-gated activation", async () => {
      assert.equal((await call("dave", "GET", "/admin/integrations")).status, 403, "not a mail admin");
      const created = await call("ops", "POST", "/admin/integrations", { product: "karryam", serviceName: "karryam-notification-service", organizationId: kg.organization.id, allowedEventTypes: ["mail.delivery_status", "marketing.trigger", "ops.alert"], allowedTriggerTypes: ["karryam.booking.completed@1"] });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.body.data.status, "DISABLED");
      assert.equal(created.body.data.credentialConfigured, true);
      assert.equal(JSON.stringify(created.body).includes(SECRETS.karryam), false, "secrets are never returned");
      kgId = created.body.data.id;
      assert.equal((await call("ops", "POST", "/admin/integrations", { product: "healthnet", serviceName: "healthnet-ops-service", organizationId: healthnetOrg.id, classification: "STANDARD", allowedEventTypes: ["ops.alert"] })).body.errors[0].reason, "HEALTHNET_MUST_BE_RESTRICTED");
      assert.equal((await call("ops", "POST", "/admin/integrations", { product: "healthnet", serviceName: "healthnet-ops-service", organizationId: healthnetOrg.id, allowedEventTypes: ["ops.alert", "mail.delivery_status"] })).status, 400, "HealthNet: ops alerts only");
      assert.equal((await call("ops", "POST", "/admin/integrations", { product: "healthnet", serviceName: "healthnet-ops-service", organizationId: healthnetOrg.id, allowedEventTypes: ["ops.alert", "marketing.trigger"], allowedTriggerTypes: ["karryam.booking.completed@1"] })).status, 400);
      const hn = await call("ops", "POST", "/admin/integrations", { product: "healthnet", serviceName: "healthnet-ops-service", organizationId: healthnetOrg.id, allowedEventTypes: ["ops.alert"] });
      assert.equal(hn.status, 201, hn.text);
      assert.equal(hn.body.data.classification, "RESTRICTED_HEALTH");
      hnId = hn.body.data.id;
      // The database enforces the HealthNet restriction even if code is bypassed.
      await assert.rejects(client.$executeRawUnsafe(`UPDATE mail_product_integrations SET allowed_event_types = ARRAY['ops.alert','mail.delivery_status'] WHERE id = '${hnId}'`), /CHK_mail_product_integrations_restricted_health/);
      await assert.rejects(client.$executeRawUnsafe(`UPDATE mail_product_integrations SET status = 'ACTIVE' WHERE id = '${kgId}'`), /CHK_mail_product_integrations_active_approved/, "no activation without owner approval");

      // Senders: own brand system identities only; HealthNet only for alerts.
      assert.equal((await call("ops", "POST", `/admin/integrations/${kgId}/senders`, { addressId: cf.sender.id, purpose: "TRANSACTIONAL" })).status, 403, "another brand's identity");
      assert.equal((await call("ops", "POST", `/admin/integrations/${kgId}/senders`, { addressId: kgSystem.id, purpose: "TRANSACTIONAL" })).status, 201);
      assert.equal((await call("ops", "POST", `/admin/integrations/${hnId}/senders`, { addressId: hnSystem.id, purpose: "TRANSACTIONAL" })).status, 400);

      // Events are refused until activated.
      assert.equal((await karryam(envelope())).status, 403);
      assert.equal((await call("ops", "POST", `/admin/integrations/${kgId}/activate`, { ownerApprovalReference: "KG-OWNER-2026-11", ownerApprovedBy: "Karryam Go platform owner" })).body.code, "MAIL_STEP_UP_REQUIRED");
      assert.equal((await call("ops", "POST", `/admin/integrations/${kgId}/activate`, { stepUpId: "x" })).status, 400, "owner approval required");
      const activated = await call("ops", "POST", `/admin/integrations/${kgId}/activate`, { ownerApprovalReference: "KG-OWNER-2026-11", ownerApprovedBy: "Karryam Go platform owner", stepUpId: await stepUp("ops", "MAIL_INTEGRATION_ACTIVATE") });
      assert.equal(activated.status, 200, activated.text);
      assert.equal(activated.body.data.status, "ACTIVE");
      assert.equal((await call("ops", "POST", `/admin/integrations/${hnId}/activate`, { ownerApprovalReference: "HN-SEC-REVIEW-7", ownerApprovedBy: "HealthNet service owner + legal", stepUpId: await stepUp("ops", "MAIL_INTEGRATION_ACTIVATE") })).status, 200);
    });

    await t.test("authentication: Karryam-compatible HMAC, skew, unknown and rogue services", async () => {
      assert.equal((await karryam(envelope(), { tamper: true })).status, 401);
      assert.equal((await karryam(envelope(), { nowOffset: -10 * 60000 })).status, 401, "expired timestamp");
      assert.equal((await send("unknown-service", "whatever-secret-0123456789abcdef", envelope())).status, 401);
      assert.equal((await send("rogue-service", SECRETS.rogue, envelope())).status, 401, "a configured secret without a registered integration is refused");
      assert.equal((await send("karryam-notification-service", SECRETS.healthnet, envelope())).status, 401, "wrong secret");
      const unsigned = await fetch(`${origin}${PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope()) });
      assert.equal(unsigned.status, 401);
    });

    await t.test("delivery metadata: accepted, idempotent, minimal (hashed recipients), sender-enforced, spoof-proof", async () => {
      const event = envelope();
      const accepted = await karryam(event);
      assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
      assert.equal(accepted.body.data.duplicate, false);
      const duplicate = await karryam(event);
      assert.equal(duplicate.body.data.duplicate, true);
      const conflict = await karryam({ ...event, data: { ...event.data, status: "BOUNCED" } });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, "MAIL_INTEGRATION_EVENT_CONFLICT");
      assert.equal(conflict.body.retryable, false);
      const row = await client.mailProductDeliveryEvent.findFirst({ where: { integrationId: kgId } });
      assert.equal(row.recipientDomain, "example.com");
      assert.match(row.recipientHash, /^[0-9a-f]{64}$/);
      const dump = JSON.stringify(await client.$queryRawUnsafe(`SELECT row_to_json(t)::text AS r FROM (SELECT * FROM mail_product_delivery_events UNION ALL SELECT * FROM mail_product_delivery_events) t`));
      assert.equal(/rider@example\.com/i.test(dump), false, "the recipient address is never stored");
      const eventsDump = JSON.stringify(await client.mailProductIntegrationEvent.findMany());
      assert.equal(/rider@example\.com/i.test(eventsDump), false);
      // Keyed per brand: the same address hashes differently for another brand.
      const hashA = harness.mail.services.integrations.recipientHash(kg.organization.id, "rider@example.com");
      const hashB = harness.mail.services.integrations.recipientHash(cf.organization.id, "rider@example.com");
      assert.equal(row.recipientHash, hashA);
      assert.notEqual(hashA, hashB);

      // Spoofing another product or brand.
      assert.equal((await karryam(envelope({ product: "healthnet" }))).body.code, "MAIL_INTEGRATION_SCOPE_MISMATCH");
      assert.equal((await karryam(envelope({ organization: "cosmicforge" }))).body.code, "MAIL_INTEGRATION_SCOPE_MISMATCH");
      // Unauthorised / revoked senders.
      assert.equal((await karryam(envelope({}, { sender: "news@cosmicforge.example" }))).body.code, "MAIL_SENDER_NOT_AUTHORIZED");
      const senders = await call("ops", "GET", `/admin/integrations/${kgId}/senders`);
      await call("ops", "DELETE", `/admin/integrations/${kgId}/senders/${senders.body.data[0].id}`);
      assert.equal((await karryam(envelope())).body.code, "MAIL_SENDER_NOT_AUTHORIZED", "revocation is immediate");
      assert.equal((await call("ops", "POST", `/admin/integrations/${kgId}/senders`, { addressId: kgSystem.id, purpose: "TRANSACTIONAL" })).status, 201);
    });

    await t.test("contract enforcement: versions, unknown fields and prohibited content fail closed", async () => {
      assert.equal((await karryam({ ...envelope(), contractVersion: 2 })).body.code, "MAIL_INTEGRATION_UNSUPPORTED_VERSION");
      assert.equal((await karryam({ ...envelope(), eventVersion: 9 })).body.code, "MAIL_INTEGRATION_UNSUPPORTED_VERSION");
      assert.equal((await karryam({ ...envelope(), eventType: "mail.send" })).body.code, "MAIL_INTEGRATION_UNSUPPORTED_EVENT", "HQ never sends product mail");
      assert.equal((await karryam({ ...envelope(), extra: 1 })).body.code, "MAIL_INTEGRATION_UNKNOWN_FIELDS");
      assert.equal((await karryam(envelope({}, { subject: "Your ride" }))).body.code, "MAIL_INTEGRATION_FORBIDDEN_CONTENT", "no message content");
      assert.equal((await karryam(envelope({}, { html: "<p>x</p>" }))).body.code, "MAIL_INTEGRATION_FORBIDDEN_CONTENT");
      assert.equal((await karryam(envelope({}, { patientId: "p1" }))).body.code, "MAIL_INTEGRATION_FORBIDDEN_CONTENT");
      assert.equal((await karryam(envelope({}, { status: "OPENED" }))).status, 422);
      assert.equal((await karryam(null, { rawOverride: "{not json" })).body.code, "MAIL_VALIDATION_FAILED");
      const health = await call("ops", "GET", `/admin/integrations/${kgId}/health`);
      assert.ok(health.body.data.rejections7d.some((entry) => entry.code === "MAIL_INTEGRATION_FORBIDDEN_CONTENT"), "rejections are visible in health");
      const rejected = await client.mailProductIntegrationEvent.findMany({ where: { integrationId: kgId, status: "REJECTED" } });
      assert.equal(/<p>x<\/p>|p1|Your ride/.test(JSON.stringify(rejected)), false, "rejected payload content is not stored");
    });

    await t.test("marketing triggers and bounces: approved triggers only, never consent; bounces protect only existing contacts", async () => {
      const contact = await client.marketingContact.create({ data: { organizationId: kg.organization.id, email: "rider@example.com", source: "manual", createdBy: ids.kim } });
      await client.marketingConsent.create({ data: { contactId: contact.id, organizationId: kg.organization.id, topic: "offers", status: "GRANTED", source: "WEB_FORM", sourceEvidence: { reference: "kg-form" }, policyVersion: "1", consentedAt: harness.clock() } });
      const trigger = await karryam(envelope({ eventType: "marketing.trigger" }, undefined));
      assert.equal(trigger.status, 422, "trigger needs its own data shape");
      const ok = await karryam({ ...envelope({ eventType: "marketing.trigger" }), data: { triggerType: "karryam.booking.completed", triggerVersion: 1, contactEmail: "rider@example.com", attributes: { service: "ride", gps: "6.5,3.3" } } });
      assert.equal(ok.status, 202, JSON.stringify(ok.body));
      const stored = await client.marketingTriggerEvent.findFirst({ where: { organizationId: kg.organization.id } });
      assert.deepEqual(stored.payload, { service: "ride" }, "attributes minimised to the approved fields");
      assert.equal(stored.contactId, contact.id);
      const notAllowed = await karryam({ ...envelope({ eventType: "marketing.trigger" }), data: { triggerType: "karryam.account.registered", triggerVersion: 1, contactEmail: "rider@example.com" } });
      assert.equal(notAllowed.status, 403, "approved globally but not for this integration");
      // Bounce: suppress for the existing contact; a non-contact leaves no trace.
      assert.equal((await karryam(envelope({}, { status: "BOUNCED", recipient: "rider@example.com" }))).status, 202);
      assert.equal((await client.marketingConsent.findFirst({ where: { contactId: contact.id } })).status, "WITHDRAWN");
      assert.ok(await client.marketingSuppression.findFirst({ where: { organizationId: kg.organization.id, email: "rider@example.com", reason: "BOUNCED" } }));
      assert.equal((await karryam(envelope({}, { status: "COMPLAINED", recipient: "stranger@example.org" }))).status, 202);
      assert.equal(await client.marketingSuppression.count({ where: { email: "stranger@example.org" } }), 0);
      assert.equal(await client.marketingSuppression.count({ where: { organizationId: cf.organization.id, email: "rider@example.com" } }), 0, "other brands are unaffected");
    });

    await t.test("HealthNet: operational alerts only, no personal or clinical data, no cross-product claims", async () => {
      const alert = (data, overrides = {}) => ({ contractVersion: 1, product: "healthnet", organization: "healthnet", eventId: `hn-${crypto.randomUUID()}`, eventType: "ops.alert", eventVersion: 1, occurredAt: harness.clock().toISOString(), data, ...overrides });
      const okAlert = await healthnet(alert({ severity: "warning", code: "QUEUE_BACKLOG", summary: "Notification queue above threshold", component: "notification-worker" }));
      assert.equal(okAlert.status, 202, JSON.stringify(okAlert.body));
      const notified = await client.notification.count({ where: { title: { contains: "QUEUE_BACKLOG" } } });
      assert.ok(notified >= 1, "mail admins are notified");
      assert.equal((await healthnet(alert({ severity: "warning", code: "QUEUE_BACKLOG", summary: "again", component: "notification-worker" }))).status, 202);
      assert.equal(await client.notification.count({ where: { title: { contains: "QUEUE_BACKLOG" } } }), notified, "the same alert code is not re-notified within an hour");
      assert.equal((await healthnet(alert({ severity: "critical", code: "DELIVERY_FAILED", summary: "Failed for jane@patient.example", component: "mailer" }))).body.code, "MAIL_INTEGRATION_FORBIDDEN_CONTENT");
      assert.equal((await healthnet(alert({ severity: "critical", code: "DELIVERY_FAILED", summary: "Patient 12345678 not notified", component: "mailer" }))).body.code, "MAIL_INTEGRATION_FORBIDDEN_CONTENT");
      assert.equal((await healthnet(alert({ severity: "info", code: "X_CODE", summary: "ok", component: "a", diagnosis: "flu" }))).body.code, "MAIL_INTEGRATION_FORBIDDEN_CONTENT");
      const delivery = envelope({ product: "healthnet", organization: "healthnet" }, { sender: "ops@healthnet.example", recipient: "patient@example.com" });
      assert.equal((await healthnet(delivery)).status, 403, "HealthNet never sends delivery metadata with recipients");
      assert.equal((await healthnet({ ...alert({ severity: "info", code: "X_CODE", summary: "ok", component: "a" }), eventType: "marketing.trigger", data: { triggerType: "karryam.booking.completed", triggerVersion: 1, contactEmail: "patient@example.com" } })).status, 403);
      assert.equal((await healthnet(alert({ severity: "info", code: "X_CODE", summary: "ok", component: "a" }, { product: "karryam", organization: "karryam" }))).body.code, "MAIL_INTEGRATION_SCOPE_MISMATCH");
    });

    await t.test("product isolation: owners see only their integration; evidence is append-only", async () => {
      const list = await call("kgOwner", "GET", "/admin/integrations");
      assert.deepEqual(list.body.data.map((entry) => entry.product), ["karryam"]);
      const health = await call("kgOwner", "GET", `/admin/integrations/${kgId}/health`);
      assert.equal(health.status, 200);
      assert.ok(health.body.data.delivery7d.DELIVERED >= 1);
      assert.equal(/rider@example\.com/i.test(JSON.stringify(health.body)), false);
      assert.equal((await call("kgOwner", "GET", `/admin/integrations/${hnId}/health`)).status, 404, "another product's integration is invisible");
      assert.equal((await call("kgOwner", "GET", `/admin/integrations/${hnId}/events`)).status, 404);
      assert.equal((await call("kgOwner", "POST", `/admin/integrations/${kgId}/suspend`, {})).status, 403, "view grants cannot change integrations");
      assert.equal((await call("dave", "GET", `/admin/integrations/${kgId}/health`)).status, 404);
      await assert.rejects(client.$executeRawUnsafe(`UPDATE mail_product_delivery_events SET status = 'FAILED'`), /immutable/);
      await assert.rejects(client.$executeRawUnsafe(`DELETE FROM mail_product_integration_events`), /approved retention purge/);
      const purged = await client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL cosmicforge.mail_retention_purge = 'on'");
        return tx.$executeRawUnsafe(`DELETE FROM mail_product_integration_events WHERE status = 'REJECTED' AND integration_id = '${hnId}'`);
      });
      assert.ok(purged >= 1, "an explicit retention purge may delete");
    });

    await t.test("operational controls: suspension, disabled flag, rate limits and HQ outage isolation", async () => {
      const suspended = await call("ops", "POST", `/admin/integrations/${hnId}/suspend`, { reason: "rotation" });
      assert.equal(suspended.body.data.status, "SUSPENDED");
      assert.equal((await healthnet({ contractVersion: 1, product: "healthnet", organization: "healthnet", eventId: "hn-x", eventType: "ops.alert", eventVersion: 1, occurredAt: harness.clock().toISOString(), data: { severity: "info", code: "X_CODE", summary: "ok", component: "a" } })).body.code, "MAIL_INTEGRATION_NOT_ACTIVE");
      const disabled = harness.build({ MAIL_INTEGRATIONS_ENABLED: "false" });
      const disabledServer = await listen(harness.mountApp(disabled));
      const body = JSON.stringify(envelope());
      const response = await fetch(`${disabledServer.origin}${PATH}`, { method: "POST", headers: { "content-type": "application/json", ...signServiceRequest({ method: "POST", requestUri: PATH, body, serviceName: "karryam-notification-service", secret: SECRETS.karryam, now: harness.clock().getTime() }) }, body });
      const disabledBody = await response.json();
      assert.equal(response.status, 503);
      assert.equal(disabledBody.retryable, true, "products retry from their own outbox later");
      await closeServer(disabledServer.server);
      const limited = harness.build({ MAIL_INTEGRATION_RATE_PER_MINUTE: "10" });
      const limitedServer = await listen(harness.mountApp(limited));
      let last;
      for (let index = 0; index < 11; index += 1) {
        const payload = JSON.stringify(envelope());
        last = await fetch(`${limitedServer.origin}${PATH}`, { method: "POST", headers: { "content-type": "application/json", ...signServiceRequest({ method: "POST", requestUri: PATH, body: payload, serviceName: "karryam-notification-service", secret: SECRETS.karryam, now: harness.clock().getTime() }) }, body: payload });
      }
      assert.equal(last.status, 429);
      await closeServer(limitedServer.server);
    });
  } finally {
    await closeServer(server);
    await db.close();
  }
});
