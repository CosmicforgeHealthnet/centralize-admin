"use strict";

// Attachment safety: type/size policy plus malware scanning. Anything not
// positively CLEAN stays quarantined (fail closed), including when no scanner
// is configured.

const net = require("net");

const BLOCKED_EXTENSIONS = new Set([
  "exe", "dll", "com", "bat", "cmd", "scr", "pif", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msp",
  "ps1", "psm1", "hta", "cpl", "jar", "lnk", "reg", "sh", "app", "apk", "iso", "img", "vhd", "xll", "docm", "xlsm", "pptm",
]);
const BLOCKED_TYPES = new Set([
  "application/x-msdownload", "application/x-ms-installer", "application/x-sh", "application/java-archive",
  "application/x-dosexec", "application/hta", "text/javascript", "application/javascript",
]);
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

function extensionOf(filename) {
  const name = String(filename || "").toLowerCase();
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1);
}

function sniffExecutable(buffer) {
  if (!buffer || buffer.length < 4) return false;
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) return true; // MZ (PE)
  if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) return true; // ELF
  return false;
}

function policyCheck({ filename, contentType, buffer, maxBytes }) {
  const extension = extensionOf(filename);
  if (buffer.length > maxBytes) return { allowed: false, reason: "SIZE_LIMIT" };
  if (BLOCKED_EXTENSIONS.has(extension)) return { allowed: false, reason: `BLOCKED_EXTENSION_${extension.toUpperCase()}` };
  if (BLOCKED_TYPES.has(String(contentType || "").toLowerCase())) return { allowed: false, reason: "BLOCKED_CONTENT_TYPE" };
  if (sniffExecutable(buffer)) return { allowed: false, reason: "EXECUTABLE_CONTENT" };
  return { allowed: true, reason: null };
}

function createScanMetrics() {
  return { scans: 0, clean: 0, infected: 0, failed: 0, unavailable: 0, oversize: 0, lastLatencyMs: null, lastFailure: null, lastFailureAt: null };
}

function unavailableScanner() {
  return {
    name: "unavailable",
    available: false,
    metrics: createScanMetrics(),
    async scan() {
      return { status: "SCANNER_UNAVAILABLE", detail: "no scanner configured" };
    },
    async health() {
      return { ok: false, detail: "no scanner configured" };
    },
  };
}

// Deterministic signature scanner for automated tests and local development
// only. Detects the EICAR test string. Refused in production.
function signatureScanner() {
  return {
    name: "test-signature",
    available: true,
    metrics: createScanMetrics(),
    async scan(buffer) {
      return buffer.includes(Buffer.from(EICAR)) ? { status: "INFECTED", detail: "EICAR-Test-Signature" } : { status: "CLEAN", detail: "test-signature" };
    },
    async health() {
      return { ok: true, detail: "test-signature" };
    },
  };
}

// Strict clamd reply parsing. Only an exact "stream: OK" is CLEAN.
function parseClamdReply(reply) {
  const text = String(reply || "").replace(/\0+$/, "").trim();
  if (text === "stream: OK") return { status: "CLEAN", detail: "clamd" };
  const found = /^stream: (.{1,200}) FOUND$/.exec(text);
  if (found) return { status: "INFECTED", detail: found[1] };
  if (/size limit exceeded/i.test(text)) return { status: "SCAN_FAILED", detail: "CLAMD_STREAM_LIMIT" };
  if (/ERROR$/.test(text)) return { status: "SCAN_FAILED", detail: `CLAMD_ERROR ${text.slice(0, 120)}` };
  return { status: "SCAN_FAILED", detail: text ? `CLAMD_UNEXPECTED_REPLY ${text.slice(0, 120)}` : "CLAMD_EMPTY_REPLY" };
}

// ClamAV clamd over TCP (z-prefixed, NUL-terminated commands). Every failure
// mode (connect error, timeout, oversize, malformed reply) is reported as a
// non-CLEAN status so the attachment stays quarantined.
function clamdScanner({ host, port, timeoutMs = 15000, connectTimeoutMs = 3000, maxStreamBytes = 25 * 1024 * 1024, chunkBytes = 64 * 1024, healthCacheMs = 30000, logger, clock = () => Date.now() }) {
  const metrics = createScanMetrics();
  let healthCache = null;

  function exchange(command, { stream } = {}) {
    return new Promise((resolve) => {
      const chunks = [];
      let settled = false;
      let connected = false;
      const socket = net.createConnection({ host, port });
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(deadline);
        socket.destroy();
        resolve(result);
      };
      const connectTimer = setTimeout(() => finish({ error: "CONNECT_TIMEOUT" }), connectTimeoutMs);
      // Hard deadline for the whole exchange (not an idle timeout), so a slow
      // trickle from clamd cannot keep a scan open indefinitely.
      const deadline = setTimeout(() => finish({ error: "TIMEOUT" }), timeoutMs);
      socket.on("error", (error) => {
        // clamd may close early (e.g. stream limit) after replying; prefer the reply.
        if (chunks.length) return finish({ reply: Buffer.concat(chunks).toString("utf8") });
        finish({ error: connected ? `SOCKET_${error.code || "ERROR"}` : "CONNECTION_FAILED" });
      });
      socket.on("data", (chunk) => {
        chunks.push(chunk);
        if (chunk.includes(0)) finish({ reply: Buffer.concat(chunks).toString("utf8") });
      });
      socket.on("end", () => finish(chunks.length ? { reply: Buffer.concat(chunks).toString("utf8") } : { error: "EMPTY_REPLY" }));
      socket.on("connect", async () => {
        connected = true;
        clearTimeout(connectTimer);
        const write = (data) => new Promise((done) => {
          if (settled || socket.destroyed) return done(false);
          if (socket.write(data)) return done(true);
          socket.once("drain", () => done(true));
        });
        await write(Buffer.from(`z${command}\0`));
        if (!stream) return;
        for (let offset = 0; offset < stream.length && !settled; offset += chunkBytes) {
          const chunk = stream.subarray(offset, offset + chunkBytes);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          if (!(await write(Buffer.concat([size, chunk])))) return;
        }
        await write(Buffer.alloc(4));
      });
    });
  }

  function recordFailure(detail) {
    metrics.lastFailure = detail;
    metrics.lastFailureAt = new Date(clock()).toISOString();
  }

  return {
    name: "clamd",
    available: true,
    metrics,
    async scan(buffer) {
      metrics.scans += 1;
      if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || "");
      if (buffer.length > maxStreamBytes) {
        metrics.oversize += 1;
        metrics.failed += 1;
        recordFailure("OVERSIZE_NOT_SCANNED");
        logger?.warn?.(`[MailScanner] attachment of ${buffer.length} bytes exceeds MAIL_SCANNER_MAX_STREAM_BYTES; quarantined unscanned`);
        return { status: "SCAN_FAILED", detail: "OVERSIZE_NOT_SCANNED" };
      }
      const started = clock();
      const outcome = await exchange("INSTREAM", { stream: buffer });
      metrics.lastLatencyMs = clock() - started;
      if (outcome.error) {
        const unavailable = ["CONNECTION_FAILED", "CONNECT_TIMEOUT"].includes(outcome.error);
        metrics[unavailable ? "unavailable" : "failed"] += 1;
        recordFailure(outcome.error);
        logger?.warn?.(`[MailScanner] clamd scan failed: ${outcome.error}`);
        return { status: unavailable ? "SCANNER_UNAVAILABLE" : "SCAN_FAILED", detail: `CLAMD_${outcome.error}` };
      }
      const result = parseClamdReply(outcome.reply);
      if (result.status === "CLEAN") metrics.clean += 1;
      else if (result.status === "INFECTED") {
        metrics.infected += 1;
        logger?.warn?.(`[MailScanner] malware detected: ${result.detail}`);
      } else {
        metrics.failed += 1;
        recordFailure(result.detail);
        logger?.warn?.(`[MailScanner] clamd returned a non-clean reply: ${result.detail}`);
      }
      return result;
    },
    async ping() {
      const outcome = await exchange("PING");
      return !outcome.error && String(outcome.reply).replace(/\0+$/, "").trim() === "PONG";
    },
    async version() {
      const outcome = await exchange("VERSION");
      if (outcome.error) return null;
      const text = String(outcome.reply).replace(/\0+$/, "").trim();
      return /^ClamAV /.test(text) ? text.slice(0, 120) : null;
    },
    async health() {
      if (healthCache && clock() - healthCache.at < healthCacheMs) return healthCache.result;
      const pong = await this.ping();
      const version = pong ? await this.version() : null;
      const result = pong ? { ok: true, detail: "pong", version } : { ok: false, detail: "clamd unreachable" };
      healthCache = { at: clock(), result };
      return result;
    },
  };
}

function createAttachmentScanner({ config, scanner, logger } = {}) {
  if (scanner) return scanner;
  const scanning = config.scanning;
  if (scanning.provider === "clamd") {
    return clamdScanner({ host: scanning.clamdHost, port: scanning.clamdPort, timeoutMs: scanning.timeoutMs, connectTimeoutMs: scanning.connectTimeoutMs, maxStreamBytes: scanning.maxStreamBytes, healthCacheMs: scanning.healthCacheMs, logger });
  }
  if (scanning.provider === "test-signature" && process.env.NODE_ENV !== "production") return signatureScanner();
  return unavailableScanner();
}

async function evaluateAttachment(scanner, { filename, contentType, buffer, maxBytes }) {
  const policy = policyCheck({ filename, contentType, buffer, maxBytes });
  if (!policy.allowed) return { scanStatus: "INFECTED", scanDetail: policy.reason, quarantined: true };
  let result;
  try {
    result = await scanner.scan(buffer, { filename, contentType });
  } catch {
    result = { status: "SCAN_FAILED", detail: "scanner error" };
  }
  return { scanStatus: result.status, scanDetail: String(result.detail || "").slice(0, 255), quarantined: result.status !== "CLEAN" };
}

module.exports = { createAttachmentScanner, evaluateAttachment, policyCheck, signatureScanner, unavailableScanner, clamdScanner, parseClamdReply, EICAR, BLOCKED_EXTENSIONS };
