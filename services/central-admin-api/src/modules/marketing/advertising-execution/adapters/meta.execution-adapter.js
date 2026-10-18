const { createProviderExecutionAdapter } = require("./provider-execution-adapter.factory");
const { PROVIDER_DEFINITIONS } = require("./provider-definitions");

module.exports = createProviderExecutionAdapter(PROVIDER_DEFINITIONS.META);
