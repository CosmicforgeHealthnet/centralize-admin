const { readExecutionConfig } = require("../execution.config");
const { PROVIDERS } = require("../execution.constants");
const { executionError } = require("../execution.errors");

function assertExecutionCapability({ provider, connectionWriteEnabled = false, env = process.env } = {}) {
  if (!PROVIDERS.includes(provider)) throw executionError("UNSUPPORTED_PROVIDER", { provider });
  const config = readExecutionConfig(env);
  if (!config.enabled) throw executionError("EXECUTION_DISABLED");
  if (!config.providers[provider]) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, gate: "PROVIDER" });
  if (!connectionWriteEnabled || !config.connectionWriteEnabled) {
    throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, gate: "CONNECTION" });
  }
  return config;
}

module.exports = { assertExecutionCapability };
