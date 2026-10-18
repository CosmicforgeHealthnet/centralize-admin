const { PROVIDERS } = require("../execution.constants");
const { executionError } = require("../execution.errors");
const { createUnavailableCapability } = require("../capabilities/capability-result");
const { normalizeContractError } = require("../operations/normalized-result");

const REQUIRED_METHODS = Object.freeze([
  "getCapabilities", "validatePlan", "buildOperations", "previewOperation",
  "executeOperation", "verifyOperation", "compensateOperation", "classifyError",
]);
const PUBLIC_KEYS = Object.freeze(["provider", "metadata", ...REQUIRED_METHODS]);

function assertExecutionAdapter(adapter) {
  if (!PROVIDERS.includes(adapter?.provider)) throw new TypeError("Execution adapter must declare a supported provider");
  if (!adapter.metadata || typeof adapter.metadata !== "object") throw new TypeError("Execution adapter must declare capability metadata");
  if (!String(adapter.metadata.apiVersion || "").trim()) throw new TypeError("Execution adapter must declare an API version or unavailable state");
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== "function") throw new TypeError(`Execution adapter must implement ${method}()`);
  }
  const arbitrary = Object.keys(adapter).filter((key) => !PUBLIC_KEYS.includes(key));
  if (arbitrary.length) throw new TypeError(`Execution adapter exposes unsupported public members: ${arbitrary.join(",")}`);
  return adapter;
}

function createDisabledExecutionAdapter(provider, { apiVersion = "UNAVAILABLE" } = {}) {
  const unavailable = () => { throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider }); };
  const adapter = {
    provider,
    metadata: Object.freeze({
      status: "UNAVAILABLE",
      apiVersion,
      writeCapable: false,
      supportedMethods: Object.freeze([...REQUIRED_METHODS]),
    }),
    getCapabilities: (context = {}) => createUnavailableCapability({
      provider,
      apiVersion,
      connectionId: context.connection?.id || null,
      accountExternalId: context.accountExternalId || null,
      accountCurrency: context.connection?.currency || null,
      reasonCode: context.unavailableReason || "ADAPTER_NOT_IMPLEMENTED",
      permissionState: context.permissionState || "UNKNOWN",
    }),
    validatePlan: unavailable,
    buildOperations: unavailable,
    previewOperation: unavailable,
    executeOperation: () => { throw executionError("DIRECT_PROVIDER_EXECUTION_FORBIDDEN", { provider }); },
    verifyOperation: unavailable,
    compensateOperation: unavailable,
    classifyError: ({ error } = {}) => normalizeContractError(error || executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider })),
  };
  return Object.freeze(assertExecutionAdapter(adapter));
}

module.exports = { REQUIRED_METHODS, PUBLIC_KEYS, assertExecutionAdapter, createDisabledExecutionAdapter };
