"use strict";

// CF Meet (product "cfmeet") ops.alert registration for HQ Mail (no database,
// no network): the product registration, admin-side validation, ingestion
// limits and who receives the alert notification.
// Design: docs/product-admin/cfmeet-admin-design.md section 7 (Mail integration).

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { signServiceRequest } = require("../src/modules/mail/integrations/service-auth");
const { createIntegrationService, EVENT_TYPES_FOR } = require("../src/modules/mail/integrations/integration.service");
const registry = require("../src/modules/mail/integrations/event-registry");

const PATH = "/api/mail/v1/integrations/v1/events";
const NOW = 1763510400000; // fixed clock for signatures and grant expiry
const SECRET = "cfmeet-test-secret-0123456789abcdef";
const KARRYAM_SECRET = "karryam-test-secret-0123456789abcdef";
const ORG = { cfmeet: { id: crypto.randomUUID(), slug: "cfmeet", name: "CF Meet" }, karryam: { id: crypto.randomUUID(), slug: "karryam", name: "Karryam" } };

function integrationRow(product, overrides = {}) {
  return { id: crypto.randomUUID(), product, serviceName: `${product}-admin`, organizationId: ORG[product].id, classification: "STANDARD", status: "ACTIVE", allowedEventTypes: ["ops.alert"], allowedTriggerTypes: [], ...overrides };
}

function harness({ integrations = [], grants = [] } = {}) {
  const notified = [];
  const stored = [];
  const created = [];
  const audits = [];
  const grantQueries = [];
  const client = {
    mailProductIntegration: {
      findUnique: async ({ where }) => integrations.find((row) => row.serviceName === where.serviceName || row.id === where.id) || null,
      update: async ({ data }) => data,
      create: async ({ data }) => {
        const row = { id: crypto.randomUUID(), status: "DRAFT", ...data };
        created.push(row);
        return row;
      },
    },
    mailOrganization: { findUnique: async ({ where }) => Object.values(ORG).find((org) => org.id === where.id) || null },
    mailProductIntegrationEvent: {
      count: async () => 0,
      findUnique: async () => null,
      create: async ({ data }) => {
        stored.push(data);
        return data;
      },
    },
    adminSectionGrant: {
      findMany: async ({ where }) => {
        grantQueries.push(where);
        const now = new Date(NOW);
        return grants
          .filter((grant) => grant.module === where.module && where.section.in.includes(grant.section) && grant.revokedAt == null)
          .filter((grant) => !where.OR || grant.expiresAt == null || grant.expiresAt > now)
          .map((grant) => ({ adminUserId: grant.adminUserId }));
      },
    },
    $transaction: async (fn) => fn(client),
  };
  const config = { enabled: true, integrations: { enabled: true, hashSecret: "h".repeat(48), maxBodyBytes: 65536, maxSkewSeconds: 300, ratePerMinute: 100 }, restrictedHealth: { organizations: ["healthnet"] } };
  const service = createIntegrationService({
    client,
    config,
    audit: { record: async (entry) => audits.push(entry) },
    stepUp: { consume: async () => {} },
    automations: { ingestProductEvent: async () => ({ matchedContact: false, droppedFields: [] }) },
    notifications: { notifyUsers: async (ids, payload) => notified.push({ ids: [...ids].sort(), payload }) },
    env: { MAIL_INTEGRATION_SERVICE_SECRETS: `cfmeet-admin=${SECRET},karryam-admin=${KARRYAM_SECRET}` },
    clock: () => new Date(NOW),
  });
  return { service, notified, stored, created, audits, grantQueries };
}

function signedRequest(product, eventType, data, secret = SECRET) {
  const body = JSON.stringify({ contractVersion: 1, product, organization: product, eventId: `evt-${crypto.randomUUID()}`, eventType, eventVersion: 1, occurredAt: new Date(NOW).toISOString(), data });
  const headers = Object.fromEntries(Object.entries(signServiceRequest({ method: "POST", requestUri: PATH, body, serviceName: `${product}-admin`, secret, now: NOW })).map(([key, value]) => [key.toLowerCase(), value]));
  return { method: "POST", originalUrl: PATH, headers, rawBody: Buffer.from(body), ip: "127.0.0.1" };
}

const ALERT = { severity: "critical", code: "BRIDGE_UNREACHABLE", summary: "cfmeet bridge unreachable for 5m", component: "cfmeet-admin" };
const SUPER = { id: crypto.randomUUID(), status: "ACTIVE", tier: "SUPER" };

test("registry: cfmeet is registered for ops.alert only; karryam and unregistered products unchanged", () => {
  assert.deepEqual(registry.registeredProductEventTypes("cfmeet"), ["ops.alert"]);
  assert.deepEqual(registry.registeredProductEventTypes("karryam"), EVENT_TYPES_FOR.STANDARD, "karryam keeps every STANDARD event type");
  assert.equal(registry.registeredProductEventTypes("someproduct"), null);
  assert.equal(registry.registeredProductEventTypes("__proto__"), null, "no prototype lookups");
  assert.equal(registry.productAllowsEventType("cfmeet", "ops.alert"), true);
  assert.equal(registry.productAllowsEventType("cfmeet", "mail.delivery_status"), false);
  assert.equal(registry.productAllowsEventType("cfmeet", "marketing.trigger"), false);
  assert.equal(registry.productAllowsEventType("someproduct", "mail.delivery_status"), true, "unregistered products keep the generic rules");
  assert.deepEqual(registry.opsAlertRecipientSections("cfmeet"), ["admin", "integration:cfmeet"]);
  assert.ok(Object.isFrozen(registry.PRODUCT_EVENT_REGISTRATIONS) && Object.isFrozen(registry.PRODUCT_EVENT_REGISTRATIONS.cfmeet));
});

test("admin: a cfmeet integration may be created for ops.alert, and for nothing else", async () => {
  const { service, created } = harness();
  const ok = await service.create(SUPER, { product: "cfmeet", serviceName: "cfmeet-admin", organizationId: ORG.cfmeet.id, allowedEventTypes: ["ops.alert"] }, {});
  assert.equal(ok.product, "cfmeet");
  assert.deepEqual(created[0].allowedEventTypes, ["ops.alert"]);
  assert.equal(created[0].classification, "STANDARD");
  for (const events of [["mail.delivery_status"], ["ops.alert", "marketing.trigger"]]) {
    await assert.rejects(
      service.create(SUPER, { product: "cfmeet", serviceName: "cfmeet-admin-2", organizationId: ORG.cfmeet.id, allowedEventTypes: events }, {}),
      (error) => error.code === "MAIL_VALIDATION_FAILED" && error.errors[0].reason === "EVENT_TYPE_NOT_REGISTERED_FOR_PRODUCT",
      JSON.stringify(events),
    );
  }
  // Karryam keeps all three event types (non-regression).
  const karryam = await service.create(SUPER, { product: "karryam", serviceName: "karryam-notification-service", organizationId: ORG.karryam.id, allowedEventTypes: ["mail.delivery_status", "marketing.trigger", "ops.alert"] }, {});
  assert.equal(karryam.product, "karryam");
  // Only Mail administrators can register an integration.
  await assert.rejects(service.create({ id: crypto.randomUUID(), status: "ACTIVE", tier: "EMPLOYEE" }, { product: "cfmeet", serviceName: "cfmeet-admin-3", organizationId: ORG.cfmeet.id, allowedEventTypes: ["ops.alert"] }, {}), (error) => error.code === "MAIL_FORBIDDEN");
});

test("ingest: a cfmeet ops.alert notifies Mail admins and mail / integration:cfmeet holders only", async () => {
  const admin = crypto.randomUUID();
  const cfmeetOwner = crypto.randomUUID();
  const karryamOwner = crypto.randomUUID();
  const revoked = crypto.randomUUID();
  const expired = crypto.randomUUID();
  const otherModule = crypto.randomUUID();
  const grants = [
    { adminUserId: admin, module: "mail", section: "admin", revokedAt: null, expiresAt: null },
    { adminUserId: cfmeetOwner, module: "mail", section: "integration:cfmeet", revokedAt: null, expiresAt: new Date(NOW + 3600000) },
    { adminUserId: karryamOwner, module: "mail", section: "integration:karryam", revokedAt: null, expiresAt: null },
    { adminUserId: revoked, module: "mail", section: "integration:cfmeet", revokedAt: new Date(NOW - 1000), expiresAt: null },
    { adminUserId: expired, module: "mail", section: "integration:cfmeet", revokedAt: null, expiresAt: new Date(NOW - 1000) },
    { adminUserId: otherModule, module: "hrm", section: "integration:cfmeet", revokedAt: null, expiresAt: null },
  ];
  const { service, notified, stored, grantQueries } = harness({ integrations: [integrationRow("cfmeet")], grants });
  const result = await service.ingest(signedRequest("cfmeet", "ops.alert", ALERT));
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(result.body.data.outcome.kind, "ops_alert");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, "ACCEPTED");
  assert.deepEqual(grantQueries[0].section.in, ["admin", "integration:cfmeet"]);
  assert.equal(notified.length, 1);
  assert.deepEqual(notified[0].ids, [admin, cfmeetOwner].sort());
  assert.equal(notified[0].payload.title, "[cfmeet] critical: BRIDGE_UNREACHABLE");
});

test("ingest: a cfmeet integration can never deliver events outside its registration", async () => {
  // Even a (legacy or hand-edited) row that lists mail.delivery_status is refused.
  const row = integrationRow("cfmeet", { allowedEventTypes: ["ops.alert", "mail.delivery_status"] });
  const { service, notified, stored } = harness({ integrations: [row] });
  const result = await service.ingest(signedRequest("cfmeet", "mail.delivery_status", { productMessageId: "m-1", provider: "resend", sender: "noreply@cfmeet.example", recipient: "user@example.com", status: "DELIVERED", category: "invite" }));
  assert.equal(result.status, 403);
  assert.equal(result.body.code, "MAIL_INTEGRATION_FORBIDDEN_CONTENT");
  assert.deepEqual(notified, []);
  assert.ok(stored.every((entry) => entry.status === "REJECTED"));
});

test("ingest: cfmeet cannot speak for Karryam, and a Karryam alert never reaches cfmeet-only staff", async () => {
  const cfmeetOwner = crypto.randomUUID();
  const karryamOwner = crypto.randomUUID();
  const grants = [
    { adminUserId: cfmeetOwner, module: "mail", section: "integration:cfmeet", revokedAt: null, expiresAt: null },
    { adminUserId: karryamOwner, module: "mail", section: "integration:karryam", revokedAt: null, expiresAt: null },
  ];
  const { service, notified } = harness({ integrations: [integrationRow("cfmeet"), integrationRow("karryam")], grants });
  // Signed by the cfmeet service but claiming product karryam -> scope mismatch.
  const spoof = signedRequest("karryam", "ops.alert", ALERT);
  const cfmeetSigned = signServiceRequest({ method: "POST", requestUri: PATH, body: spoof.rawBody.toString("utf8"), serviceName: "cfmeet-admin", secret: SECRET, now: NOW });
  spoof.headers = Object.fromEntries(Object.entries(cfmeetSigned).map(([key, value]) => [key.toLowerCase(), value]));
  const refused = await service.ingest(spoof);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "MAIL_INTEGRATION_SCOPE_MISMATCH");
  assert.deepEqual(notified, []);
  // Karryam's own ops alert still goes to Karryam integration holders (unchanged).
  const karryam = await service.ingest(signedRequest("karryam", "ops.alert", { ...ALERT, component: "karryam-admin" }, KARRYAM_SECRET));
  assert.equal(karryam.status, 202, JSON.stringify(karryam.body));
  assert.deepEqual(notified[0].ids, [karryamOwner]);
});
