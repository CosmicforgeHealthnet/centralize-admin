const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  registerMarketingIntelligenceCron,
  computeSyncRange,
  resetForTests,
} = require("../aggregation/aggregation.cron");

const ORIGINAL_ENV = { ...process.env };

function fakeCronLib() {
  const calls = [];
  return {
    calls,
    validate: () => true,
    schedule(expression, fn, options) {
      const task = { expression, fn, options, stopped: false, stop() { this.stopped = true; } };
      calls.push(task);
      return task;
    },
  };
}

const noopService = { async syncMarketingInsights() { return { skipped: false }; } };
const fakePrisma = { marketing_performance_snapshots: { async count() { return 5; } } };

beforeEach(() => {
  resetForTests();
  process.env.NODE_ENV = "development";
  process.env.MARKETING_INTELLIGENCE_SYNC_ENABLED = "true";
  delete process.env.MARKETING_INTELLIGENCE_CRON;
});

afterEach(() => {
  resetForTests();
  process.env = { ...ORIGINAL_ENV };
});

test("does not register when scheduling is disabled", () => {
  process.env.MARKETING_INTELLIGENCE_SYNC_ENABLED = "false";
  const cronLib = fakeCronLib();
  const task = registerMarketingIntelligenceCron({
    cronLib,
    aggregationService: noopService,
    prisma: fakePrisma,
  });
  assert.equal(task, null);
  assert.equal(cronLib.calls.length, 0);
});

test("does not start in the test environment", () => {
  process.env.NODE_ENV = "test";
  const cronLib = fakeCronLib();
  const task = registerMarketingIntelligenceCron({
    cronLib,
    aggregationService: noopService,
    prisma: fakePrisma,
  });
  assert.equal(task, null);
  assert.equal(cronLib.calls.length, 0);
});

test("registers once when enabled, with the configured expression", () => {
  process.env.MARKETING_INTELLIGENCE_CRON = "0 */6 * * *";
  const cronLib = fakeCronLib();
  const task = registerMarketingIntelligenceCron({
    cronLib,
    aggregationService: noopService,
    prisma: fakePrisma,
  });
  assert.ok(task);
  assert.equal(task.expression, "0 */6 * * *");
  assert.equal(task.options.timezone, "UTC");
});

test("repeated registration never creates a second schedule", () => {
  const cronLib = fakeCronLib();
  const first = registerMarketingIntelligenceCron({
    cronLib,
    aggregationService: noopService,
    prisma: fakePrisma,
  });
  const second = registerMarketingIntelligenceCron({
    cronLib,
    aggregationService: noopService,
    prisma: fakePrisma,
  });
  assert.equal(first, second);
  assert.equal(cronLib.calls.length, 1);
});

test("a provider failure inside the scheduled run never throws", async () => {
  const cronLib = fakeCronLib();
  registerMarketingIntelligenceCron({
    cronLib,
    aggregationService: {
      async syncMarketingInsights() {
        throw new Error("provider exploded");
      },
    },
    prisma: fakePrisma,
  });

  await assert.doesNotReject(cronLib.calls[0].fn());
});

test("an overlapping (skipped) run is handled cleanly", async () => {
  const cronLib = fakeCronLib();
  registerMarketingIntelligenceCron({
    cronLib,
    aggregationService: {
      async syncMarketingInsights() {
        return { skipped: true, reason: "sync_already_running" };
      },
    },
    prisma: fakePrisma,
  });

  await assert.doesNotReject(cronLib.calls[0].fn());
});

test("an invalid cron expression is refused without scheduling", () => {
  process.env.MARKETING_INTELLIGENCE_CRON = "not a cron";
  const cronLib = { ...fakeCronLib(), validate: () => false };
  const task = registerMarketingIntelligenceCron({
    cronLib,
    aggregationService: noopService,
    prisma: fakePrisma,
  });
  assert.equal(task, null);
});

test("computeSyncRange uses the regular lookback once snapshots exist", async () => {
  process.env.MARKETING_INTELLIGENCE_LOOKBACK_DAYS = "3";
  const range = await computeSyncRange({ prisma: fakePrisma });
  const spanDays =
    (new Date(`${range.until}T00:00:00Z`) - new Date(`${range.since}T00:00:00Z`)) /
    (24 * 60 * 60 * 1000);
  assert.equal(spanDays, 3);
});

test("computeSyncRange uses the initial lookback for the first-ever sync", async () => {
  process.env.MARKETING_INTELLIGENCE_INITIAL_LOOKBACK_DAYS = "30";
  const emptyPrisma = { marketing_performance_snapshots: { async count() { return 0; } } };
  const range = await computeSyncRange({ prisma: emptyPrisma });
  const spanDays =
    (new Date(`${range.until}T00:00:00Z`) - new Date(`${range.since}T00:00:00Z`)) /
    (24 * 60 * 60 * 1000);
  assert.equal(spanDays, 30);
});
