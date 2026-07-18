const { test } = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");

const { createFunnelEventListener, STAGE_BY_EVENT } = require("../listeners/funnel-event.listener");
const EVENTS = require("../../../../shared/events/events");
const { createFakePrisma } = require("./helpers/fake-prisma");

const silentLog = { info() {}, warn() {}, error() {} };

function buildListener(prisma, overrides = {}) {
  const reconcileCalls = [];
  const listener = createFunnelEventListener({
    prisma,
    log: silentLog,
    aggregationService: {
      resolvePlatformFromSource: (source) =>
        ({ meta: "META", facebook: "META", instagram: "META", tiktok: "TIKTOK" })[
          String(source || "").toLowerCase()
        ] || null,
      reconcileSnapshotFunnel: async (args) => {
        reconcileCalls.push(args);
      },
    },
    ...overrides,
  });
  return { listener, reconcileCalls };
}

test("signup events persist with attribution", async () => {
  const prisma = createFakePrisma();
  const { listener } = buildListener(prisma);

  await listener.recordFunnelEvent("SIGNUP", {
    eventId: "signup-1",
    userId: "user-1",
    source: "Facebook",
    campaignExternalId: "camp-1",
    utmParams: { utm_source: "facebook", utm_campaign: "june" },
    occurredAt: "2026-07-01T10:00:00.000Z",
  });

  const [event] = prisma.__state.funnelEvents;
  assert.equal(event.stage, "SIGNUP");
  assert.equal(event.source, "facebook"); // normalized to lowercase
  assert.equal(event.campaignExternalId, "camp-1");
  assert.deepEqual(event.utmParams, { utm_source: "facebook", utm_campaign: "june" });
});

test("active-user events persist", async () => {
  const prisma = createFakePrisma();
  const { listener } = buildListener(prisma);

  await listener.recordFunnelEvent("ACTIVE", {
    eventId: "active-1",
    userId: "user-1",
    source: "tiktok",
    campaignExternalId: "tt-camp",
    occurredAt: "2026-07-01T10:00:00.000Z",
  });

  assert.equal(prisma.__state.funnelEvents[0].stage, "ACTIVE");
});

test("payment events carry value and currency from the payload", async () => {
  const prisma = createFakePrisma();
  const { listener } = buildListener(prisma);

  await listener.recordFunnelEvent("PAYMENT", {
    eventId: "pay-1",
    userId: "user-1",
    source: "meta",
    campaignExternalId: "camp-1",
    amount: 120.555,
    currency: "usd",
    occurredAt: "2026-07-01T10:00:00.000Z",
  });

  const [event] = prisma.__state.funnelEvents;
  assert.equal(event.value, 120.56);
  assert.equal(event.currency, "USD");
});

test("payment without payload amount still records with no revenue", async () => {
  const prisma = createFakePrisma();
  const { listener } = buildListener(prisma);

  await listener.recordFunnelEvent("PAYMENT", {
    transactionId: "txn-1",
    userId: "user-1",
    source: "meta",
    campaignExternalId: "camp-1",
    occurredAt: "2026-07-01T10:00:00.000Z",
  });

  const [event] = prisma.__state.funnelEvents;
  assert.equal(event.externalEventId, "payment:txn-1");
  assert.equal(event.value, null);
  assert.equal(event.currency, null);
});

test("payment with only transaction id does not require any main database lookup", async () => {
  const prisma = createFakePrisma();
  const { listener } = buildListener(prisma);

  await listener.recordFunnelEvent("PAYMENT", {
    transactionId: "txn-2",
    userId: "user-1",
    occurredAt: "2026-07-01T10:00:00.000Z",
  });

  const [event] = prisma.__state.funnelEvents;
  assert.equal(event.stage, "PAYMENT");
  assert.equal(event.value, null);
});

test("duplicate event IDs are not inserted twice", async () => {
  const prisma = createFakePrisma();
  const { listener } = buildListener(prisma);

  const payload = {
    eventId: "dup-1",
    userId: "user-1",
    occurredAt: "2026-07-01T10:00:00.000Z",
  };
  await listener.recordFunnelEvent("SIGNUP", payload);
  const second = await listener.recordFunnelEvent("SIGNUP", payload);

  assert.equal(second.duplicate, true);
  assert.equal(prisma.__state.funnelEvents.length, 1);
});

test("attributed events trigger snapshot reconciliation for the mapped platform", async () => {
  const prisma = createFakePrisma();
  const { listener, reconcileCalls } = buildListener(prisma);

  await listener.recordFunnelEvent("PAYMENT", {
    eventId: "pay-2",
    userId: "user-1",
    source: "instagram",
    campaignExternalId: "camp-9",
    amount: 10,
    occurredAt: "2026-07-01T10:00:00.000Z",
  });

  assert.deepEqual(reconcileCalls, [
    { platform: "META", campaignExternalId: "camp-9", date: "2026-07-01" },
  ]);
});

test("missing campaign attribution is handled safely (no reconciliation)", async () => {
  const prisma = createFakePrisma();
  const { listener, reconcileCalls } = buildListener(prisma);

  await listener.recordFunnelEvent("SIGNUP", {
    eventId: "organic-1",
    userId: "user-1",
    occurredAt: "2026-07-01T10:00:00.000Z",
  });

  assert.equal(prisma.__state.funnelEvents.length, 1);
  assert.equal(reconcileCalls.length, 0);
});

test("events without any identifying value are dropped", async () => {
  const prisma = createFakePrisma();
  const { listener } = buildListener(prisma);

  const result = await listener.recordFunnelEvent("SIGNUP", {});
  assert.equal(result.dropped, true);
  assert.equal(prisma.__state.funnelEvents.length, 0);
});

test("a listener failure does not break the emitter (event bus contract)", async () => {
  // Mirrors eventBus.subscribe: handler errors are caught, never rethrown.
  const bus = new (class extends EventEmitter {
    subscribe(event, handler) {
      this.on(event, async (payload) => {
        try {
          await handler(payload);
        } catch (error) {
          this.lastError = error;
        }
      });
    }
    publish(event, payload) {
      this.emit(event, payload);
    }
  })();

  const failingPrisma = {
    marketing_funnel_events: {
      async findUnique() {
        throw new Error("db down");
      },
      async create() {
        throw new Error("db down");
      },
    },
  };

  const listener = createFunnelEventListener({
    prisma: failingPrisma,
    bus,
    log: silentLog,
    aggregationService: { resolvePlatformFromSource: () => null, reconcileSnapshotFunnel: async () => {} },
  });
  listener.register();

  // publish must not throw even though the handler fails internally.
  bus.publish(EVENTS.USER_SIGNUP_COMPLETED, { eventId: "x", userId: "u" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(bus.lastError);
});

test("listener maps all four funnel events to stages", () => {
  assert.equal(STAGE_BY_EVENT[EVENTS.PAYMENT_SUCCESS], "PAYMENT");
  assert.equal(STAGE_BY_EVENT[EVENTS.USER_SIGNUP_COMPLETED], "SIGNUP");
  assert.equal(STAGE_BY_EVENT[EVENTS.USER_BECAME_ACTIVE], "ACTIVE");
  assert.equal(STAGE_BY_EVENT[EVENTS.MARKETING_CLICK_RECORDED], "CLICK");
});
