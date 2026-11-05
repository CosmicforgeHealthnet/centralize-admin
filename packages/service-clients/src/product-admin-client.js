"use strict";

// Generic Product Admin Protocol v1 client. Paths come only from the fixed
// endpoint table; the destination comes only from the trusted registry
// target. Responses are validated as standard envelopes for the expected
// product before they are returned.

const C = require("../../admin-contracts");
const { createServiceClient, ServiceClientError } = require("./client");

function createProductAdminClient({ productId, target, auth, timeoutMs, maxResponseBytes, now }) {
  if (!new RegExp(C.PATTERNS.productId).test(String(productId))) throw new ServiceClientError("PRODUCT_INVALID", "FATAL");
  const client = createServiceClient({ target, auth, timeoutMs, maxResponseBytes, now });

  async function call(endpointId, { params, query, body, correlationId, delegation } = {}) {
    const endpoint = C.ENDPOINTS[endpointId];
    if (!endpoint) throw new ServiceClientError("ENDPOINT_UNKNOWN", "FATAL");
    let path;
    try { path = C.endpointPath(endpointId, params); } catch { throw new ServiceClientError("PATH_PARAM_INVALID", "FATAL"); }
    const response = await client.request({ method: endpoint.method, path, query, body, correlationId, delegation });
    if (endpointId === "healthLive" || endpointId === "healthReady") return response;
    const check = C.validateEnvelope(response.json, { productId });
    if (!check.valid) throw new ServiceClientError("ENVELOPE_INVALID", "FATAL", check.errors.slice(0, 5));
    return response;
  }

  return Object.freeze({
    productId,
    target: client.target,
    getManifest: (o) => call("manifest", o),
    getHealthLive: (o) => call("healthLive", o),
    getHealthReady: (o) => call("healthReady", o),
    getCapabilities: (o) => call("capabilities", o),
    getDatasets: (o) => call("datasets", o),
    getDatasetSnapshot: (datasetId, o = {}) => call("datasetSnapshots", { ...o, params: { datasetId } }),
    getEvents: (query, o = {}) => call("events", { ...o, query }),
    ackEvents: (body, o = {}) => call("eventsAck", { ...o, body }),
    getSyncStatus: (o) => call("syncStatus", o),
    getOperation: (operationId, o = {}) => call("operationGet", { ...o, params: { operationId } }),
    submitOperation: (command, o = {}) => call("operationSubmit", { ...o, body: command }),
    getAudit: (operationId, o = {}) => call("auditGet", { ...o, params: { operationId } }),
    // Protocol 1.1 scoped reads.
    listResources: (capabilityId, collectionId, query, o = {}) => call("resourceList", { ...o, query, params: { capabilityId, collectionId } }),
    getResource: (capabilityId, collectionId, resourceId, query, o = {}) => call("resourceGet", { ...o, query, params: { capabilityId, collectionId, resourceId } }),
    getReport: (reportId, query, o = {}) => call("reportGet", { ...o, query, params: { reportId } }),
  });
}

module.exports = { createProductAdminClient };
