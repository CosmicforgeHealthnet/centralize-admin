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

test("the worker calls the event feed only when the pinned contract serves both feed and ACK", () => {
  const { eventFeedServed } = require("../src/worker/index");
  const registry = (states) => ({ capability: (id) => (id in states ? { id, matrix_state: states[id] } : null) });
  assert.equal(eventFeedServed(registry({ "hq.events.feed": "READ_ONLY", "hq.events.ack": "AVAILABLE" })), true);
  // Until CF Meet serves the feed (contract 1.x: BLOCKED_DEPENDENCY), only datasets are pulled.
  for (const state of ["BLOCKED_DEPENDENCY", "DISABLED"]) {
    assert.equal(eventFeedServed(registry({ "hq.events.feed": state, "hq.events.ack": "AVAILABLE" })), false, state);
    assert.equal(eventFeedServed(registry({ "hq.events.feed": "READ_ONLY", "hq.events.ack": state })), false, state);
  }
  assert.equal(eventFeedServed(registry({ "hq.events.feed": "READ_ONLY" })), false, "a missing ACK capability is not served");
});
