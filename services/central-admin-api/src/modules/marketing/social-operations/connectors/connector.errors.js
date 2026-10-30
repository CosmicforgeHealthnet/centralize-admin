const SAFE_DETAIL_KEYS = new Set([
  "platform",
  "operation",
  "capabilityStatus",
  "reasonCode",
]);

function safeDetails(details = {}) {
  return Object.fromEntries(
    Object.entries(details).filter(([key]) => SAFE_DETAIL_KEYS.has(key)),
  );
}

class ConnectorError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.details = Object.freeze(safeDetails(details));
    this.platform = this.details.platform;
    this.operation = this.details.operation;
    this.capabilityStatus = this.details.capabilityStatus;
    this.reasonCode = this.details.reasonCode;
  }
}

class ConnectorContractError extends ConnectorError {}
class ConnectorNotFoundError extends ConnectorError {}
class ConnectorCapabilityError extends ConnectorError {}
class ConnectorNotConfiguredError extends ConnectorError {}
class ConnectorValidationError extends ConnectorError {}
class ConnectorNormalizationError extends ConnectorError {}

module.exports = {
  ConnectorError,
  ConnectorContractError,
  ConnectorNotFoundError,
  ConnectorCapabilityError,
  ConnectorNotConfiguredError,
  ConnectorValidationError,
  ConnectorNormalizationError,
};
