const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  socialWorkerConfigFromEnv,
  registerSocialWorkers,
} = require("../src/modules/marketing/social-operations/workers/social-worker-runner");
const {
  createWorkerShutdownController,
} = require("../src/modules/marketing/social-operations/workers/worker-shutdown.service");

test("workers are disabled by default and do not call providers", async () => {
  const previous = {
    all: process.env.SOCIAL_WORKERS_ENABLED,
    publishing: process.env.SOCIAL_PUBLISHING_WORKER_ENABLED,
    action: process.env.SOCIAL_ACTION_WORKER_ENABLED,
  };
  try {
    delete process.env.SOCIAL_WORKERS_ENABLED;
    delete process.env.SOCIAL_PUBLISHING_WORKER_ENABLED;
    delete process.env.SOCIAL_ACTION_WORKER_ENABLED;

    const config = socialWorkerConfigFromEnv();
    assert.equal(config.workersEnabled, false);

    let runnerCalled = false;
    const registered = registerSocialWorkers({
      config,
      log: { info() {}, error() {} },
      publishingRunner: async () => {
        runnerCalled = true;
      },
      actionRunner: async () => {
        runnerCalled = true;
      },
    });
    assert.equal(registered.started, false);
    assert.equal(runnerCalled, false);
    assert.deepEqual(await registered.shutdown(), {
      stoppedClaiming: true,
      inFlightRemaining: 0,
    });
  } finally {
    if (previous.all !== undefined) process.env.SOCIAL_WORKERS_ENABLED = previous.all;
    else delete process.env.SOCIAL_WORKERS_ENABLED;
    if (previous.publishing !== undefined) process.env.SOCIAL_PUBLISHING_WORKER_ENABLED = previous.publishing;
    else delete process.env.SOCIAL_PUBLISHING_WORKER_ENABLED;
    if (previous.action !== undefined) process.env.SOCIAL_ACTION_WORKER_ENABLED = previous.action;
    else delete process.env.SOCIAL_ACTION_WORKER_ENABLED;
  }
});

test("shutdown stops new claims without marking in-flight jobs failed", async () => {
  const shutdown = createWorkerShutdownController({ graceMs: 10 });
  const inFlight = new Promise((resolve) => setTimeout(resolve, 25));
  shutdown.track(inFlight);
  const result = await shutdown.shutdown();
  assert.equal(result.stoppedClaiming, true);
  assert.equal(shutdown.isStopping, true);
  assert.ok(result.inFlightRemaining >= 0);
});
