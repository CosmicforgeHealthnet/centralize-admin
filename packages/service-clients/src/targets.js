"use strict";

// Fixed private destinations. A target is built once from operator
// configuration (never from user input, a manifest or a response) and pins
// the network address so DNS is never consulted at request time (no DNS
// rebinding). Public addresses, link-local/metadata ranges, credentials in
// URLs, paths, queries and fragments are all refused.

const net = require("node:net");
const { X509Certificate } = require("node:crypto");

class TargetError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "TargetError";
    this.reason = reason;
  }
}

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4(ip, cidr) {
  const [base, bits] = cidr.split("/");
  const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8"];
const FORBIDDEN_V4 = ["169.254.0.0/16", "0.0.0.0/8", "100.64.0.0/10", "224.0.0.0/4", "255.255.255.255/32"];

function isLoopback(ip) {
  return (net.isIPv4(ip) && inV4(ip, "127.0.0.0/8")) || ip === "::1";
}

// Private, routable-only-internally addresses. Link-local (cloud metadata),
// CGNAT, multicast and unspecified addresses are never allowed.
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    if (FORBIDDEN_V4.some((cidr) => inV4(ip, cidr))) return false;
    return PRIVATE_V4.some((cidr) => inV4(ip, cidr));
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
    return /^f[cd][0-9a-f]{2}:/.test(lower);
  }
  return false;
}

function fingerprint256(pem) {
  return new X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();
}

/**
 * spec: {
 *   ref, transport: "unix" | "https" | "http-loopback",
 *   socketPath,                         (unix)
 *   origin, address, serverName,        (https / http-loopback)
 *   tls: { ca, cert, key, serverFingerprint256 }  (https; PEM buffers)
 * }
 * http-loopback is for disposable test environments only and must be
 * explicitly allowed by the caller.
 */
function createFixedTarget(spec, { allowInsecureLoopback = false } = {}) {
  if (!spec || typeof spec !== "object") throw new TargetError("TARGET_INVALID");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(spec.ref))) throw new TargetError("TARGET_REF_INVALID");
  if (spec.transport === "unix") {
    const socketPath = String(spec.socketPath || "");
    if (!socketPath.startsWith("/") || socketPath.includes("..") || socketPath.length > 100) throw new TargetError("SOCKET_PATH_INVALID");
    return Object.freeze({ ref: spec.ref, transport: "unix", socketPath, hostHeader: "product-admin.local" });
  }
  if (spec.transport !== "https" && spec.transport !== "http-loopback") throw new TargetError("TRANSPORT_INVALID");
  let origin;
  try { origin = new URL(spec.origin); } catch { throw new TargetError("ORIGIN_INVALID"); }
  if (origin.username || origin.password || origin.search || origin.hash || (origin.pathname !== "/" && origin.pathname !== "")) {
    throw new TargetError("ORIGIN_INVALID");
  }
  const address = String(spec.address || "");
  if (!net.isIP(address)) throw new TargetError("ADDRESS_MUST_BE_PINNED_IP");
  if (!isPrivateAddress(address)) throw new TargetError("ADDRESS_NOT_PRIVATE");
  const port = Number(origin.port || (origin.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TargetError("PORT_INVALID");

  if (spec.transport === "http-loopback") {
    if (!allowInsecureLoopback || origin.protocol !== "http:" || !isLoopback(address)) throw new TargetError("INSECURE_TRANSPORT_REFUSED");
    return Object.freeze({ ref: spec.ref, transport: "http-loopback", address, port, hostHeader: origin.host });
  }
  if (origin.protocol !== "https:") throw new TargetError("HTTPS_REQUIRED");
  const tls = spec.tls || {};
  if (!tls.ca || !tls.cert || !tls.key) throw new TargetError("MTLS_MATERIAL_REQUIRED");
  const pin = tls.serverFingerprint256 ? String(tls.serverFingerprint256).replace(/:/g, "").toLowerCase() : null;
  if (pin && !/^[0-9a-f]{64}$/.test(pin)) throw new TargetError("FINGERPRINT_INVALID");
  return Object.freeze({
    ref: spec.ref, transport: "https", address, port, hostHeader: origin.host,
    serverName: spec.serverName || origin.hostname,
    tls: Object.freeze({ ca: tls.ca, cert: tls.cert, key: tls.key, serverFingerprint256: pin }),
  });
}

module.exports = { TargetError, isPrivateAddress, isLoopback, createFixedTarget, fingerprint256 };
