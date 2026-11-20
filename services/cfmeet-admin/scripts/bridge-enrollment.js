"use strict";

// Operator helper for CF Meet Bridge trust enrolment (stage S3), run on the
// HQ staging host. See docs/product-admin/cfmeet-admin-go-live.md step 4.
//
//   prepare  generates HQ's mTLS client key + CSR (openssl CLI) and the
//            Ed25519 staff assertion key (node:crypto) in the secrets
//            directory. Private keys never leave the host and are never
//            printed; only public material is shown.
//   verify   checks the material CF Meet returned (client certificate, CA
//            bundle, HMAC key file) against HQ's keys BEFORE the Bridge is
//            enabled, with the same checks cfmeet-admin runs at startup.
//
// Never prints a private key, the HMAC key or any other secret value.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate } = require("node:crypto");
const K = require("../src/security/keys");
const { checkClientCertificate, checkCaBundle, checkKeyPair, ConfigError } = require("../src/config");

const FILES = Object.freeze({
  clientKey: "bridge-client.key",
  csr: "bridge-client.csr",
  clientCert: "bridge-client.pem",
  ca: "bridge-ca.pem",
  staffKey: "bridge-staff-ed25519.pem",
  hmac: "bridge-hmac-key",
});
const ENVIRONMENTS = Object.freeze(["staging", "production"]);
const SUBJECT_CN = "cosmicforge-hq-cfmeet-admin";
const DEFAULT_STAFF_KID = "hq-cfmeet-staff-2026-11";
const DEFAULT_HMAC_KID = "hq-cfmeet-hmac-2026-11";
const CLIENT_AUTH_OID = "1.3.6.1.5.5.7.3.2";
const DAY_MS = 24 * 60 * 60 * 1000;
const PRIVATE_MODE = 0o440;
const PUBLIC_MODE = 0o444;
const DIR_MODE = 0o750;

const USAGE = `CF Meet Bridge trust enrolment helper (stage S3), for the HQ staging host.

Usage:
  node scripts/bridge-enrollment.js prepare --dir <secrets dir> [--environment staging] [--staff-kid <kid>] [--hmac-kid <kid>]
  node scripts/bridge-enrollment.js verify  --dir <secrets dir> [--environment staging] [--min-days 2] [--staff-kid <kid>]
  node scripts/bridge-enrollment.js --help

prepare
  Creates, in --dir (created with mode 0750 if missing), and refuses to run if
  any of them already exists:
    ${FILES.clientKey}          EC P-256 mTLS client key (private, mode 0440)
    ${FILES.csr}          SHA-256 CSR: CN=${SUBJECT_CN}, EKU clientAuth,
                               exactly one URI SAN cf://<environment>/product-admin/cfmeet (mode 0444)
    ${FILES.staffKey}   Ed25519 staff assertion key (private, mode 0440)
  Needs the openssl CLI (1.1.1 or newer) on PATH. Prints only public material:
  the CSR path and sha256, its subject and SAN, the staff public key as 64
  lowercase hex characters and the key ids. Send those to CF Meet through the
  sealed operator channel. The private keys never leave this host.

verify
  Checks the files CF Meet returned, next to HQ's keys, before the Bridge is
  enabled:
    ${FILES.clientCert}          signed client certificate
    ${FILES.ca}              CF Meet private CA bundle
    ${FILES.hmac}            HMAC v2 key: base64url text of at least 32 bytes
  Prints PASS/FAIL per check, the client certificate sha256 fingerprint and
  expiry. Exits 1 if any check fails. Never prints a secret value.

Options
  --dir <path>           secrets directory, e.g. /etc/cosmicforge/staging/secrets/cfmeet-admin
  --environment <env>    staging (default) or production: the URI SAN environment part
  --staff-kid <kid>      staff assertion key id (default ${DEFAULT_STAFF_KID})
  --hmac-kid <kid>       HMAC key id, printed for the hand-off (default ${DEFAULT_HMAC_KID})
  --min-days <n>         verify: minimum remaining client certificate validity in days (default 2)
  -h, --help             show this help

Exit codes: 0 success, 1 a check or generation step failed, 2 usage error.
`;

class UsageError extends Error {}

const workloadUri = (environment) => "cf://" + environment + "/product-admin/cfmeet";
const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const fingerprintOf = (cert) => cert.fingerprint256.replace(/:/g, "").toLowerCase();
const reasonOf = (err) => (err instanceof ConfigError ? err.reason : (err && err.message) || String(err));

function rawEd25519PublicHex(key) {
  return Buffer.from(createPublicKey(key).export({ format: "jwk" }).x, "base64url").toString("hex");
}

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        dir: { type: "string" },
        environment: { type: "string", default: "staging" },
        "staff-kid": { type: "string", default: DEFAULT_STAFF_KID },
        "hmac-kid": { type: "string", default: DEFAULT_HMAC_KID },
        "min-days": { type: "string", default: "2" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { command: "help" };
  if (positionals.length !== 1 || !["prepare", "verify"].includes(positionals[0])) throw new UsageError("expected exactly one command: prepare or verify");
  if (!values.dir) throw new UsageError("--dir is required");
  if (!ENVIRONMENTS.includes(values.environment)) throw new UsageError("--environment must be staging or production");
  for (const name of ["staff-kid", "hmac-kid"]) {
    if (!K.KEY_ID.test(values[name])) throw new UsageError("--" + name + " is not a valid key id");
  }
  if (!/^[0-9]{1,4}$/.test(values["min-days"])) throw new UsageError("--min-days must be a whole number of days");
  return {
    command: positionals[0],
    dir: path.resolve(values.dir),
    environment: values.environment,
    staffKid: values["staff-kid"],
    hmacKid: values["hmac-kid"],
    minDays: Number(values["min-days"]),
  };
}

// openssl with an argument array and no shell. stdin is closed unless input
// is given; stdout is returned (key or CSR PEM), stderr is never echoed
// because it could quote input.
function openssl(args, input) {
  try {
    return execFileSync("openssl", args, {
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("OPENSSL_NOT_FOUND: install the openssl CLI (1.1.1 or newer) or run prepare where it is available");
    throw new Error("OPENSSL_FAILED: openssl " + args[0] + " exited with status " + err.status);
  }
}

// Reads a CSR with openssl: self-signature, subject, key, signature
// algorithm, SAN entries and EKU names. Used by prepare as a self-check and
// by the tests.
function csrSummary(csrPem) {
  const text = openssl(["req", "-noout", "-verify", "-pubkey", "-text", "-nameopt", "RFC2253"], csrPem).toString("utf8");
  const lines = text.split(/\r?\n/);
  const after = (label) => {
    const i = lines.findIndex((l) => l.trim().startsWith(label));
    return i >= 0 && i + 1 < lines.length ? lines[i + 1].trim().split(/,\s*/).filter(Boolean) : [];
  };
  const pick = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const publicKey = (text.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/) || [null])[0];
  return {
    subject: pick(/Subject:\s*(.*)/),
    keyAlgorithm: pick(/Public Key Algorithm:\s*(.*)/),
    curve: pick(/NIST CURVE:\s*(.*)/),
    signatureAlgorithm: pick(/Signature Algorithm:\s*(.*)/),
    subjectAltNames: after("X509v3 Subject Alternative Name"),
    extendedKeyUsage: after("X509v3 Extended Key Usage"),
    publicKeyPem: publicKey,
  };
}

function expectedCsrProblems(summary, environment, keyPem) {
  const problems = [];
  if (summary.subject !== "CN=" + SUBJECT_CN) problems.push("subject");
  if (summary.keyAlgorithm !== "id-ecPublicKey" || summary.curve !== "P-256") problems.push("key algorithm");
  if (summary.signatureAlgorithm !== "ecdsa-with-SHA256") problems.push("signature algorithm");
  if (summary.subjectAltNames.length !== 1 || summary.subjectAltNames[0] !== "URI:" + workloadUri(environment)) problems.push("subjectAltName");
  if (summary.extendedKeyUsage.length !== 1 || summary.extendedKeyUsage[0] !== "TLS Web Client Authentication") problems.push("extendedKeyUsage");
  const keySpki = createPublicKey(keyPem).export({ type: "spki", format: "der" });
  if (!summary.publicKeyPem || !createPublicKey(summary.publicKeyPem).export({ type: "spki", format: "der" }).equals(keySpki)) problems.push("public key");
  return problems;
}

function writeNew(file, data, mode) {
  fs.writeFileSync(file, data, { flag: "wx", mode });
}

function prepare(opts, out = console.log) {
  const file = (name) => path.join(opts.dir, name);
  if (fs.existsSync(opts.dir)) {
    if (!fs.statSync(opts.dir).isDirectory()) throw new Error("NOT_A_DIRECTORY: " + opts.dir);
  } else {
    fs.mkdirSync(opts.dir, { recursive: true, mode: DIR_MODE });
  }
  const targets = [FILES.clientKey, FILES.csr, FILES.staffKey];
  const existing = targets.filter((name) => fs.existsSync(file(name)));
  if (existing.length) throw new Error("REFUSING_TO_OVERWRITE: " + existing.join(", ") + " already exist(s) in " + opts.dir + "; nothing was changed");

  const uri = workloadUri(opts.environment);
  const created = [];
  try {
    const keyPem = openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-pkeyopt", "ec_param_enc:named_curve"]);
    const key = createPrivateKey(keyPem);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails.namedCurve !== "prime256v1") throw new Error("CLIENT_KEY_NOT_P256");
    writeNew(file(FILES.clientKey), keyPem, PRIVATE_MODE);
    created.push(file(FILES.clientKey));

    const csrPem = openssl([
      "req", "-new", "-sha256", "-key", file(FILES.clientKey),
      "-subj", "/CN=" + SUBJECT_CN,
      "-addext", "subjectAltName=URI:" + uri,
      "-addext", "extendedKeyUsage=clientAuth",
    ]);
    const summary = csrSummary(csrPem);
    const problems = expectedCsrProblems(summary, opts.environment, keyPem);
    if (problems.length) throw new Error("CSR_SELF_CHECK_FAILED: " + problems.join(", "));
    writeNew(file(FILES.csr), csrPem, PUBLIC_MODE);
    created.push(file(FILES.csr));

    const { privateKey } = generateKeyPairSync("ed25519");
    writeNew(file(FILES.staffKey), privateKey.export({ type: "pkcs8", format: "pem" }), PRIVATE_MODE);
    created.push(file(FILES.staffKey));

    out("CF Meet Bridge enrolment: prepare complete. Public material only below.");
    out("");
    out("  directory           " + opts.dir);
    out("  private (stay here) " + FILES.clientKey + ", " + FILES.staffKey + " (mode 0440)");
    out("  CSR file            " + file(FILES.csr));
    out("  CSR sha256          " + sha256Hex(csrPem));
    out("  CSR subject         CN=" + SUBJECT_CN);
    out("  CSR URI SAN         " + uri + " (the only SAN)");
    out("  CSR key / EKU       EC P-256, SHA-256 signature / clientAuth");
    out("  staff kid           " + opts.staffKid);
    out("  staff public key    " + rawEd25519PublicHex(privateKey));
    out("  HMAC kid (agreed)   " + opts.hmacKid);
    out("");
    out("Next: send the CSR file, the staff public key hex and the staff kid to CF Meet");
    out("through the sealed operator channel. Set ownership for the container user,");
    out("e.g. chown root:10003 on the directory and files. When CF Meet returns");
    out(FILES.clientCert + ", " + FILES.ca + " and " + FILES.hmac + ", place them here and run verify.");
  } catch (err) {
    // Remove only what this run created (each was created with flag "wx").
    for (const f of created.reverse()) { try { fs.chmodSync(f, 0o600); fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
    throw err;
  }
}

function verify(opts, out = console.log, now = Date.now()) {
  const file = (name) => path.join(opts.dir, name);
  const uri = workloadUri(opts.environment);
  const results = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      results.push({ name, ok: true, detail: detail || "" });
    } catch (err) {
      results.push({ name, ok: false, detail: reasonOf(err) });
    }
  };
  const UNAVAILABLE = new Error("CLIENT_CERT_UNAVAILABLE");

  let certPem = null;
  let cert = null;
  check("client_cert_file", () => {
    certPem = K.readSecretFile(file(FILES.clientCert), "CFMEET_BRIDGE_CLIENT_CERT_FILE");
    try { cert = new X509Certificate(certPem); } catch { throw new ConfigError("CFMEET_BRIDGE_CLIENT_CERT_INVALID"); }
    return "parses as X.509";
  });
  const withCert = (fn) => () => { if (!cert) throw UNAVAILABLE; return fn(); };

  // HQ's own startup check: currently valid, exactly one URI SAN equal to the
  // expected workload URI (no revocation list is configured yet).
  check("client_cert_startup_check", withCert(() => {
    checkClientCertificate(certPem, uri, [], now);
    return "currently valid, URI SAN " + uri;
  }));
  check("client_cert_san_exact", withCert(() => {
    const sans = String(cert.subjectAltName || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (sans.length !== 1 || sans[0] !== "URI:" + uri) throw new Error("CLIENT_CERT_SAN_NOT_EXACTLY_THE_EXPECTED_URI (found: " + (sans.join(" ") || "none") + ")");
    return "only URI:" + uri;
  }));
  check("client_cert_eku_client_auth", withCert(() => {
    const eku = cert.extKeyUsage || cert.keyUsage || [];
    if (!eku.includes(CLIENT_AUTH_OID)) throw new Error("CLIENT_CERT_EKU_CLIENT_AUTH_MISSING");
    return "clientAuth present";
  }));
  check("client_cert_min_validity", withCert(() => {
    const left = Date.parse(cert.validTo) - now;
    const days = (left / DAY_MS).toFixed(1);
    if (left < opts.minDays * DAY_MS) throw new Error("CLIENT_CERT_VALID_FOR_ONLY_" + days + "_DAYS_MIN_" + opts.minDays);
    return days + " days left (minimum " + opts.minDays + ")";
  }));
  check("client_key_matches_cert", withCert(() => {
    checkKeyPair(certPem, K.readSecretFile(file(FILES.clientKey), "CFMEET_BRIDGE_CLIENT_KEY_FILE"));
    return FILES.clientKey + " belongs to " + FILES.clientCert;
  }));

  let caPem = null;
  check("ca_bundle", () => {
    caPem = K.readSecretFile(file(FILES.ca), "CFMEET_BRIDGE_CA_FILE");
    checkCaBundle(caPem, now);
    return "CA certificate(s), at least one currently valid";
  });
  check("client_cert_chains_to_ca", withCert(() => {
    if (!caPem) throw new Error("CA_BUNDLE_UNAVAILABLE");
    const blocks = String(caPem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    for (const block of blocks) {
      let ca;
      try { ca = new X509Certificate(block); } catch { continue; }
      if (ca.ca && cert.checkIssued(ca) && cert.verify(ca.publicKey)) return "issued by " + ca.subject.replace(/\n/g, ", ");
    }
    throw new Error("CLIENT_CERT_NOT_ISSUED_BY_A_CA_IN_BUNDLE");
  }));

  check("hmac_key", () => {
    const key = K.loadBase64UrlKeyFile(file(FILES.hmac), "CFMEET_BRIDGE_HMAC_KEY_FILE");
    return key.length + " bytes after base64url decoding; sha256 of decoded key " + sha256Hex(key);
  });
  check("staff_key", () => {
    const key = K.loadEd25519PrivateKey(file(FILES.staffKey), "CFMEET_BRIDGE_STAFF_PRIVATE_KEY_FILE");
    return "Ed25519, kid " + opts.staffKid + ", public key " + rawEd25519PublicHex(key);
  });

  out("CF Meet Bridge enrolment check: " + opts.dir);
  out("  environment " + opts.environment + ", expected URI SAN " + uri + ", minimum validity " + opts.minDays + " days");
  out("");
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) out((r.ok ? "PASS " : "FAIL ") + r.name.padEnd(width) + "  " + r.detail);
  out("");
  if (cert) {
    out("client certificate sha256  " + fingerprintOf(cert));
    out("client certificate expires " + new Date(Date.parse(cert.validTo)).toISOString());
  }
  const failed = results.filter((r) => !r.ok);
  out(failed.length ? "RESULT: FAIL (" + failed.length + " of " + results.length + " checks failed)" : "RESULT: PASS (" + results.length + " checks)");
  return { ok: failed.length === 0, results };
}

function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseCli(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write("error: " + err.message + "\n\n" + USAGE);
    return 2;
  }
  if (opts.command === "help") { process.stdout.write(USAGE); return 0; }
  try {
    if (opts.command === "prepare") { prepare(opts); return 0; }
    return verify(opts).ok ? 0 : 1;
  } catch (err) {
    process.stderr.write("error: " + reasonOf(err) + "\n");
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { FILES, SUBJECT_CN, DEFAULT_STAFF_KID, workloadUri, csrSummary, rawEd25519PublicHex, prepare, verify, main };
