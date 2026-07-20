const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createAttributionService, UNRESOLVED } = require("../attribution.service");
const { createFakePrisma } = require("./helpers/fake-prisma");

function addClick(prisma, overrides = {}) {
  const row = {
    id: overrides.id || `click-${prisma.__state.funnelEvents.length + 1}`,
    externalEventId: overrides.externalEventId || overrides.id || `click-${prisma.__state.funnelEvents.length + 1}`,
    stage: "CLICK",
    anonId: "anon-1",
    userId: null,
    source: "meta",
    platform: "META",
    connectionId: "conn-meta-1",
    accountExternalId: "act_1",
    campaignExternalId: "camp-1",
    occurredAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
  prisma.__state.funnelEvents.push(row);
  return row;
}

function addConversion(prisma, overrides = {}) {
  const row = {
    id: overrides.id || `conversion-${prisma.__state.funnelEvents.length + 1}`,
    externalEventId: overrides.externalEventId || overrides.id || `conversion-${prisma.__state.funnelEvents.length + 1}`,
    stage: "SIGNUP",
    anonId: "anon-1",
    userId: "user-1",
    source: null,
    platform: "META",
    connectionId: "conn-meta-1",
    accountExternalId: "act_1",
    campaignExternalId: "camp-1",
    occurredAt: new Date("2026-07-08T00:00:00.000Z"),
    ...overrides,
  };
  prisma.__state.funnelEvents.push(row);
  return row;
}

function serviceWithWindow(prisma, days) {
  return createAttributionService({
    prisma,
    settings: { getAttributionWindowDays: async () => days },
  });
}

test("last-touch attribution honors the configured window boundaries and deterministic tie-breaker", async () => {
  const prisma = createFakePrisma();
  const attribution = serviceWithWindow(prisma, 7);

  addClick(prisma, {
    id: "click-before-window",
    occurredAt: new Date("2026-06-30T23:59:59.999Z"),
  });
  const lowerBoundary = addClick(prisma, {
    id: "click-lower-boundary",
    occurredAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  addClick(prisma, {
    id: "click-after-conversion",
    occurredAt: new Date("2026-07-08T00:00:00.001Z"),
  });
  addClick(prisma, {
    id: "click-same-time-a",
    occurredAt: new Date("2026-07-08T00:00:00.000Z"),
  });
  const selectedTie = addClick(prisma, {
    id: "click-same-time-z",
    occurredAt: new Date("2026-07-08T00:00:00.000Z"),
  });
  const conversion = addConversion(prisma);

  const decision = await attribution.resolveLastTouchForConversion(conversion);

  assert.equal(decision.status, "ATTRIBUTED");
  assert.equal(decision.selectedClickEventId, selectedTie.id);
  assert.equal(decision.attributionWindowDays, 7);
  assert.equal(decision.windowStart.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.ok(prisma.__state.attributionDecisions.some((row) => row.selectedClickEventId === selectedTie.id));
  assert.equal(lowerBoundary.stage, "CLICK");
  assert.equal(lowerBoundary.userId, null);
});

test("configured non-default attribution window excludes older clicks", async () => {
  const prisma = createFakePrisma();
  const attribution = serviceWithWindow(prisma, 1);

  addClick(prisma, {
    id: "click-two-days-old",
    occurredAt: new Date("2026-07-06T00:00:00.000Z"),
  });
  const conversion = addConversion(prisma, {
    occurredAt: new Date("2026-07-08T00:00:00.000Z"),
  });

  const decision = await attribution.resolveLastTouchForConversion(conversion);

  assert.equal(decision.status, "UNRESOLVED");
  assert.equal(decision.unresolvedReason, UNRESOLVED.OUTSIDE_ATTRIBUTION_WINDOW);
});

test("account-aware matching selects the compatible account and leaves ambiguous accounts unresolved", async () => {
  const prisma = createFakePrisma();
  const attribution = serviceWithWindow(prisma, 30);

  addClick(prisma, {
    id: "click-account-a",
    connectionId: "conn-a",
    accountExternalId: "act_a",
    campaignExternalId: "shared-campaign",
  });
  const accountBClick = addClick(prisma, {
    id: "click-account-b",
    connectionId: "conn-b",
    accountExternalId: "act_b",
    campaignExternalId: "shared-campaign",
    occurredAt: new Date("2026-07-02T00:00:00.000Z"),
  });

  const accountScoped = addConversion(prisma, {
    id: "conversion-account-b",
    connectionId: null,
    accountExternalId: "act_b",
    campaignExternalId: "shared-campaign",
    occurredAt: new Date("2026-07-03T00:00:00.000Z"),
  });
  const scopedDecision = await attribution.resolveLastTouchForConversion(accountScoped);
  assert.equal(scopedDecision.status, "ATTRIBUTED");
  assert.equal(scopedDecision.selectedClickEventId, accountBClick.id);

  const ambiguous = addConversion(prisma, {
    id: "conversion-ambiguous",
    connectionId: null,
    accountExternalId: null,
    campaignExternalId: "shared-campaign",
    occurredAt: new Date("2026-07-03T00:00:00.000Z"),
  });
  const ambiguousDecision = await attribution.resolveLastTouchForConversion(ambiguous);
  assert.equal(ambiguousDecision.status, "UNRESOLVED");
  assert.equal(ambiguousDecision.unresolvedReason, UNRESOLVED.AMBIGUOUS_ACCOUNT);
});

test("identity links hash anonymous tokens and conflict instead of relinking to another user", async () => {
  const prisma = createFakePrisma();
  const attribution = serviceWithWindow(prisma, 30);

  await attribution.linkUser({
    userId: "user-a",
    anonId: "raw-session-secret",
    occurredAt: "2026-07-01T00:00:00.000Z",
  });
  const conflict = await attribution.linkUser({
    userId: "user-b",
    anonId: "raw-session-secret",
    occurredAt: "2026-07-01T00:01:00.000Z",
  });

  assert.equal(prisma.__state.identityLinks.length, 1);
  assert.notEqual(prisma.__state.identityLinks[0].anonIdHash, "raw-session-secret");
  assert.ok(!JSON.stringify(prisma.__state.identityLinks).includes("raw-session-secret"));
  assert.equal(conflict.status, "CONFLICT");
  assert.equal(conflict.conflictReason, "ANON_ID_ALREADY_LINKED");
});

test("an identity-link conflict cannot attribute the original anonymous click to another user", async () => {
  const prisma = createFakePrisma();
  const attribution = serviceWithWindow(prisma, 30);
  addClick(prisma, { anonId: "contested-anon" });

  await attribution.linkUser({ userId: "original-user", anonId: "contested-anon" });
  await attribution.linkUser({ userId: "unrelated-user", anonId: "contested-anon" });
  const conversion = addConversion(prisma, {
    userId: "unrelated-user",
    anonId: "contested-anon",
  });

  const decision = await attribution.resolveLastTouchForConversion(conversion);
  assert.equal(decision.status, "UNRESOLVED");
  assert.equal(decision.unresolvedReason, UNRESOLVED.IDENTITY_UNRESOLVED);
  assert.equal(decision.selectedClickEventId, null);
});

test("account-only context does not choose between multiple connections", async () => {
  const prisma = createFakePrisma();
  const attribution = serviceWithWindow(prisma, 30);
  addClick(prisma, { id: "conn-a-click", connectionId: "conn-a", accountExternalId: "act-shared" });
  addClick(prisma, { id: "conn-b-click", connectionId: "conn-b", accountExternalId: "act-shared" });
  const conversion = addConversion(prisma, {
    connectionId: null,
    accountExternalId: "act-shared",
  });

  const decision = await attribution.resolveLastTouchForConversion(conversion);
  assert.equal(decision.status, "UNRESOLVED");
  assert.equal(decision.unresolvedReason, UNRESOLVED.AMBIGUOUS_ACCOUNT);
});
