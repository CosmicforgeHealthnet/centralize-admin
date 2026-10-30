"use strict";

// Generates a throwaway CA, server and client certificate with openssl for
// TLS tests. Material lives in a temp directory and is never committed.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function generatePki({ serverName = "product-admin.internal" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-pki-"));
  const run = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  const file = (name) => path.join(dir, name);
  run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key");
  run("req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "2", "-subj", "/CN=cf-test-ca", "-out", "ca.pem");
  const issue = (name, subject, ext) => {
    fs.writeFileSync(file(name + ".ext"), ext);
    run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", name + ".key");
    run("req", "-new", "-key", name + ".key", "-subj", subject, "-out", name + ".csr");
    run("x509", "-req", "-in", name + ".csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-sha256", "-extfile", name + ".ext", "-out", name + ".pem");
  };
  issue("server", "/CN=" + serverName, "subjectAltName=DNS:" + serverName + "\nextendedKeyUsage=serverAuth\n");
  issue("client", "/CN=cosmicforge-hq-product-integration-core", "subjectAltName=URI:cf://test/hq/product-integration-core\nextendedKeyUsage=clientAuth\n");
  issue("rogue", "/CN=" + serverName, "subjectAltName=DNS:" + serverName + "\nextendedKeyUsage=serverAuth\n");
  const read = (name) => fs.readFileSync(file(name));
  const material = {
    dir, serverName,
    ca: read("ca.pem"), serverCert: read("server.pem"), serverKey: read("server.key"),
    clientCert: read("client.pem"), clientKey: read("client.key"),
    rogueCert: read("rogue.pem"), rogueKey: read("rogue.key"),
  };
  material.cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return material;
}

module.exports = { generatePki };
