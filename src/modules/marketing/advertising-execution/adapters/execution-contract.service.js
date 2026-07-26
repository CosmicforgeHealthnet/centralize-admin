const { assertExecutionAdapter } = require("./execution-adapter.interface");

async function validateAndBuildOperations({ adapter, plan, connection, accountState, dryRun = true }) {
  const contract = assertExecutionAdapter(adapter);
  const validatedPlan = await contract.validatePlan({ plan, connection, accountState, dryRun });
  return contract.buildOperations({ validatedPlan });
}

async function runContractOperation({ adapter, operation, idempotencyKey, expectedState, dryRun = true }) {
  const contract = assertExecutionAdapter(adapter);
  if (dryRun) return contract.previewOperation({ operation });
  return contract.executeOperation({ operation, idempotencyKey, expectedState });
}

module.exports = { validateAndBuildOperations, runContractOperation };
