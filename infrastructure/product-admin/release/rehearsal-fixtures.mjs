#!/usr/bin/env node
// CI-only: writes DISPOSABLE operator files for a staging rehearsal on a
// GitHub runner (never on the VPS; refuses /etc/cosmicforge/staging). Every
// key, password and certificate is generated here, per run, and discarded
// with the runner. The layout is exactly what the operator provides on the
// real host (see staging/README.md), so the rehearsal exercises the real
// file formats, modes and container paths.
//
//   sudo node rehearsal-fixtures.mjs --config-root DIR --out DIR --mode disabled|enabled --release-sha SHA
//
// --out receives psql variable files for db-a-roles.sql / db-b-roles.sql /
// cfmeet-admin-db-roles.sql.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
const root = path.resolve(args["config-root"] || "");
const out = path.resolve(args.out || "");
const mode = args.mode;
const sha = args["release-sha"];
if (!args["config-root"] || !args.out || !["disabled", "enabled"].includes(mode) || !/^[0-9a-f]{40}$/.test(String(sha))) {
  console.error("usage: rehearsal-fixtures.mjs --config-root DIR --out DIR --mode disabled|enabled --release-sha SHA");
  process.exit(2);
}
if (root.startsWith("/etc/cosmicforge")) { console.error("refusing to write rehearsal fixtures into a real operator config root"); process.exit(2); }

const GID = { "product-integration-core": 10002, "karryam-admin": 10001, "karryam-admin-db": 70, "cfmeet-admin": 10003, "cfmeet-admin-db": 70 };
const b64 = (n = 32) => crypto.randomBytes(n).toString("base64url");
const pw = () => crypto.randomBytes(18).toString("hex");
const notAfter = new Date(Date.now() + 7 * 86400000).toISOString();

function secret(svc, name, content) {
  const file = path.join(root, "secrets", svc, name);
  fs.writeFileSync(file, content, { mode: 0o440 });
  fs.chownSync(file, 0, GID[svc]);
  fs.chmodSync(file, 0o440);
  return `/run/secrets/${svc}/${name}`;
}
function envFile(name, lines) {
  const file = path.join(root, name);
  fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  fs.chownSync(file, 0, 0);
  fs.chmodSync(file, 0o600);
}

fs.mkdirSync(out, { recursive: true });
// DB-B is initialized once with its superuser password; keep it on re-runs.
const dbbFile = path.join(root, "secrets", "karryam-admin-db", "postgres-password");
const dbbSuper = fs.existsSync(dbbFile) ? fs.readFileSync(dbbFile, "utf8") : pw();
if (!fs.existsSync(dbbFile)) secret("karryam-admin-db", "postgres-password", dbbSuper);
fs.writeFileSync(path.join(out, "db-b-superuser-password"), dbbSuper, { mode: 0o600 });
// The CF Meet Admin database likewise keeps its superuser password on re-runs.
const cmdbFile = path.join(root, "secrets", "cfmeet-admin-db", "postgres-password");
const cmdbSuper = fs.existsSync(cmdbFile) ? fs.readFileSync(cmdbFile, "utf8") : pw();
if (!fs.existsSync(cmdbFile)) secret("cfmeet-admin-db", "postgres-password", cmdbSuper);
fs.writeFileSync(path.join(out, "cfmeet-db-superuser-password"), cmdbSuper, { mode: 0o600 });

if (mode === "disabled") {
  envFile("product-integration-core.env", ["PIC_ENABLED=false"]);
  envFile("karryam-admin.env", ["KARRYAM_ADMIN_ENABLED=false"]);
  envFile("cfmeet-admin.env", ["CFMEET_ADMIN_ENABLED=false"]);
  console.log(JSON.stringify({ event: "rehearsal_fixtures", mode }));
  process.exit(0);
}

const pass = { pic_migrator: pw(), pic_runtime: pw(), karryam_admin_migrator: pw(), karryam_admin_runtime: pw(), cfmeet_admin_migrator: pw(), cfmeet_admin_runtime: pw() };
fs.writeFileSync(path.join(out, "db-a.psqlvars"), `-v pic_migrator_password=${pass.pic_migrator} -v pic_runtime_password=${pass.pic_runtime}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(out, "db-b.psqlvars"), `-v karryam_admin_migrator_password=${pass.karryam_admin_migrator} -v karryam_admin_runtime_password=${pass.karryam_admin_runtime}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(out, "cfmeet-db.psqlvars"), `-v cfmeet_admin_migrator_password=${pass.cfmeet_admin_migrator} -v cfmeet_admin_runtime_password=${pass.cfmeet_admin_runtime}\n`, { mode: 0o600 });

// Keys: one per purpose and boundary (PIC refuses reuse).
const svcKey = b64(), delegKey = b64(), hqKey = b64(), cursorKey = b64();
const signer = crypto.generateKeyPairSync("ed25519");
const cmSvcKey = b64(), cmDelegKey = b64(), cmCursorKey = b64();
const cmSigner = crypto.generateKeyPairSync("ed25519");

const kaHqKeys = secret("karryam-admin", "hq-service-keys.json", JSON.stringify({ "pic-karryam-k1": { service_id: "hq-product-integration-core", key_b64url: svcKey, not_after: notAfter } }));
const kaDeleg = secret("karryam-admin", "delegation-keys.json", JSON.stringify({ "pic-karryam-d1": { key_b64url: delegKey, not_after: notAfter } }));
const kaSigner = secret("karryam-admin", "manifest-signer.pem", signer.privateKey.export({ type: "pkcs8", format: "pem" }));
const kaCursor = secret("karryam-admin", "cursor-key", cursorKey);
envFile("karryam-admin.env", [
  "KARRYAM_ADMIN_ENABLED=true",
  "KARRYAM_ADMIN_SERVICE_INSTANCE_ID=karryam-admin-staging-1",
  "KARRYAM_ADMIN_WORKLOAD_IDENTITY=cf://staging/product-admin/karryam",
  `KARRYAM_ADMIN_BUILD_SHA=${sha}`,
  `KARRYAM_ADMIN_DATABASE_URL=postgresql://karryam_admin_runtime:${pass.karryam_admin_runtime}@karryam-admin-db:5432/karryam_admin`,
  `KARRYAM_ADMIN_HQ_SERVICE_KEYS_FILE=${kaHqKeys}`,
  `KARRYAM_ADMIN_DELEGATION_KEYS_FILE=${kaDeleg}`,
  `KARRYAM_ADMIN_MANIFEST_SIGNING_KEY_FILE=${kaSigner}`,
  "KARRYAM_ADMIN_MANIFEST_SIGNING_KID=karryam-staging-signer-1",
  `KARRYAM_ADMIN_CURSOR_KEY_FILE=${kaCursor}`,
  "KARRYAM_BRIDGE_ENABLED=false",
  "KARRYAM_BRIDGE_FEED_ENABLED=false",
]);
envFile("karryam-admin.migrate.env", [
  `KARRYAM_ADMIN_MIGRATION_DATABASE_URL=postgresql://karryam_admin_migrator:${pass.karryam_admin_migrator}@karryam-admin-db:5432/karryam_admin`,
  "KARRYAM_ADMIN_RUNTIME_ROLE=karryam_admin_runtime",
]);

const cmHqKeys = secret("cfmeet-admin", "hq-service-keys.json", JSON.stringify({ "pic-cfmeet-k1": { service_id: "hq-product-integration-core", key_b64url: cmSvcKey, not_after: notAfter } }));
const cmDeleg = secret("cfmeet-admin", "delegation-keys.json", JSON.stringify({ "pic-cfmeet-d1": { key_b64url: cmDelegKey, not_after: notAfter } }));
const cmSignerFile = secret("cfmeet-admin", "manifest-signer.pem", cmSigner.privateKey.export({ type: "pkcs8", format: "pem" }));
const cmCursor = secret("cfmeet-admin", "cursor-key", cmCursorKey);
envFile("cfmeet-admin.env", [
  "CFMEET_ADMIN_ENABLED=true",
  "CFMEET_ADMIN_SERVICE_INSTANCE_ID=cfmeet-admin-staging-1",
  "CFMEET_ADMIN_WORKLOAD_IDENTITY=cf://staging/product-admin/cfmeet",
  `CFMEET_ADMIN_BUILD_SHA=${sha}`,
  `CFMEET_ADMIN_DATABASE_URL=postgresql://cfmeet_admin_runtime:${pass.cfmeet_admin_runtime}@cfmeet-admin-db:5432/cfmeet_admin`,
  `CFMEET_ADMIN_HQ_SERVICE_KEYS_FILE=${cmHqKeys}`,
  `CFMEET_ADMIN_DELEGATION_KEYS_FILE=${cmDeleg}`,
  `CFMEET_ADMIN_MANIFEST_SIGNING_KEY_FILE=${cmSignerFile}`,
  "CFMEET_ADMIN_MANIFEST_SIGNING_KID=cfmeet-staging-signer-1",
  `CFMEET_ADMIN_CURSOR_KEY_FILE=${cmCursor}`,
  "CFMEET_BRIDGE_ENABLED=false",
  "CFMEET_BRIDGE_FEED_ENABLED=false",
]);
envFile("cfmeet-admin.migrate.env", [
  `CFMEET_ADMIN_MIGRATION_DATABASE_URL=postgresql://cfmeet_admin_migrator:${pass.cfmeet_admin_migrator}@cfmeet-admin-db:5432/cfmeet_admin`,
  "CFMEET_ADMIN_RUNTIME_ROLE=cfmeet_admin_runtime",
]);

const picEndpoints = secret("product-integration-core", "endpoints.json", JSON.stringify({ endpoints: { "karryam-staging": {
  product_id: "karryam", environment: "staging", transport: "unix", socket_path: "/run/cosmicforge/karryam/karryam-admin.sock",
  service_auth: { key_id: "pic-karryam-k1", key_b64url: svcKey }, delegation: { kid: "pic-karryam-d1", key_b64url: delegKey },
}, "cfmeet-staging": {
  product_id: "cfmeet", environment: "staging", transport: "unix", socket_path: "/run/cosmicforge/cfmeet/cfmeet-admin.sock",
  service_auth: { key_id: "pic-cfmeet-k1", key_b64url: cmSvcKey }, delegation: { kid: "pic-cfmeet-d1", key_b64url: cmDelegKey },
} } }));
const signerPub = secret("product-integration-core", "karryam-signer.pem", signer.publicKey.export({ type: "spki", format: "pem" }));
const cmSignerPub = secret("product-integration-core", "cfmeet-signer.pem", cmSigner.publicKey.export({ type: "spki", format: "pem" }));
const picSigners = secret("product-integration-core", "trusted-signers.json", JSON.stringify({ signers: {
  "karryam-staging-signer-1": { product_id: "karryam", environment: "staging", public_key_file: signerPub, not_after: notAfter },
  "cfmeet-staging-signer-1": { product_id: "cfmeet", environment: "staging", public_key_file: cmSignerPub, not_after: notAfter },
} }));
const picHq = secret("product-integration-core", "hq-delegation-keys.json", JSON.stringify({ keys: { "hq-k1": { key_b64url: hqKey, not_after: notAfter } } }));
envFile("product-integration-core.env", [
  "PIC_ENABLED=true",
  `PIC_DATABASE_URL=postgresql://pic_runtime:${pass.pic_runtime}@hq-db:5432/cosmicforge_admin`,
  `PIC_ENDPOINTS_FILE=${picEndpoints}`,
  `PIC_TRUSTED_SIGNERS_FILE=${picSigners}`,
  `PIC_HQ_DELEGATION_KEYS_FILE=${picHq}`,
  "PIC_SYNC_ENABLED=false",
]);
envFile("product-integration-core.migrate.env", [
  `PIC_MIGRATION_DATABASE_URL=postgresql://pic_migrator:${pass.pic_migrator}@hq-db:5432/cosmicforge_admin`,
  "PIC_RUNTIME_ROLE=pic_runtime",
]);
console.log(JSON.stringify({ event: "rehearsal_fixtures", mode, files: fs.readdirSync(root).length }));
