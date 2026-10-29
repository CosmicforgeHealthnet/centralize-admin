#!/usr/bin/env node
"use strict";

// Self-hosted Mail keyring management (MAIL_KMS_PROVIDER=file). No cloud KMS.
// Runs on the server (inside the API image); key material never leaves the
// server except sealed to the offline recovery public key.
//
//   generate      --environment=<env> --out=<file>
//                 New keyring with one random 256-bit key (v1). Refuses to
//                 overwrite. Writes the file 0400.
//   import-env    --environment=<env> --out=<file>
//                 Converts an existing env keyring into a file, keeping the
//                 same keys so existing ciphertext stays readable. Reads
//                 MAIL_ENCRYPTION_KEYS / MAIL_ENCRYPTION_ACTIVE_KEY from the
//                 environment of this process (never from arguments).
//   add-key       --file=<file> [--activate]
//                 Rotation step 1: adds the next version (vN+1). With
//                 --activate new content is encrypted under it; then run
//                 `npm run mail:keys:rotate -- --apply` to rewrap old content.
//   activate      --file=<file> --version=<vN>
//   inspect       --file=<file>
//                 Environment, active version, versions and fingerprints.
//   seal          --file=<file> --recipient=<public.pem> --out=<escrow.json>
//                 Escrow: encrypts the keyring to the owner's offline RSA
//                 recovery key (>= 3072 bits).
//   verify-escrow --file=<file> --escrow=<escrow.json>
//                 Without any private key: the escrow holds exactly this
//                 keyring (environment, active version, fingerprints).
//   open          --escrow=<escrow.json> --private-key=<private.pem> --out=<file>
//                 Recovery (run where the private key is, never on a shared host).
//
// Output is JSON with fingerprints only. Exit 0 on success, 1 on failure.

const fs = require("fs");
const path = require("path");
const {
  newKeyringDocument,
  validateKeyringDocument,
  describeKeyring,
  nextVersion,
  sealKeyring,
  openEscrow,
  escrowMatches,
  FORMAT,
} = require("../../src/modules/mail/security/file-keyring");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (const arg of rest) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`Unknown argument ${arg}`);
    options[match[1]] = match[2] === undefined ? true : match[2];
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (!value || value === true) throw new Error(`--${name} is required`);
  return String(value);
}

function readDocument(file) {
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  validateKeyringDocument(document);
  return document;
}

// Writes atomically with mode 0400. `exclusive` refuses an existing file.
function writeDocument(file, document, { exclusive }) {
  validateKeyringDocument(document);
  const directory = path.dirname(path.resolve(file));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (exclusive && fs.existsSync(file)) throw new Error(`${file} already exists; refusing to overwrite a keyring`);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.tmp`);
  const handle = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(document, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.chmodSync(temporary, 0o400);
  if (exclusive) {
    fs.linkSync(temporary, file); // fails if the file appeared meanwhile
    fs.rmSync(temporary);
  } else {
    fs.renameSync(temporary, file);
  }
  const directoryHandle = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(directoryHandle);
  } catch {
    // not supported everywhere
  } finally {
    fs.closeSync(directoryHandle);
  }
}

function importEnv(environment, env = process.env) {
  const keys = {};
  for (const entry of String(env.MAIL_ENCRYPTION_KEYS || "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator <= 0) throw new Error("MAIL_ENCRYPTION_KEYS has an entry without a version");
    const version = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (value.startsWith("kms:")) throw new Error("KMS-wrapped keys cannot be imported; only raw env keys");
    keys[version] = value;
  }
  if (!Object.keys(keys).length) throw new Error("MAIL_ENCRYPTION_KEYS is empty");
  const active = String(env.MAIL_ENCRYPTION_ACTIVE_KEY || "") || Object.keys(keys).pop();
  return { format: FORMAT, environment, active, keys, createdAt: new Date().toISOString(), importedFrom: "env" };
}

function run(argv, { stdout = process.stdout, env = process.env } = {}) {
  const { command, options } = parseArgs(argv);
  const print = (value) => stdout.write(`${JSON.stringify(value)}\n`);
  switch (command) {
    case "generate": {
      const document = newKeyringDocument({ environment: required(options, "environment") });
      writeDocument(required(options, "out"), document, { exclusive: true });
      return print({ ok: true, action: "generated", ...describeKeyring(document) });
    }
    case "import-env": {
      const document = importEnv(required(options, "environment"), env);
      writeDocument(required(options, "out"), document, { exclusive: true });
      return print({ ok: true, action: "imported", ...describeKeyring(document) });
    }
    case "add-key": {
      const file = required(options, "file");
      const document = readDocument(file);
      const version = nextVersion(document);
      document.keys[version] = require("crypto").randomBytes(32).toString("base64");
      if (options.activate) document.active = version;
      document.updatedAt = new Date().toISOString();
      writeDocument(file, document, { exclusive: false });
      return print({ ok: true, action: "added", added: version, ...describeKeyring(document) });
    }
    case "activate": {
      const file = required(options, "file");
      const document = readDocument(file);
      const version = required(options, "version");
      if (!document.keys[version]) throw new Error(`${version} is not in the keyring`);
      document.active = version;
      document.updatedAt = new Date().toISOString();
      writeDocument(file, document, { exclusive: false });
      return print({ ok: true, action: "activated", ...describeKeyring(document) });
    }
    case "inspect":
      return print({ ok: true, ...describeKeyring(readDocument(required(options, "file"))) });
    case "seal": {
      const document = readDocument(required(options, "file"));
      const escrow = sealKeyring(document, fs.readFileSync(required(options, "recipient"), "utf8"));
      const out = required(options, "out");
      fs.writeFileSync(out, `${JSON.stringify(escrow)}\n`, { mode: 0o600 });
      return print({ ok: true, action: "sealed", environment: escrow.environment, active: escrow.active, versions: escrow.versions, recipient: escrow.recipient });
    }
    case "verify-escrow": {
      const document = readDocument(required(options, "file"));
      const escrow = JSON.parse(fs.readFileSync(required(options, "escrow"), "utf8"));
      const ok = escrowMatches(escrow, document);
      print({ ok, recipient: escrow.recipient || null, ...describeKeyring(document) });
      if (!ok) process.exitCode = 1;
      return undefined;
    }
    case "open": {
      const escrow = JSON.parse(fs.readFileSync(required(options, "escrow"), "utf8"));
      const document = openEscrow(escrow, fs.readFileSync(required(options, "private-key"), "utf8"));
      writeDocument(required(options, "out"), document, { exclusive: true });
      return print({ ok: true, action: "recovered", ...describeKeyring(document) });
    }
    default:
      throw new Error("Usage: keyring.js generate|import-env|add-key|activate|inspect|seal|verify-escrow|open [--options]");
  }
}

if (require.main === module) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`mail-keyring: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run, importEnv, writeDocument };
