"use strict";

// Functional suite: runs against HQ's interface-v1 target registry (see helpers/target-contract.js).
require("./helpers/target-contract");


// The Stage A worker refuses to start unless explicitly enabled with an
// enrolled Bridge and feed configuration.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startWorker } = require("../src/worker/index");
const F = require("./helpers/fixtures");

test("Stage A worker fails closed when the service or the feed is disabled", async (t) => {
  const m = F.material();
  t.after(m.cleanup);
  await assert.rejects(startWorker({}, { logger: () => {} }), (e) => e.reason === "CFMEET_ADMIN_DISABLED");
  await assert.rejects(startWorker(F.enabledEnv(m), { logger: () => {} }), (e) => e.reason === "CFMEET_BRIDGE_FEED_DISABLED");
  await assert.rejects(startWorker(F.enabledEnv(m, { CFMEET_BRIDGE_FEED_ENABLED: "true" }), { logger: () => {} }), (e) => e.reason === "CFMEET_BRIDGE_FEED_REQUIRES_BRIDGE");
});
