"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const S = require("../src");
const C = require("../../admin-contracts");
const I = require("../../identity-and-permissions");

const key = Buffer.alloc(32, 3);
const dkey = Buffer.alloc(32, 4);
const auth = { serviceId: "hq-product-integration-core", keyId: "pic-k1", key };

async function start({ auditFails = false, badEnvelope = false } = {}) {
  const audits = [];
  const handler = S.createProductAdminHandler({
    productId: "synthetic-third", serviceInstanceId: "synthetic-third-test-1",
    serviceKeys: { "pic-k1": { serviceId: "hq-product-integration-core", key } },
    nonceStore: S.memoryNonceStore(),
    delegationKeys: { d1: { key: dkey } },
    logger: () => {},
    audit: async (record) => { if (auditFails) throw new Error("db down"); audits.push(record); },
    handlers: {
      healthLive: async () => ({ body: { status: "live" } }),
      manifest: async (ctx) => ({ body: badEnvelope ? { product_id: "x" } : C.okEnvelope({ productId: "synthetic-third", correlationId: ctx.correlationId, result: { seen: ctx.service.serviceId } }) }),
      operationSubmit: async (ctx) => ({ body: C.errorEnvelope({ productId: "synthetic-third", correlationId: ctx.correlationId, code: "DISABLED", reason: "CAPABILITY_DISABLED" }) }),
    },
  });
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const target = S.createFixedTarget({ ref: "syn", transport: "http-loopback", origin: "http://127.0.0.1:" + server.address().port, address: "127.0.0.1" }, { allowInsecureLoopback: true });
  return { server, audits, target, port: server.address().port };
}

function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    }).on("error", reject);
  });
}

test("protocol kit authenticates services and audits before execution", async () => {
  const { server, audits, target, port } = await start();
  try {
    const client = S.createProductAdminClient({ productId: "synthetic-third", target, auth });
    const ok = await client.getManifest();
    assert.equal(ok.status, 200);
    assert.equal(ok.json.result.seen, "hq-product-integration-core");
    assert.equal(audits.length, 1);
    assert.equal((await rawGet(port, "/health/live")).status, 200);
    const unauth = await rawGet(port, "/internal/product-admin/v1/manifest");
    assert.equal(unauth.status, 401);
    assert.equal(unauth.json.error.code, "UNAUTHENTICATED");
    assert.equal((await rawGet(port, "/internal/product-admin/v1/unknown")).status, 404);
    assert.equal((await rawGet(port, "/internal/product-admin/v1/datasets")).status, 401);
    assert.equal((await rawGet(port, "/internal/karryam-admin/v1/capabilities")).status, 404);
    const denied = await S.createServiceClient({ target, auth: { ...auth, serviceId: "karryam-admin" } }).request({ path: "/internal/product-admin/v1/manifest" });
    assert.equal(denied.status, 401);
  } finally { server.close(); }
});

test("operation submission requires a bound, unreplayed product delegation", async () => {
  const { server, target } = await start();
  try {
    const client = S.createProductAdminClient({ productId: "synthetic-third", target, auth });
    const command = { command_id: "7b0c8a52-4f1d-4c39-9a51-2b4d9a3e1c00" };
    const missing = await client.submitOperation(command);
    assert.equal(missing.status, 403);
    assert.equal(missing.json.error.reason, "DELEGATION_REQUIRED");
    const uri = C.endpointPath("operationSubmit");
    const now = Date.now();
    const mk = (claims) => I.signDelegation({ iss: "product-integration-core", aud: "synthetic-third:synthetic-third-test-1", sub: "staff-1", sid: "s1", auth_time: Math.floor(now / 1000) - 5, product_id: "synthetic-third", action: "operation.submit", bnd: I.requestBinding("POST", uri, Buffer.from(JSON.stringify(command))), ...claims }, { key: dkey, kid: "d1", typ: I.TYPES.PRODUCT, now });
    const token = mk({});
    const accepted = await client.submitOperation(command, { delegation: token });
    assert.equal(accepted.status, 403);
    assert.equal(accepted.json.error.reason, "CAPABILITY_DISABLED");
    const replay = await client.submitOperation(command, { delegation: token });
    assert.equal(replay.json.error.reason, "DELEGATION_INVALID");
    const crossProduct = await client.submitOperation(command, { delegation: mk({ product_id: "karryam" }) });
    assert.equal(crossProduct.json.error.reason, "DELEGATION_INVALID");
    const otherBody = await client.submitOperation({ command_id: "other" }, { delegation: mk({}) });
    assert.equal(otherBody.json.error.reason, "DELEGATION_INVALID");
  } finally { server.close(); }
});

test("audit failure fails closed and invalid envelopes are suppressed", async () => {
  const a = await start({ auditFails: true });
  try {
    const res = await S.createProductAdminClient({ productId: "synthetic-third", target: a.target, auth }).getManifest().catch((e) => e);
    assert.equal(res.status, 503);
    assert.equal(res.json.error.reason, "AUDIT_UNAVAILABLE");
  } finally { a.server.close(); }
  const b = await start({ badEnvelope: true });
  try {
    const res = await S.createProductAdminClient({ productId: "synthetic-third", target: b.target, auth }).getManifest();
    assert.equal(res.status, 500);
    assert.equal(res.json.error.reason, "INVALID_RESPONSE_SUPPRESSED");
  } finally { b.server.close(); }
});
