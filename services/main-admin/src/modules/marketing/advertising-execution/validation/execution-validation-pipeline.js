const { executionError } = require("../execution.errors");

const LAYERS = Object.freeze(["transport", "domain", "capability", "businessPolicy", "providerPreflight", "approvalIntegrity", "executionPrecondition"]);

async function runValidationPipeline(input, validators = {}, { through = "executionPrecondition" } = {}) {
  const results = {};
  const stop = LAYERS.indexOf(through);
  if (stop < 0) throw executionError("INVALID_EXECUTION_PLAN", { field: "through", reasonCode: "UNKNOWN_VALIDATION_LAYER" });
  let value = input;
  for (const layer of LAYERS.slice(0, stop + 1)) {
    const validator = validators[layer];
    if (typeof validator !== "function") throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { reasonCode: "VALIDATION_LAYER_UNAVAILABLE", layer });
    const outcome = await validator(value, results);
    if (outcome?.issues?.some((issue) => issue.severity === "ERROR")) throw executionError("INVALID_EXECUTION_PLAN", { field: layer, reasonCode: "VALIDATION_LAYER_FAILED", issues: outcome.issues });
    value = outcome?.value ?? value;
    results[layer] = outcome || { value };
  }
  return Object.freeze({ value, layers: Object.freeze(results), validatedThrough: through });
}

module.exports = { LAYERS, runValidationPipeline };
