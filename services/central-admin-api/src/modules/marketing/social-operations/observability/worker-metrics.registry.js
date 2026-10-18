const state = {
  leaseRecoveries: { publishing: 0, action: 0 },
  claimFailures: { publishing: 0, action: 0 },
  processingDurationsMs: { publishing: [], action: [] },
  lastHeartbeatAt: { publishing: null, action: null },
};

function boundedPush(values, value, limit = 200) {
  values.push(value);
  if (values.length > limit) values.shift();
}

function recordLeaseRecovery(queue, count) {
  if (!state.leaseRecoveries[queue]) state.leaseRecoveries[queue] = 0;
  state.leaseRecoveries[queue] += Number(count || 0);
}

function recordClaimFailure(queue) {
  if (!state.claimFailures[queue]) state.claimFailures[queue] = 0;
  state.claimFailures[queue] += 1;
}

function recordProcessingDuration(queue, durationMs) {
  if (!state.processingDurationsMs[queue]) state.processingDurationsMs[queue] = [];
  boundedPush(state.processingDurationsMs[queue], Number(durationMs || 0));
}

function recordHeartbeat(queue, at = new Date()) {
  state.lastHeartbeatAt[queue] = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
}

function aggregateDurations(values) {
  if (!values.length) return { count: 0, minMs: null, maxMs: null, avgMs: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    avgMs: Math.round(total / values.length),
  };
}

function snapshotWorkerMetrics() {
  return {
    leaseRecoveryCount: { ...state.leaseRecoveries },
    claimFailureCount: { ...state.claimFailures },
    lastHeartbeatAt: { ...state.lastHeartbeatAt },
    processingDurationAggregates: {
      publishing: aggregateDurations(state.processingDurationsMs.publishing || []),
      action: aggregateDurations(state.processingDurationsMs.action || []),
    },
  };
}

function resetWorkerMetrics() {
  state.leaseRecoveries = { publishing: 0, action: 0 };
  state.claimFailures = { publishing: 0, action: 0 };
  state.processingDurationsMs = { publishing: [], action: [] };
  state.lastHeartbeatAt = { publishing: null, action: null };
}

module.exports = {
  recordLeaseRecovery,
  recordClaimFailure,
  recordProcessingDuration,
  recordHeartbeat,
  snapshotWorkerMetrics,
  resetWorkerMetrics,
};
