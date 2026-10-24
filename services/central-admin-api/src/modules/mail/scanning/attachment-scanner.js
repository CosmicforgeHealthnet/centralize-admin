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

function unavailableScanner() {
  return { name: "unavailable", available: false, async scan() { return { status: "SCANNER_UNAVAILABLE", detail: "no scanner configured" }; } };
}

// Deterministic signature scanner for automated tests and local development
// only. Detects the EICAR test string. Refused in production.
function signatureScanner() {
  return {
    name: "test-signature",
    available: true,
    async scan(buffer) {
      return buffer.includes(Buffer.from(EICAR)) ? { status: "INFECTED", detail: "EICAR-Test-Signature" } : { status: "CLEAN", detail: "test-signature" };
    },
  };
}

// ClamAV clamd INSTREAM protocol over TCP.
function clamdScanner({ host, port, timeoutMs }) {
  return {
    name: "clamd",
    available: true,
    scan(buffer) {
      return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        let response = "";
        const done = (result) => {
          socket.destroy();
          resolve(result);
        };
        socket.setTimeout(timeoutMs, () => done({ status: "SCAN_FAILED", detail: "timeout" }));
        socket.on("error", () => done({ status: "SCANNER_UNAVAILABLE", detail: "connection failed" }));
        socket.on("data", (chunk) => {
          response += chunk.toString("utf8");
        });
        socket.on("end", () => {
          if (/: OK\0?\s*$/.test(response)) return done({ status: "CLEAN", detail: "clamd" });
          const match = response.match(/: (.+) FOUND/);
          if (match) return done({ status: "INFECTED", detail: match[1].slice(0, 200) });
          return done({ status: "SCAN_FAILED", detail: response.slice(0, 200) || "empty response" });
        });
        socket.on("connect", () => {
          socket.write("zINSTREAM\0");
          const chunkSize = 64 * 1024;
          for (let offset = 0; offset < buffer.length; offset += chunkSize) {
            const chunk = buffer.subarray(offset, offset + chunkSize);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(chunk.length);
            socket.write(size);
            socket.write(chunk);
          }
          socket.write(Buffer.alloc(4));
        });
      });
    },
  };
}

function createAttachmentScanner({ config, scanner } = {}) {
  if (scanner) return scanner;
  if (config.scanning.provider === "clamd") return clamdScanner({ host: config.scanning.clamdHost, port: config.scanning.clamdPort, timeoutMs: config.scanning.timeoutMs });
  if (config.scanning.provider === "test-signature" && process.env.NODE_ENV !== "production") return signatureScanner();
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

module.exports = { createAttachmentScanner, evaluateAttachment, policyCheck, signatureScanner, unavailableScanner, clamdScanner, EICAR, BLOCKED_EXTENSIONS };
