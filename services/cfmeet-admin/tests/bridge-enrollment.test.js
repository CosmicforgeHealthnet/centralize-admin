"use strict";

// scripts/bridge-enrollment.js: the S3 operator helper. Every key here is a
// throwaway generated in a temp directory and removed afterwards; CF Meet's
// side (its private CA signing HQ's CSR) is simulated with the shared PKI
// helper's test CA.

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPrivateKey, createPublicKey, randomBytes } = require("node:crypto");
const { generatePki } = require("../../../packages/service-clients/tests/helpers/pki");

const SCRIPT = path.join(__dirname, "..", "scripts", "bridge-enrollment.js");
const URI = "cf://staging/product-admin/cfmeet";
const GOOD_EXT = "subjectAltName=URI:" + URI + "\nextendedKeyUsage=clientAuth\n";

let pkiOk = true;
try { generatePki({ serverName: "probe.internal" }).cleanup(); } catch { pkiOk = false; }
const skip = !pkiOk && "openssl unavailable";

function run(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-enrol-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function prepared(t, args = []) {
  const dir = path.join(tempDir(t), "secrets");
  const r = run("prepare", "--dir", dir, ...args);
  assert.equal(r.status, 0, r.stderr);
  return { dir, out: r.stdout };
}

// CF Meet's private CA signs HQ's CSR.
function sign(pki, csrFile, outFile, { days = 30, ext = GOOD_EXT } = {}) {
  const extFile = path.join(pki.dir, "sign-" + randomBytes(4).toString("hex") + ".ext");
  fs.writeFileSync(extFile, ext);
  execFileSync("openssl", ["x509", "-req", "-in", csrFile, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
    "-days", String(days), "-sha256", "-extfile", extFile, "-out", outFile], { cwd: pki.dir, stdio: "pipe" });
}

// A complete, good enrolment: HQ prepared, CF Meet returned cert, CA and HMAC key.
function enrolment(t, pki, opts = {}) {
  const { dir } = prepared(t);
  sign(pki, path.join(dir, "bridge-client.csr"), path.join(dir, "bridge-client.pem"), opts);
  fs.writeFileSync(path.join(dir, "bridge-ca.pem"), pki.ca);
  fs.writeFileSync(path.join(dir, "bridge-hmac-key"), randomBytes(32).toString("base64url"));
  return dir;
}

const line = (out, status, check) => new RegExp("^" + status + " " + check + "\\b", "m").test(out);

test("--help documents both commands; bad usage exits 2", () => {
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /prepare --dir/);
  assert.match(help.stdout, /verify {2}--dir/);
  assert.equal(run("prepare").status, 2);
  assert.equal(run("explode", "--dir", os.tmpdir()).status, 2);
  assert.equal(run("prepare", "--dir", os.tmpdir(), "--environment", "dev").status, 2);
});

test("prepare creates the key, CSR and staff key, prints only public material and refuses to overwrite", { skip }, (t) => {
  const { dir, out } = prepared(t);
  for (const name of ["bridge-client.key", "bridge-client.csr", "bridge-staff-ed25519.pem"]) assert.ok(fs.existsSync(path.join(dir, name)), name);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(dir, "bridge-client.key")).mode & 0o777, 0o440);
    assert.equal(fs.statSync(path.join(dir, "bridge-staff-ed25519.pem")).mode & 0o777, 0o440);
  }
  assert.doesNotMatch(out, /PRIVATE KEY|BEGIN /);
  assert.match(out, /CSR file\s+.*bridge-client\.csr/);
  assert.match(out, /staff kid\s+hq-cfmeet-staff-2026-11/);

  // The staff key: 64 lowercase hex characters, the raw Ed25519 public key.
  const hex = out.match(/staff public key\s+(\S+)/)[1];
  assert.match(hex, /^[0-9a-f]{64}$/);
  const staff = createPrivateKey(fs.readFileSync(path.join(dir, "bridge-staff-ed25519.pem")));
  assert.equal(staff.asymmetricKeyType, "ed25519");
  assert.equal(createPublicKey(staff).export({ type: "spki", format: "der" }).subarray(-32).toString("hex"), hex);

  // The client key is EC P-256.
  const key = createPrivateKey(fs.readFileSync(path.join(dir, "bridge-client.key")));
  assert.equal(key.asymmetricKeyDetails.namedCurve, "prime256v1");

  // Never overwrite: a second run fails and leaves every file untouched.
  const before = fs.readFileSync(path.join(dir, "bridge-client.key"));
  const again = run("prepare", "--dir", dir);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /REFUSING_TO_OVERWRITE/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "bridge-client.key")), before);

  // One existing target is enough to refuse, and nothing else is created.
  const other = tempDir(t);
  fs.writeFileSync(path.join(other, "bridge-staff-ed25519.pem"), "placeholder");
  const partial = run("prepare", "--dir", other);
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /bridge-staff-ed25519\.pem/);
  assert.equal(fs.existsSync(path.join(other, "bridge-client.key")), false);
  assert.equal(fs.existsSync(path.join(other, "bridge-client.csr")), false);
});

test("the CSR carries exactly the URI SAN, EKU clientAuth, the agreed subject and HQ's client key", { skip }, (t) => {
  for (const environment of ["staging", "production"]) {
    const { dir } = prepared(t, ["--environment", environment]);
    const csr = path.join(dir, "bridge-client.csr");
    const text = execFileSync("openssl", ["req", "-in", csr, "-noout", "-verify", "-text", "-nameopt", "RFC2253"], { stdio: "pipe" }).toString();
    const sanLine = text.split(/\r?\n/)[text.split(/\r?\n/).findIndex((l) => l.includes("X509v3 Subject Alternative Name")) + 1].trim();
    assert.equal(sanLine, "URI:cf://" + environment + "/product-admin/cfmeet");
    assert.equal((text.match(/URI:/g) || []).length, 1);
    assert.doesNotMatch(text, /DNS:|IP Address:|email:/);
    assert.match(text, /X509v3 Extended Key Usage:\s*\n\s*TLS Web Client Authentication\s*\n/);
    assert.match(text, /Subject: CN=cosmicforge-hq-cfmeet-admin/);
    assert.match(text, /Signature Algorithm: ecdsa-with-SHA256/);
    const csrKey = execFileSync("openssl", ["req", "-in", csr, "-noout", "-pubkey"], { stdio: "pipe" }).toString();
    const keyFile = createPrivateKey(fs.readFileSync(path.join(dir, "bridge-client.key")));
    assert.deepEqual(createPublicKey(csrKey).export({ type: "spki", format: "der" }), createPublicKey(keyFile).export({ type: "spki", format: "der" }));
  }
});

test("verify passes on good material and prints the fingerprint and expiry, never a secret", { skip }, (t) => {
  const pki = generatePki({ serverName: "admin-bridge.cfmeet.internal" });
  t.after(pki.cleanup);
  const dir = enrolment(t, pki);
  const r = run("verify", "--dir", dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const check of ["client_cert_file", "client_cert_startup_check", "client_cert_san_exact", "client_cert_eku_client_auth",
    "client_cert_min_validity", "client_key_matches_cert", "ca_bundle", "client_cert_chains_to_ca", "hmac_key", "staff_key"]) {
    assert.ok(line(r.stdout, "PASS", check), check + "\n" + r.stdout);
  }
  assert.match(r.stdout, /RESULT: PASS \(10 checks\)/);
  assert.match(r.stdout, /client certificate sha256\s+[0-9a-f]{64}\n/);
  assert.match(r.stdout, /client certificate expires\s+\d{4}-\d\d-\d\dT/);
  const hmac = fs.readFileSync(path.join(dir, "bridge-hmac-key"), "utf8");
  assert.equal(r.stdout.includes(hmac), false);
  assert.doesNotMatch(r.stdout, /PRIVATE KEY|BEGIN /);
});

test("verify fails, naming the check, on wrong URI SAN, missing clientAuth, key mismatch, non-CA bundle, short validity and bad HMAC files", { skip }, (t) => {
  const pki = generatePki({ serverName: "admin-bridge.cfmeet.internal" });
  t.after(pki.cleanup);
  const fails = (dir, check, args = []) => {
    const r = run("verify", "--dir", dir, ...args);
    assert.equal(r.status, 1, r.stdout);
    assert.ok(line(r.stdout, "FAIL", check), check + "\n" + r.stdout);
    assert.match(r.stdout, /RESULT: FAIL/);
    return r.stdout;
  };

  // Wrong URI SAN: CF Meet signed a different identity (or verify is run for the other environment).
  const wrongUri = enrolment(t, pki, { ext: "subjectAltName=URI:cf://staging/product-admin/karryam\nextendedKeyUsage=clientAuth\n" });
  assert.match(fails(wrongUri, "client_cert_startup_check"), /CFMEET_BRIDGE_CLIENT_CERT_URI_MISMATCH/);
  fails(wrongUri, "client_cert_san_exact");
  const good = enrolment(t, pki);
  fails(good, "client_cert_startup_check", ["--environment", "production"]);
  // An extra non-URI SAN is refused too.
  fails(enrolment(t, pki, { ext: "subjectAltName=URI:" + URI + ",DNS:hq.internal\nextendedKeyUsage=clientAuth\n" }), "client_cert_san_exact");

  // EKU without clientAuth.
  fails(enrolment(t, pki, { ext: "subjectAltName=URI:" + URI + "\nextendedKeyUsage=serverAuth\n" }), "client_cert_eku_client_auth");

  // Key/cert mismatch: the certificate was issued for another CSR.
  const mismatch = enrolment(t, pki);
  const { dir: otherDir } = prepared(t);
  fs.rmSync(path.join(mismatch, "bridge-client.pem"));
  sign(pki, path.join(otherDir, "bridge-client.csr"), path.join(mismatch, "bridge-client.pem"));
  assert.match(fails(mismatch, "client_key_matches_cert"), /CFMEET_BRIDGE_CLIENT_KEY_CERT_MISMATCH/);

  // The CA file holds a leaf, not a CA.
  const notCa = enrolment(t, pki);
  fs.writeFileSync(path.join(notCa, "bridge-ca.pem"), pki.serverCert);
  assert.match(fails(notCa, "ca_bundle"), /CFMEET_BRIDGE_CA_FILE_NOT_A_CA/);
  fails(notCa, "client_cert_chains_to_ca");

  // A different CA did not issue the client certificate.
  const other = generatePki({ serverName: "admin-bridge.cfmeet.internal" });
  t.after(other.cleanup);
  const wrongCa = enrolment(t, pki);
  fs.writeFileSync(path.join(wrongCa, "bridge-ca.pem"), other.ca);
  fails(wrongCa, "client_cert_chains_to_ca");

  // Too short validity: 1 day left against the default minimum of 2, or a higher minimum.
  fails(enrolment(t, pki, { days: 1 }), "client_cert_min_validity");
  fails(good, "client_cert_min_validity", ["--min-days", "60"]);

  // HMAC file: too short, or not base64url (padding/standard alphabet).
  const shortHmac = enrolment(t, pki);
  fs.writeFileSync(path.join(shortHmac, "bridge-hmac-key"), randomBytes(16).toString("base64url"));
  assert.match(fails(shortHmac, "hmac_key"), /CFMEET_BRIDGE_HMAC_KEY_FILE_KEY_TOO_SHORT/);
  const badHmac = enrolment(t, pki);
  fs.writeFileSync(path.join(badHmac, "bridge-hmac-key"), randomBytes(32).toString("base64"));
  assert.match(fails(badHmac, "hmac_key"), /CFMEET_BRIDGE_HMAC_KEY_FILE_KEY_ENCODING_INVALID/);
  const rawHmac = enrolment(t, pki);
  fs.writeFileSync(path.join(rawHmac, "bridge-hmac-key"), Buffer.concat([Buffer.from([0xff, 0x00]), randomBytes(40)]));
  fails(rawHmac, "hmac_key");

  // Missing returned files fail their checks instead of crashing.
  const { dir: bare } = prepared(t);
  const out = fails(bare, "client_cert_file");
  assert.ok(line(out, "FAIL", "ca_bundle") && line(out, "FAIL", "hmac_key") && line(out, "PASS", "staff_key"), out);
});
