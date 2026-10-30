const {
  CONNECTOR_METHODS,
  CONNECTOR_PUBLIC_KEYS,
  SOCIAL_PROVIDERS,
} = require("./connector.constants");
const { ConnectorContractError } = require("./connector.errors");

function assertConnectorContract(connector) {
  if (!connector || typeof connector !== "object" || Array.isArray(connector)) {
    throw new ConnectorContractError("Connector must be an object");
  }

  if (!SOCIAL_PROVIDERS.includes(connector.platform)) {
    throw new ConnectorContractError("Connector exposes an unsupported platform", {
      platform: connector.platform,
    });
  }

  for (const methodName of CONNECTOR_METHODS) {
    if (!Object.hasOwn(connector, methodName)) {
      throw new ConnectorContractError("Connector is missing a required method", {
        platform: connector.platform,
        operation: methodName,
      });
    }

    if (typeof connector[methodName] !== "function") {
      throw new ConnectorContractError("Connector method must be a function", {
        platform: connector.platform,
        operation: methodName,
      });
    }
  }

  for (const key of Object.keys(connector)) {
    if (!CONNECTOR_PUBLIC_KEYS.includes(key)) {
      throw new ConnectorContractError("Connector exposes unsupported public surface", {
        platform: connector.platform,
      });
    }
  }

  return connector;
}

module.exports = {
  assertConnectorContract,
};
