"use strict";

// M9 unit tests (no database, no network).

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMailConfig, publicStatus } = require("../src/modules/mail/mail.config");
const { createRuntimeControls, purposeForMailbox } = require("../src/modules/mail/ops/runtime-controls");
const { parseCostRates, utcDay } = require("../src/modules/mail/ops/usage.service");
const { createOpsMonitor } = require("../src/modules/mail/ops/ops-monitor.service");

test("M9 destructive and external capabilities default OFF; no retention periods are invented", () => {
  const config = loadMailConfig({ MAIL_ENABLED: "true" });
  assert.equal(config.retention.executionEnabled, false);
  assert.deepEqual(config.retention.systemDays, { WEBHOOK_PAYLOADS: null, INTEGRATION_EVENTS: null, PRODUCT_DELIVERY_EVENTS: null });
  assert.equal(config.ops.metricsToken, "");
  assert.equal(publicStatus(config).metricsEndpointEnabled, false);
  assert.equal(loadMailConfig({ MAIL_RETENTION_EXECUTION_ENABLED: "true" }).retention.executionEnabled, false, "requires MAIL_ENABLED");
  assert.equal(loadMailConfig({ MAIL_ENABLED: "true", MAIL_RETENTION_WEBHOOK_PAYLOAD_DAYS: "0" }).retention.systemDays.WEBHOOK_PAYLOADS, null, "invalid periods are ignored");
  assert.equal(loadMailConfig({ MAIL_ENABLED: "true", MAIL_RETENTION_WEBHOOK_PAYLOAD_DAYS: "90" }).retention.systemDays.WEBHOOK_PAYLOADS, 90);
});

test("runtime controls: ALL stops every send purpose, MARKETING stops only marketing", async () => {
  const all = createRuntimeControls({ config: loadMailConfig({ MAIL_EMERGENCY_STOP_ALL: "true" }) });
  for (const purpose of ["STAFF_MAIL", "SUPPORT", "MARKETING_BROADCAST", "MARKETING_AUTOMATION", "MARKETING_CONFIRMATION"]) assert.equal(await all.haltReason(purpose), "MAIL_EMERGENCY_STOP");
  const marketing = createRuntimeControls({ config: loadMailConfig({ MAIL_EMERGENCY_STOP_MARKETING: "true" }) });
  assert.equal(await marketing.haltReason("STAFF_MAIL"), null);
  assert.equal(await marketing.haltReason("MARKETING_BROADCAST"), "MARKETING_EMERGENCY_STOP");
  const none = createRuntimeControls({ config: loadMailConfig({}) });
  none.use(async (purpose, scope) => (scope.organizationId === "org-x" ? "CUSTOM_HALT" : null));
  assert.equal(await none.haltReason("SUPPORT", { organizationId: "org-x" }), "CUSTOM_HALT");
  await assert.rejects(none.haltReason("INBOUND"), /unknown send purpose/);
  assert.equal(purposeForMailbox({ purpose: "SUPPORT" }), "SUPPORT");
  assert.equal(purposeForMailbox({ purpose: "GENERAL" }), "STAFF_MAIL");
});

test("cost rates are only ever operator-provided", () => {
  assert.equal(parseCostRates(undefined), null);
  assert.equal(parseCostRates("not json"), null);
  assert.deepEqual(parseCostRates('{"currency":"USD","perThousand":{"STAFF_MAIL":1.5,"BOGUS":3,"SUPPORT":-1}}'), { currency: "USD", perThousand: { STAFF_MAIL: 1.5 } });
  assert.equal(utcDay(new Date("2026-10-25T23:59:59Z")), "2026-10-25");
});

function snapshot(overrides = {}) {
  return {
    queue: { oldestDueSeconds: {}, deadLetters24h: [] },
    webhooks: { backlog: 0, oldestBacklogSeconds: 0 },
    scanning: { backlog: 0, oldestBacklogSeconds: 0 },
    delivery: { staff24h: {}, outcomeUnknown24h: 0, broadcast24h: [] },
    integrations: { rejections1h: [] },
    retention: {},
    usageToday: [],
    runtimeHalt: { staffMail: null, marketing: null },
    ...overrides,
  };
}

test("alert rules: thresholds, minimum samples and severities", () => {
  const monitor = createOpsMonitor({ client: {}, config: loadMailConfig({ MAIL_ENABLED: "true" }), notifications: {} });
  assert.deepEqual(monitor.evaluate(snapshot()), [], "quiet system raises nothing");
  const codes = (snap, health) => monitor.evaluate(snap, health).map((alert) => `${alert.code}:${alert.severity}`).sort();
  assert.deepEqual(codes(snapshot({ queue: { oldestDueSeconds: { OUTBOUND: 1000 }, deadLetters24h: [] } })), ["MAIL_QUEUE_STALLED:warning"]);
  assert.deepEqual(codes(snapshot({ queue: { oldestDueSeconds: { OUTBOUND: 4000 }, deadLetters24h: [] } })), ["MAIL_QUEUE_STALLED:critical"]);
  // Rates need a minimum sample so a single bounce never pages anyone.
  assert.deepEqual(codes(snapshot({ delivery: { staff24h: { DELIVERED: 1, BOUNCED: 1 }, outcomeUnknown24h: 0, broadcast24h: [] } })), []);
  assert.deepEqual(codes(snapshot({ delivery: { staff24h: { DELIVERED: 90, BOUNCED: 10 }, outcomeUnknown24h: 0, broadcast24h: [] } })), ["MAIL_BOUNCE_RATE_HIGH:critical"]);
  assert.deepEqual(codes(snapshot({ delivery: { staff24h: {}, outcomeUnknown24h: 0, broadcast24h: [{ organizationId: "o", handed: 1000, bounced: 0, complained: 2 }] } })), ["MAIL_COMPLAINT_RATE_HIGH:critical"]);
  assert.deepEqual(codes(snapshot({ usageToday: [{ organizationId: "o", purpose: "STAFF_MAIL", accepted: 10, dailySoftLimit: 5, dailyHardLimit: 20 }] })), ["MAIL_QUOTA_SOFT_LIMIT_REACHED:warning"]);
  assert.deepEqual(codes(snapshot({ runtimeHalt: { staffMail: "MAIL_EMERGENCY_STOP", marketing: null } })), ["MAIL_EMERGENCY_STOP_ACTIVE:warning"]);
  assert.deepEqual(codes(snapshot(), { storage: { ok: false }, encryption: { available: false }, infrastructure: { violations: ["x"] } }), ["MAIL_ENCRYPTION_UNAVAILABLE:critical", "MAIL_INFRASTRUCTURE_VIOLATION:critical", "MAIL_STORAGE_UNHEALTHY:critical"]);
  const two = monitor.evaluate(snapshot({ queue: { oldestDueSeconds: { OUTBOUND: 1000, EVENTS: 1000 }, deadLetters24h: [] } }));
  assert.notEqual(two[0].fingerprint, two[1].fingerprint, "per-queue fingerprints");
});

test("metrics endpoint needs a 32+ char token and compares in constant time", () => {
  const off = createOpsMonitor({ client: {}, config: loadMailConfig({ MAIL_METRICS_TOKEN: "short" }), notifications: {} });
  assert.deepEqual(off.metricsAuthorized("Bearer short"), { enabled: false });
  const token = "t".repeat(40);
  const on = createOpsMonitor({ client: {}, config: loadMailConfig({ MAIL_METRICS_TOKEN: token }), notifications: {} });
  assert.deepEqual(on.metricsAuthorized(`Bearer ${token}`), { enabled: true, ok: true });
  assert.deepEqual(on.metricsAuthorized("Bearer nope"), { enabled: true, ok: false });
  assert.deepEqual(on.metricsAuthorized(undefined), { enabled: true, ok: false });
});

test("backup/restore verifier refuses anything that is not clearly disposable", () => {
  const { assertDisposable } = require("../scripts/mail/verify-backup-restore");
  assert.equal(assertDisposable("postgres://localhost:5432/cosmicforge_social_replay_123"), "cosmicforge_social_replay_123");
  assert.throws(() => assertDisposable("postgres://localhost:5432/cosmicforge_admin"), /Refusing/);
  assert.throws(() => assertDisposable("postgres://db.prod.example:5432/mail_test"), /Refusing/, "remote hosts need explicit confirmation");
  assert.equal(assertDisposable("postgres://db.staging.example:5432/mail_copy", "mail_copy"), "mail_copy");
  assert.throws(() => assertDisposable("postgres://db.staging.example:5432/mail_copy", "other"), /Refusing/);
});
