function derivePlanOutcome(operations) {
  const retainedOperations = (operations || []).map((operation) => ({ ...operation }));
  const states = retainedOperations.map((operation) => operation.state);
  if (!states.length) return { planState: "EXECUTING", operations: retainedOperations };
  if (states.every((state) => state === "VERIFIED")) return { planState: "SUCCEEDED", operations: retainedOperations };
  if (states.includes("UNKNOWN") || states.includes("VERIFYING") || states.includes("EXECUTING") || states.includes("READY") || states.includes("RETRY_SCHEDULED")) {
    return { planState: "EXECUTING", operations: retainedOperations };
  }
  const successful = states.some((state) => state === "VERIFIED");
  const unsuccessful = states.some((state) => ["FAILED", "DRIFTED"].includes(state));
  if (successful && unsuccessful) return { planState: "PARTIAL_SUCCESS", operations: retainedOperations };
  if (unsuccessful) return { planState: "FAILED", operations: retainedOperations };
  return { planState: "EXECUTING", operations: retainedOperations };
}

module.exports = { derivePlanOutcome };
