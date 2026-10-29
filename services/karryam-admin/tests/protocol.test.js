"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, verify, createHmac } = require("node:crypto");
const { signDelegation, verifyDelegation, bridgeSignature, requestDigest, bridgeHeaders } = require("../src/protocol");
const { bridgeOrigin } = require("../src/bridge-client");
const { createHandler } = require("../src/server");
const now = 1793250000;
const scope = { market: "LAGOS", organization: "COSMICFORGE", acr: "mfa" };
const actor = {
  iss: "central-admin-api", aud: "karryam-admin-local", product: "karryam",
  sub: "staff-01", session_id: "session-01", role: "SUPER",
  permission: "bridge.capabilities.read", market: scope.market, organization: scope.organization,
  acr: scope.acr, auth_time: now - 2, iat: now, exp: now + 15, operation: "capabilities.read"
};
const secret = Buffer.alloc(32, 0x3a);
test("delegation is bounded, signed and scope-bound", () => {
  const token = signDelegation(actor, secret);
  assert.deepEqual(verifyDelegation(token, secret, scope, now), actor);
  assert.throws(() => verifyDelegation(token + "a", secret, scope, now));
  assert.throws(() => verifyDelegation(token, secret, { ...scope, market: "ABUJA" }, now));
  assert.throws(() => verifyDelegation(token, secret, scope, now + 20));
  assert.throws(() => verifyDelegation(signDelegation({ ...actor, permission: "wallet.refund" }, secret), secret, scope, now));
  assert.throws(() => verifyDelegation(signDelegation({ ...actor, exp: now + 1000 }, secret), secret, scope, now));
});
test("HMAC v2 matches KarryGo canonical line protocol", () => {
  const uri = "/internal/karryam-admin/v1/capabilities?market=LAGOS&organization=COSMICFORGE&purpose=admin_ui_capabilities";
  const nonce = "abcdef0123456789";
  const timestamp = 1793250000;
  const canonical = ["2","cosmicforge-hq-karryam-admin","GET",uri,String(timestamp),nonce,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"].join("\n");
  const expected = createHmac("sha256", secret).update(canonical).digest("hex");
  assert.equal(bridgeSignature({ secret, method: "GET", uri, timestamp, nonce }), expected);
  assert.equal(requestDigest("GET",uri).length,64);
});
test("Ed25519 assertion uses exact bridge claims and signed request binding", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const uri = "/internal/karryam-admin/v1/capabilities?market=LAGOS&organization=COSMICFORGE&purpose=admin_ui_capabilities";
  const h = bridgeHeaders({ serviceKey:secret, serviceKid:"kid-1", privateKey, staffKid:"staff-1",
    issuer:"hq-issuer",audience:"karryam-private",role:"hq.super.read",delegation:actor,method:"GET",uri,now });
  const [rawHeader,rawClaims,rawSignature] = h.Authorization.slice(7).split(".");
  const header = JSON.parse(Buffer.from(rawHeader,"base64url"));
  const claims = JSON.parse(Buffer.from(rawClaims,"base64url"));
  assert.equal(header.alg,"EdDSA");
  assert.equal(claims.product,"karryam");
  assert.deepEqual(claims.permissions,["bridge.capabilities.read"]);
  assert.equal(claims.request_digest,requestDigest("GET",uri));
  assert.equal(claims.auth_time,actor.auth_time);
  assert.equal(verify(null, Buffer.from(rawHeader+"."+rawClaims), publicKey, Buffer.from(rawSignature,"base64url")),true);
  assert.equal(h["X-Service-Name"],"cosmicforge-hq-karryam-admin");
});
test("bridge origin refuses HTTP, credentials, query and unexpected path", () => {
  assert.throws(() => bridgeOrigin("http://127.0.0.1:8110"));
  assert.throws(() => bridgeOrigin("https://admin:pass@127.0.0.1:8110"));
  assert.throws(() => bridgeOrigin("https://127.0.0.1:8110/internal"));
  assert.throws(() => bridgeOrigin("https://127.0.0.1:8110/?to=other"));
  assert.equal(bridgeOrigin("https://127.0.0.1:8110").protocol,"https:");
});
test("service exposes no admin routes without explicit enablement", async () => {
  const handler=createHandler({enabled:false});
  const response = {};
  const fakeRes = {writeHead(status, headers){response.status=status;response.headers=headers;},
    end(raw){response.data=JSON.parse(raw);}};
  await handler({method:"GET",url:"/v1/capabilities"}, fakeRes);
  assert.equal(response.status,503);
  await handler({method:"POST",url:"/v1/capabilities"}, fakeRes);
  assert.equal(response.status,404);
});
