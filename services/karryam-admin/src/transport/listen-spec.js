"use strict";

// Private-only listening. Default: a host-private Unix socket. TCP is only
// allowed on loopback or an explicit private (RFC1918 / ULA) address, and a
// non-loopback TCP listener must use TLS 1.3 mutual TLS. Wildcard and public
// addresses are refused so a misconfiguration can never expose the service.

const net = require("node:net");
const path = require("node:path");
const { clients } = require("../packages");
const { ConfigError } = require("../security/keys");

const DEFAULT_LISTEN = "unix:/run/cosmicforge/karryam-admin.sock";

function parseListen(value = DEFAULT_LISTEN) {
  const raw = String(value || DEFAULT_LISTEN).trim();
  if (raw.startsWith("unix:")) {
    const socketPath = raw.slice(5);
    if (!path.isAbsolute(socketPath) || socketPath.includes("..") || socketPath.length > 100 || socketPath.includes("\0")) {
      throw new ConfigError("LISTEN_SOCKET_PATH_INVALID");
    }
    return Object.freeze({ kind: "unix", path: socketPath });
  }
  const match = /^tcp:(\[[0-9a-fA-F:]+\]|[0-9.]+):([0-9]{1,5})$/.exec(raw);
  if (!match) throw new ConfigError("LISTEN_INVALID");
  const host = match[1].replace(/^\[|\]$/g, "");
  const port = Number(match[2]);
  if (!net.isIP(host)) throw new ConfigError("LISTEN_HOST_MUST_BE_IP");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("LISTEN_PORT_INVALID");
  if (!clients.isPrivateAddress(host)) throw new ConfigError("LISTEN_HOST_NOT_PRIVATE");
  return Object.freeze({ kind: "tcp", host, port, loopback: clients.isLoopback(host) });
}

module.exports = { parseListen, DEFAULT_LISTEN };
