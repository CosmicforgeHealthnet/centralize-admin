"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createBridgeConsumer } = require("../src/sync/bridge-consumer");
test("feed workload renews its assertion session before the Bridge five-minute expiry", async () => {
  let clock = 1793926800000;
  const calls = [];
  const scope = { market: "NG-LAG", organization: "karryam-staging", zone: "NG-LAG-MAIN", tenant: "karryam-staging-operations" };
  const lease = { lease_token: "lease", hold_sequence: null, last_sequence: 0, acked_sequence: 0 };
  const store = {
    acquireLease: async () => lease, startRun: async () => "run",
    setHead: async () => {}, partition: async () => lease,
    publishSyncHealth: async () => {}, finishRun: async () => {}, releaseLease: async () => {},
  };
  const feed = { enabled: true, subject: "karryam-staging-sync", acr: "workload", role: "karryam.source-sync.reader", consumer: "staging", purpose: "hq_event_sync", leaseSeconds: 60, pageSize: 50 };
  const bridgeClient = { call: async (capability, request) => {
    calls.push(request.staff);
    assert.ok(clock / 1000 - request.staff.authTime < 300);
    return { result: { head_sequence: 0, events: [] } };
  } };
  const consumer = createBridgeConsumer({ feed, store, bridgeClient, now: () => clock });
  await consumer.syncPartition(scope);
  clock += 119000; await consumer.syncPartition(scope);
  assert.equal(calls[0].sessionId, calls[1].sessionId);
  clock += 1000; await consumer.syncPartition(scope);
  assert.notEqual(calls[1].sessionId, calls[2].sessionId);
  clock += 301000; await consumer.syncPartition(scope);
  assert.notEqual(calls[2].sessionId, calls[3].sessionId);
  assert.equal(calls[3].acr, "workload");
  assert.equal(calls[3].role, feed.role);
  assert.equal(calls[3].authTime, Math.floor(clock / 1000));
});
