const { PROVIDERS } = require("../execution.constants");
const { readExecutionConfig } = require("../execution.config");
const { executionError } = require("../execution.errors");
const { assertExecutionAdapter } = require("./execution-adapter.interface");
const { createProviderExecutionAdapter } = require("./provider-execution-adapter.factory");
const { PROVIDER_DEFINITIONS } = require("./provider-definitions");

const DEFAULT_ADAPTERS = Object.freeze({
  GOOGLE_ADS: require("./google-ads.execution-adapter"),
  META: require("./meta.execution-adapter"),
  TIKTOK: require("./tiktok.execution-adapter"),
  LINKEDIN: require("./linkedin.execution-adapter"),
  X: require("./x.execution-adapter"),
});

function createDefaultAdapters(env, dependencies = {}) {
  return Object.freeze(Object.fromEntries(PROVIDERS.map((provider) => [
    provider,
    createProviderExecutionAdapter(PROVIDER_DEFINITIONS[provider], {
      env,
      clientFactory: dependencies.clientFactories?.[provider] || dependencies.clientFactory || null,
      credentialResolver: dependencies.credentialResolver || null,
      targetingResolver: dependencies.targetingResolver || null,
      creativePublicationResolver: dependencies.creativePublicationResolver || null,
      allowProviderValidation: dependencies.allowProviderValidation === true,
    }),
  ])));
}

function createExecutionAdapterRegistry({ adapters, env = process.env, dependencies = {} } = {}) {
  const registeredAdapters = adapters || (Object.keys(dependencies).length ? createDefaultAdapters(env, dependencies) : env === process.env ? DEFAULT_ADAPTERS : createDefaultAdapters(env));
  function get(provider) {
    if (!PROVIDERS.includes(provider) || !registeredAdapters[provider]) throw executionError("UNSUPPORTED_PROVIDER", { provider });
    return assertExecutionAdapter(registeredAdapters[provider]);
  }

  function resolve(provider, { connectionWriteEnabled = false } = {}) {
    const adapter = get(provider);
    const config = readExecutionConfig(env);
    if (!config.enabled) throw executionError("EXECUTION_DISABLED");
    if (!config.providers[provider]) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, gate: "PROVIDER" });
    if (!config.apiVersions[provider]) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, gate: "API_VERSION" });
    if (!connectionWriteEnabled || !config.connectionWriteEnabled) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, gate: "CONNECTION" });
    return adapter;
  }

  function capabilities() {
    const config = readExecutionConfig(env);
    return PROVIDERS.map((provider) => {
      const declared = get(provider).getCapabilities();
      return {
        provider,
        status: declared.operationSupported ? "STRUCTURALLY_SUPPORTED_WRITE_DISABLED" : "UNAVAILABLE",
        apiVersion: declared.apiVersion,
        configurationReady: declared.configurationReady,
        writeCapable: false,
        connectionWriteEnabled: false,
      };
    });
  }

  return { get, resolve, capabilities };
}

module.exports = { DEFAULT_ADAPTERS, createDefaultAdapters, createExecutionAdapterRegistry };
