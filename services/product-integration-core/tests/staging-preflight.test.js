"use strict";

// Section 12.3 staging preflight (scripts/check-config.js) for the HQ
// Product Integration Core: production endpoints and superuser runtime
// identities are refused; an absent denylist is reported, not passed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, generateKeyPairSync } = require("node:crypto");
const { main } = require("../scripts/check-config");

const posix = process.platform !== "win32";

test("staging preflight refuses production endpoints and superuser identities", { skip: !posix && "PIC config files require absolute POSIX paths" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pic-preflight-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = () => randomBytes(32).toString("base64url");
  const notAfter = new Date(Date.now() + 86400000).toISOString();
  fs.writeFileSync(path.join(dir, "signer.pem"), generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }));
  fs.writeFileSync(path.join(dir, "endpoints.json"), JSON.stringify({ endpoints: { "karryam-staging": { product_id: "karryam", environment: "staging", transport: "unix", socket_path: "/run/cosmicforge/karryam/karryam-admin.sock", service_auth: { key_id: "k1", key_b64url: key() }, delegation: { kid: "d1", key_b64url: key() } } } }));
  fs.writeFileSync(path.join(dir, "signers.json"), JSON.stringify({ signers: { "karryam-staging-1": { product_id: "karryam", environment: "staging", public_key_file: path.join(dir, "signer.pem"), not_after: notAfter } } }));
  fs.writeFileSync(path.join(dir, "hq.json"), JSON.stringify({ keys: { "hq-k1": { key_b64url: key(), not_after: notAfter } } }));
  const env = {
    PIC_ENABLED: "true", PIC_ENVIRONMENT: "staging", PIC_DATABASE_URL: "postgresql://pic_runtime@hq-db:5432/cosmicforge_admin",
    PIC_ENDPOINTS_FILE: path.join(dir, "endpoints.json"), PIC_TRUSTED_SIGNERS_FILE: path.join(dir, "signers.json"), PIC_HQ_DELEGATION_KEYS_FILE: path.join(dir, "hq.json"),
  };
  const base = main(env);
  assert.equal(base.production_denylist, "NOT_PROVIDED");
  assert.equal(main({ ...env, PRODUCT_ADMIN_PRODUCTION_DENYLIST: "prod-db.internal" }).production_denylist, "CHECKED");
  assert.throws(() => main({ ...env, PRODUCT_ADMIN_PRODUCTION_DENYLIST: "hq-db" }), (e) => e.reason === "PRODUCTION_ENDPOINT_IN_STAGING");
  assert.throws(() => main({ ...env, PIC_DATABASE_URL: "postgresql://postgres@hq-db:5432/cosmicforge_admin" }), (e) => e.reason === "DATABASE_SUPERUSER_IDENTITY");
  const text = JSON.stringify(main({ ...env, PRODUCT_ADMIN_PRODUCTION_DENYLIST: "prod-db.internal" }));
  for (const forbidden of ["pic_runtime", "hq-db", "prod-db.internal", dir]) assert.equal(text.includes(forbidden), false, forbidden);
});
