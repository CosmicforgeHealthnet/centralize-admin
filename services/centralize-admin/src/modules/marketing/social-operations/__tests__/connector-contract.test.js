const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  CONNECTOR_METHODS,
  CONNECTOR_PUBLIC_KEYS,
  SOCIAL_PROVIDERS,
} = require("../connectors/connector.constants");
const { assertConnectorContract } = require("../connectors/connector.contract");
const {
  createConnectorRegistry,
  getConnector,
  listConnectors,
} = require("../connectors/connector.registry");
const {
  ConnectorCapabilityError,
  ConnectorContractError,
  ConnectorNotFoundError,
} = require("../connectors/connector.errors");

const connectorDir = path.resolve(__dirname, "../connectors");
const connectorFiles = [
  "meta-publishing.connector.js",
  "tiktok-publishing.connector.js",
  "x-publishing.connector.js",
  "linkedin-publishing.connector.js",
];

function activeConnection(provider) {
  return {
    id: `${provider.toLowerCase()}-connection`,
    provider,
    status: "ACTIVE",
    requiresReauthorization: false,
  };
}

test("all provider connectors exist and satisfy the exact public contract", () => {
  const connectors = listConnectors();
  assert.deepEqual(
    connectors.map((connector) => connector.platform).sort(),
    [...SOCIAL_PROVIDERS].sort(),
  );

  for (const connector of connectors) {
    assert.equal(assertConnectorContract(connector), connector);
    assert.deepEqual(Object.keys(connector).sort(), [...CONNECTOR_PUBLIC_KEYS].sort());
    for (const methodName of CONNECTOR_METHODS) {
      assert.equal(typeof connector[methodName], "function");
    }
  }
});

test("contract validation rejects bad platforms, missing methods and duplicate registration", () => {
  const valid = getConnector("META");
  assert.throws(
    () => assertConnectorContract({ ...valid, platform: "PINTEREST" }),
    ConnectorContractError,
  );

  const missing = { ...valid };
  delete missing.publishPost;
  assert.throws(() => assertConnectorContract(missing), ConnectorContractError);

  assert.throws(
    () => createConnectorRegistry([valid, valid, getConnector("TIKTOK"), getConnector("X"), getConnector("LINKEDIN")]),
    ConnectorContractError,
  );
});

test("registry resolves known providers, rejects unknown providers, and returns stable instances", () => {
  const meta = getConnector("META");
  assert.equal(meta.platform, "META");
  assert.equal(getConnector("META"), meta);
  assert.throws(() => getConnector("PINTEREST"), ConnectorNotFoundError);
});

test("network-dependent methods throw typed sanitized errors instead of fake success", async () => {
  const connector = getConnector("META");
  await assert.rejects(
    () =>
      connector.publishPost({
        connection: activeConnection("META"),
        target: { identity: { type: "FACEBOOK_PAGE" } },
      }),
    (error) => {
      assert.ok(error instanceof ConnectorCapabilityError);
      assert.equal(error.platform, "META");
      assert.equal(error.operation, "publishPost");
      assert.equal(JSON.stringify(error).includes("token"), false);
      return true;
    },
  );
});

test("connector files do not import Marketing Intelligence, Prisma, SDKs or network clients", () => {
  const forbidden = [
    /marketing[\\/]+intelligence/i,
    /provider-connections/i,
    /shared[\\/]+config[\\/]database/i,
    /\bprisma\b/i,
    /axios/i,
    /googleapis/i,
    /oauth/i,
    /fetch\s*\(/i,
    /https?:\/\//i,
  ];

  for (const file of connectorFiles) {
    const source = fs.readFileSync(path.join(connectorDir, file), "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} imports or references ${pattern}`);
    }
  }
});
