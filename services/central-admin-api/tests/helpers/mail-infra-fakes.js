"use strict";

// Offline stand-ins for S3, AWS KMS and clamd, bound to 127.0.0.1 only.
// They verify what the real services would reject (SigV4 signatures, private
// ACLs, checksums, encryption context) so the adapters are tested without any
// external network access.

const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { signRequest } = require("../../src/modules/mail/security/aws-sigv4");
const { EICAR } = require("../../src/modules/mail/scanning/attachment-scanner");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Recomputes the SigV4 signature from the received request and compares it.
function verifySigV4(req, body, { region, service, credentials }) {
  const header = String(req.headers.authorization || "");
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(header);
  if (!match) return { ok: false, reason: "malformed authorization" };
  const [, accessKeyId, , signedRegion, signedService, signedHeaders, signature] = match;
  if (accessKeyId !== credentials.accessKeyId || signedRegion !== region || signedService !== service) return { ok: false, reason: "scope mismatch" };
  const date = String(req.headers["x-amz-date"] || "");
  const now = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
  const headers = {};
  for (const name of signedHeaders.split(";")) {
    if (["host", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token"].includes(name)) continue;
    headers[name] = req.headers[name];
  }
  const url = `http://${req.headers.host}${req.url}`;
  const payloadHash = service === "s3" ? req.headers["x-amz-content-sha256"] : undefined;
  if (service === "s3" && payloadHash !== crypto.createHash("sha256").update(body).digest("hex")) return { ok: false, reason: "payload hash mismatch" };
  const expected = signRequest({ method: req.method, url, headers, body, region, service, credentials, now, payloadHash });
  return expected.signature === signature ? { ok: true, signedHeaders } : { ok: false, reason: "signature mismatch" };
}

async function startFakeS3({ region = "us-east-1", bucket = "cf-mail-test", credentials = { accessKeyId: "AKIDTESTMAIL", secretAccessKey: "test-secret-key" } } = {}) {
  const objects = new Map(); // key -> Buffer (exposed so tests can inspect raw stored bytes)
  const meta = new Map(); // key -> { sha, acl, sse, sseKmsKeyId }
  const requests = [];
  const faults = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, "http://fake");
    const [, requestBucket, ...rest] = url.pathname.split("/");
    const key = rest.map(decodeURIComponent).join("/");
    const auth = verifySigV4(req, body, { region, service: "s3", credentials });
    requests.push({ method: req.method, key, headers: { ...req.headers }, signature: auth });
    const fault = faults.shift();
    if (fault?.delayMs) await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    if (fault?.status) {
      res.writeHead(fault.status).end("<Error><Code>Injected</Code></Error>");
      return;
    }
    if (!auth.ok) return res.writeHead(403).end(`<Error><Code>SignatureDoesNotMatch</Code><Message>${auth.reason}</Message></Error>`);
    if (requestBucket !== bucket) return res.writeHead(404).end("<Error><Code>NoSuchBucket</Code></Error>");
    if (req.method === "HEAD" && !key) return res.writeHead(200).end();
    if (req.method === "PUT") {
      const acl = req.headers["x-amz-acl"];
      if (acl && acl !== "private") return res.writeHead(403).end("<Error><Code>AccessDenied</Code><Message>public ACLs are blocked</Message></Error>");
      if (req.headers["if-none-match"] === "*" && objects.has(key)) return res.writeHead(412).end("<Error><Code>PreconditionFailed</Code></Error>");
      const checksum = req.headers["x-amz-checksum-sha256"];
      if (checksum && checksum !== crypto.createHash("sha256").update(body).digest("base64")) return res.writeHead(400).end("<Error><Code>BadDigest</Code></Error>");
      objects.set(key, body);
      meta.set(key, { sha: req.headers["x-amz-meta-cf-envelope-sha256"], acl: acl || null, sse: req.headers["x-amz-server-side-encryption"] || null, sseKmsKeyId: req.headers["x-amz-server-side-encryption-aws-kms-key-id"] || null });
      return res.writeHead(200, { etag: '"x"' }).end();
    }
    if (req.method === "GET") {
      if (!objects.has(key)) return res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
      const headers = { "content-type": "application/octet-stream" };
      if (meta.get(key)?.sha) headers["x-amz-meta-cf-envelope-sha256"] = meta.get(key).sha;
      return res.writeHead(200, headers).end(objects.get(key));
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      meta.delete(key);
      return res.writeHead(204).end();
    }
    return res.writeHead(405).end();
  });
  const port = await listen(server);
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    region,
    credentials,
    objects,
    meta,
    requests,
    fault: (entry) => faults.push(entry),
    config: (extra = {}) => ({ endpoint: `http://127.0.0.1:${port}`, region, bucket, prefix: "", accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, healthCacheMs: 0, timeoutMs: 1000, maxRetries: 2, ...extra }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function contextAad(context) {
  return Buffer.from(JSON.stringify(Object.keys(context || {}).sort().map((key) => [key, context[key]])));
}

async function startFakeKms({ region = "us-east-1", credentials = { accessKeyId: "AKIDTESTKMS", secretAccessKey: "kms-test-secret" }, keyIds = ["alias/cf-mail-test"] } = {}) {
  const masters = new Map(keyIds.map((id) => [id, crypto.randomBytes(32)]));
  const requests = [];
  let down = false;
  function wrap(keyId, plaintext, context) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", masters.get(keyId), iv);
    cipher.setAAD(contextAad(context));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const id = Buffer.from(keyId);
    return Buffer.concat([Buffer.from([id.length]), id, iv, cipher.getAuthTag(), body]);
  }
  function unwrap(blob, context) {
    const idLength = blob[0];
    const keyId = blob.subarray(1, 1 + idLength).toString();
    const master = masters.get(keyId);
    if (!master) throw new Error("NotFoundException");
    const offset = 1 + idLength;
    const decipher = crypto.createDecipheriv("aes-256-gcm", master, blob.subarray(offset, offset + 12));
    decipher.setAAD(contextAad(context));
    decipher.setAuthTag(blob.subarray(offset + 12, offset + 28));
    return { keyId, plaintext: Buffer.concat([decipher.update(blob.subarray(offset + 28)), decipher.final()]) };
  }
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const target = String(req.headers["x-amz-target"] || "").replace("TrentService.", "");
    const auth = verifySigV4(req, body, { region, service: "kms", credentials });
    let payload = {};
    try {
      payload = JSON.parse(body.toString("utf8") || "{}");
    } catch {
      payload = {};
    }
    requests.push({ target, signature: auth, context: payload.EncryptionContext || null, keyId: payload.KeyId || null });
    const reply = (status, value) => res.writeHead(status, { "content-type": "application/x-amz-json-1.1" }).end(JSON.stringify(value));
    if (down) return reply(503, { __type: "KMSInternalException" });
    if (!auth.ok) return reply(400, { __type: "com.amazon.coral.service#InvalidSignatureException", message: auth.reason });
    try {
      if (target === "GenerateDataKey") {
        if (!masters.has(payload.KeyId)) return reply(400, { __type: "NotFoundException" });
        const plaintext = crypto.randomBytes(32);
        return reply(200, { KeyId: payload.KeyId, Plaintext: plaintext.toString("base64"), CiphertextBlob: wrap(payload.KeyId, plaintext, payload.EncryptionContext).toString("base64") });
      }
      if (target === "Decrypt") {
        const { keyId, plaintext } = unwrap(Buffer.from(payload.CiphertextBlob, "base64"), payload.EncryptionContext);
        if (payload.KeyId && payload.KeyId !== keyId) return reply(400, { __type: "IncorrectKeyException" });
        return reply(200, { KeyId: keyId, Plaintext: plaintext.toString("base64") });
      }
    } catch {
      return reply(400, { __type: "InvalidCiphertextException" });
    }
    return reply(400, { __type: "UnsupportedOperationException" });
  });
  const port = await listen(server);
  return {
    endpoint: `http://127.0.0.1:${port}`,
    region,
    credentials,
    requests,
    wrap,
    setDown: (value) => {
      down = value;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// clamd speaking the INSTREAM protocol. `behaviour` decides the reply for each
// stream: "auto" (EICAR => FOUND, else OK), "error", "malformed", "hang",
// "close", "limit", "slow" (reads in tiny pieces then replies auto).
async function startFakeClamd({ behaviour = "auto", streamMaxLength = 25 * 1024 * 1024 } = {}) {
  const state = { behaviour, streams: [], connections: 0 };
  const server = net.createServer((socket) => {
    state.connections += 1;
    let buffer = Buffer.alloc(0);
    let command = null;
    const received = [];
    let total = 0;
    const mode = state.behaviour;
    if (mode === "slow") socket.setNoDelay(true);
    const reply = (text) => {
      if (!socket.destroyed) socket.end(`${text}\0`);
    };
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!command) {
        const end = buffer.indexOf(0);
        if (end === -1) return;
        command = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 1);
        if (command === "zPING") return reply("PONG");
        if (command === "zVERSION") return reply("ClamAV 1.4.1/27400/Mon Oct 20 08:00:00 2026");
        if (command !== "zINSTREAM") return reply("UNKNOWN COMMAND");
      }
      if (mode === "hang") return;
      if (mode === "close") return socket.destroy();
      if (mode === "slow") {
        socket.pause();
        setTimeout(() => socket.resume(), 2);
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          const content = Buffer.concat(received);
          state.streams.push({ bytes: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex") });
          if (mode === "error") return reply("stream: Can't allocate memory ERROR");
          if (mode === "malformed") return reply("I am not clamd");
          return reply(content.includes(Buffer.from(EICAR)) ? "stream: Win.Test.EICAR_HDB-1 FOUND" : "stream: OK");
        }
        if (buffer.length < 4 + size) return;
        received.push(buffer.subarray(4, 4 + size));
        total += size;
        buffer = buffer.subarray(4 + size);
        if (mode === "limit" || total > streamMaxLength) return reply("INSTREAM size limit exceeded. ERROR");
      }
    });
  });
  const port = await listen(server);
  return {
    host: "127.0.0.1",
    port,
    state,
    setBehaviour: (value) => {
      state.behaviour = value;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// A port with nothing listening (connection refused). It is registered with
// the test network guard so the adapter sees a real ECONNREFUSED.
async function closedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  require("./network-guard").registerLocalPort(port);
  return port;
}

module.exports = { startFakeS3, startFakeKms, startFakeClamd, closedPort, verifySigV4 };
