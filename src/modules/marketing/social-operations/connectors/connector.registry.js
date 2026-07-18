const { assertConnectorContract } = require("./connector.contract");
const { SOCIAL_PROVIDERS } = require("./connector.constants");
const {
  ConnectorContractError,
  ConnectorNotFoundError,
} = require("./connector.errors");
const metaConnector = require("./meta-publishing.connector");
const tiktokConnector = require("./tiktok-publishing.connector");
const xConnector = require("./x-publishing.connector");
const linkedinConnector = require("./linkedin-publishing.connector");

function createConnectorRegistry(connectors) {
  const registry = new Map();

  for (const connector of connectors) {
    assertConnectorContract(connector);

    if (registry.has(connector.platform)) {
      throw new ConnectorContractError("Duplicate provider connector registration", {
        platform: connector.platform,
      });
    }

    registry.set(connector.platform, connector);
  }

  for (const provider of SOCIAL_PROVIDERS) {
    if (!registry.has(provider)) {
      throw new ConnectorContractError("Provider connector is not registered", {
        platform: provider,
      });
    }
  }

  return Object.freeze({
    getConnector(provider) {
      if (!registry.has(provider)) {
        throw new ConnectorNotFoundError("Social provider connector was not found", {
          platform: provider,
        });
      }
      return registry.get(provider);
    },
    hasConnector(provider) {
      return registry.has(provider);
    },
    listConnectors() {
      return [...registry.values()];
    },
  });
}

const registry = createConnectorRegistry([
  metaConnector,
  tiktokConnector,
  xConnector,
  linkedinConnector,
]);

module.exports = {
  createConnectorRegistry,
  getConnector: registry.getConnector,
  hasConnector: registry.hasConnector,
  listConnectors: registry.listConnectors,
};
