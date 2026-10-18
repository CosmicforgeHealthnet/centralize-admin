const dns = require("dns");
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");

const GUARD_SYMBOL = Symbol.for("cosmicforge.testNetworkGuard");
const BLOCK_CODE = "UNEXPECTED_EXTERNAL_NETWORK_REQUEST";
const DEFAULT_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MAX_SAFE_PATH_LENGTH = 160;

function lower(value) {
  return String(value || "").trim().toLowerCase();
}

function stripBrackets(hostname) {
  const host = lower(hostname);
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isLocalHostname(hostname) {
  const host = stripBrackets(hostname);
  return DEFAULT_LOCAL_HOSTS.has(host);
}

function isIpLiteral(hostname) {
  return net.isIP(stripBrackets(hostname)) !== 0;
}

function sanitizePathname(pathname) {
  const raw = String(pathname || "/").split("?")[0].split("#")[0] || "/";
  const sanitized = raw
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (/token|secret|password|signature|credential|authorization|cookie|code|key/i.test(segment)) {
        return "[redacted]";
      }
      if (segment.length > 80) return "[redacted]";
      return segment;
    })
    .join("/");
  return sanitized.length > MAX_SAFE_PATH_LENGTH
    ? `${sanitized.slice(0, MAX_SAFE_PATH_LENGTH)}...`
    : sanitized;
}

function safeUrlParts(input, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  try {
    const parsed = input instanceof URL ? input : new URL(String(input));
    return {
      method,
      host: stripBrackets(parsed.hostname) || "blocked-destination",
      port: parsed.port ? Number(parsed.port) : defaultPortForProtocol(parsed.protocol),
      protocol: parsed.protocol,
      path: sanitizePathname(parsed.pathname || "/"),
      hasEmbeddedCredentials: Boolean(parsed.username || parsed.password),
    };
  } catch {
    return {
      method,
      host: "blocked-destination",
      port: null,
      protocol: null,
      path: "/",
      hasEmbeddedCredentials: false,
    };
  }
}

function defaultPortForProtocol(protocol) {
  if (protocol === "https:") return 443;
  if (protocol === "http:") return 80;
  return null;
}

class NetworkGuardError extends Error {
  constructor({ api, method, host, path }) {
    super(
      `${BLOCK_CODE} api=${api || "unknown"} method=${method || "UNKNOWN"} host=${host || "blocked-destination"} path=${path || "/"}`,
    );
    this.name = "NetworkGuardError";
    this.code = BLOCK_CODE;
    this.api = api || "unknown";
    this.method = method || "UNKNOWN";
    this.host = host || "blocked-destination";
    this.path = path || "/";
  }
}

function isEnabledByEnv() {
  return lower(process.env.TEST_NETWORK_GUARD_ENABLED || "true") !== "false";
}

function parseDatabaseDestination() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) return null;
    const host = stripBrackets(parsed.hostname);
    const port = Number(parsed.port || 5432);
    if (!Number.isInteger(port) || port <= 0) return null;
    if (!isLocalHostname(host) && host !== "postgres") return null;
    return { host, port };
  } catch {
    return null;
  }
}

function createState() {
  return {
    installed: false,
    allowedLocalPorts: new Map(),
    stats: {
      blocked: 0,
      allowedLocal: 0,
      blockedApis: new Map(),
      allowedApis: new Map(),
    },
    originals: {},
  };
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function recordBlocked(state, api) {
  state.stats.blocked += 1;
  increment(state.stats.blockedApis, api || "unknown");
}

function recordAllowed(state, api) {
  state.stats.allowedLocal += 1;
  increment(state.stats.allowedApis, api || "unknown");
}

function isAllowedDestination(state, { host, port, api } = {}) {
  const normalizedHost = stripBrackets(host || "localhost");
  const numericPort = Number(port);
  const database = parseDatabaseDestination();
  if (
    database &&
    normalizedHost === database.host &&
    Number.isInteger(numericPort) &&
    numericPort === database.port
  ) {
    recordAllowed(state, api);
    return true;
  }
  if (
    isLocalHostname(normalizedHost) &&
    Number.isInteger(numericPort) &&
    state.allowedLocalPorts.has(numericPort)
  ) {
    recordAllowed(state, api);
    return true;
  }
  return false;
}

function blockedError(state, { api, method, host, path } = {}) {
  recordBlocked(state, api);
  return new NetworkGuardError({ api, method, host, path });
}

function assertAllowedUrl(state, input, options = {}, api = "request") {
  const parts = safeUrlParts(input, options);
  if (parts.hasEmbeddedCredentials) {
    throw blockedError(state, { api, method: parts.method, host: parts.host, path: parts.path });
  }
  if (!isAllowedDestination(state, { host: parts.host, port: parts.port, api })) {
    throw blockedError(state, { api, method: parts.method, host: parts.host, path: parts.path });
  }
  return parts;
}

function requestPartsFromArgs(args, protocol) {
  let input = args[0];
  let options = {};
  if (typeof input === "string" || input instanceof URL) {
    options = typeof args[1] === "object" && args[1] !== null ? args[1] : {};
    const parsed = input instanceof URL ? input : new URL(input);
    return safeUrlParts(parsed, {
      method: options.method || parsed.method || "GET",
    });
  }
  if (input && typeof input === "object") {
    options = input;
    const hostname = options.hostname || options.host || "localhost";
    const parsedProtocol = options.protocol || protocol;
    const port = Number(options.port || defaultPortForProtocol(parsedProtocol));
    const pathname = options.path || options.pathname || "/";
    return {
      method: String(options.method || "GET").toUpperCase(),
      host: stripBrackets(String(hostname).split(":")[0]),
      port,
      protocol: parsedProtocol,
      path: sanitizePathname(pathname),
      hasEmbeddedCredentials: Boolean(options.auth),
    };
  }
  return safeUrlParts("http://blocked-destination/", { method: "GET" });
}

function assertAllowedRequestArgs(state, args, protocol, api) {
  const parts = requestPartsFromArgs(args, protocol);
  if (parts.hasEmbeddedCredentials) {
    throw blockedError(state, { api, method: parts.method, host: parts.host, path: parts.path });
  }
  if (!isAllowedDestination(state, { host: parts.host, port: parts.port, api })) {
    throw blockedError(state, { api, method: parts.method, host: parts.host, path: parts.path });
  }
  return parts;
}

function socketPartsFromArgs(args) {
  const first = args[0];
  if (typeof first === "string") return { path: first };
  if (typeof first === "number") {
    const host = typeof args[1] === "string" ? args[1] : "localhost";
    return { host: stripBrackets(host), port: first };
  }
  if (first && typeof first === "object") {
    if (first.path && !first.port) return { path: first.path };
    return {
      host: stripBrackets(first.host || first.hostname || first.servername || "localhost"),
      port: Number(first.port),
    };
  }
  return { host: "blocked-destination", port: null };
}

function assertAllowedSocketArgs(state, args, api) {
  const parts = socketPartsFromArgs(args);
  if (parts.path) return parts;
  if (!isAllowedDestination(state, { host: parts.host, port: parts.port, api })) {
    throw blockedError(state, { api, method: "CONNECT", host: parts.host, path: "/" });
  }
  return parts;
}

function patchHttpModule(state, moduleRef, protocol, apiPrefix) {
  const originalRequest = moduleRef.request;
  const originalGet = moduleRef.get;
  state.originals[`${apiPrefix}.request`] = originalRequest;
  state.originals[`${apiPrefix}.get`] = originalGet;

  moduleRef.request = function guardedRequest(...args) {
    assertAllowedRequestArgs(state, args, protocol, `${apiPrefix}.request`);
    return originalRequest.apply(this, args);
  };

  moduleRef.get = function guardedGet(...args) {
    assertAllowedRequestArgs(state, args, protocol, `${apiPrefix}.get`);
    return originalGet.apply(this, args);
  };
}

function patchFetch(state) {
  if (typeof globalThis.fetch !== "function") return;
  const originalFetch = globalThis.fetch;
  state.originals.fetch = originalFetch;
  globalThis.fetch = async function guardedFetch(input, init = {}) {
    const method =
      init?.method ||
      (input && typeof input === "object" && "method" in input ? input.method : "GET");
    const url =
      typeof input === "string" || input instanceof URL
        ? input
        : input && typeof input === "object" && "url" in input
          ? input.url
          : "http://blocked-destination/";
    assertAllowedUrl(state, url, { method }, "fetch");
    return originalFetch.call(this, input, init);
  };
}

function patchSockets(state) {
  state.originals.netConnect = net.connect;
  state.originals.netCreateConnection = net.createConnection;
  state.originals.tlsConnect = tls.connect;
  state.originals.serverListen = net.Server.prototype.listen;
  state.originals.serverClose = net.Server.prototype.close;

  net.connect = function guardedNetConnect(...args) {
    assertAllowedSocketArgs(state, args, "net.connect");
    return state.originals.netConnect.apply(this, args);
  };
  net.createConnection = function guardedCreateConnection(...args) {
    assertAllowedSocketArgs(state, args, "net.createConnection");
    return state.originals.netCreateConnection.apply(this, args);
  };
  tls.connect = function guardedTlsConnect(...args) {
    assertAllowedSocketArgs(state, args, "tls.connect");
    return state.originals.tlsConnect.apply(this, args);
  };

  net.Server.prototype.listen = function guardedListen(...args) {
    const server = this;
    server.once("listening", () => {
      const address = server.address();
      if (address && typeof address === "object" && Number.isInteger(address.port)) {
        const port = address.port;
        state.allowedLocalPorts.set(port, (state.allowedLocalPorts.get(port) || 0) + 1);
        server.once("close", () => {
          const count = state.allowedLocalPorts.get(port) || 0;
          if (count <= 1) state.allowedLocalPorts.delete(port);
          else state.allowedLocalPorts.set(port, count - 1);
        });
      }
    });
    return state.originals.serverListen.apply(this, args);
  };
}

function patchDns(state) {
  state.originals.dnsLookup = dns.lookup;
  state.originals.dnsPromisesLookup = dns.promises?.lookup;
  state.originals.dnsResolve = dns.resolve;

  function assertAllowedDns(hostname, api) {
    const host = stripBrackets(hostname);
    const database = parseDatabaseDestination();
    if (isLocalHostname(host) || (database && host === database.host)) return true;
    if (isIpLiteral(host)) return true;
    throw blockedError(state, { api, method: "LOOKUP", host, path: "/" });
  }

  dns.lookup = function guardedLookup(hostname, options, callback) {
    const cb = typeof options === "function" ? options : callback;
    try {
      assertAllowedDns(hostname, "dns.lookup");
    } catch (error) {
      if (typeof cb === "function") {
        process.nextTick(() => cb(error));
        return {};
      }
      throw error;
    }
    return state.originals.dnsLookup.apply(this, arguments);
  };

  if (dns.promises && typeof dns.promises.lookup === "function") {
    dns.promises.lookup = async function guardedPromisesLookup(hostname, options) {
      assertAllowedDns(hostname, "dns.promises.lookup");
      return state.originals.dnsPromisesLookup.call(this, hostname, options);
    };
  }

  dns.resolve = function guardedResolve(hostname, ...args) {
    try {
      assertAllowedDns(hostname, "dns.resolve");
    } catch (error) {
      const cb = args.find((arg) => typeof arg === "function");
      if (cb) {
        process.nextTick(() => cb(error));
        return {};
      }
      throw error;
    }
    return state.originals.dnsResolve.apply(this, [hostname, ...args]);
  };
}

function patchUndiciIfAvailable(state) {
  try {
    const undici = require("undici");
    for (const name of ["fetch", "request", "stream", "pipeline", "connect"]) {
      if (typeof undici[name] !== "function") continue;
      const original = undici[name];
      state.originals[`undici.${name}`] = original;
      undici[name] = function guardedUndici(input, options = {}, ...rest) {
        assertAllowedUrl(state, input, { method: options?.method || "GET" }, `undici.${name}`);
        return original.call(this, input, options, ...rest);
      };
    }
    state.undiciPatched = true;
  } catch {
    state.undiciPatched = false;
  }
}

function install() {
  if (!globalThis[GUARD_SYMBOL]) {
    globalThis[GUARD_SYMBOL] = createState();
  }
  const state = globalThis[GUARD_SYMBOL];
  if (state.installed || !isEnabledByEnv()) return state;

  process.env.TEST_NETWORK_GUARD_ENABLED = "true";
  patchHttpModule(state, http, "http:", "http");
  patchHttpModule(state, https, "https:", "https");
  patchFetch(state);
  patchSockets(state);
  patchDns(state);
  patchUndiciIfAvailable(state);
  state.installed = true;
  return state;
}

function resetStats() {
  const state = install();
  state.stats.blocked = 0;
  state.stats.allowedLocal = 0;
  state.stats.blockedApis.clear();
  state.stats.allowedApis.clear();
}

function stats() {
  const state = install();
  return {
    blocked: state.stats.blocked,
    allowedLocal: state.stats.allowedLocal,
    blockedApis: Object.fromEntries(state.stats.blockedApis),
    allowedApis: Object.fromEntries(state.stats.allowedApis),
    undiciPatched: Boolean(state.undiciPatched),
    registeredLocalPorts: [...state.allowedLocalPorts.keys()].sort((a, b) => a - b),
  };
}

function registerLocalPort(port) {
  const state = install();
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0) {
    throw new Error("registerLocalPort requires a positive numeric port");
  }
  state.allowedLocalPorts.set(numericPort, (state.allowedLocalPorts.get(numericPort) || 0) + 1);
  return () => {
    const count = state.allowedLocalPorts.get(numericPort) || 0;
    if (count <= 1) state.allowedLocalPorts.delete(numericPort);
    else state.allowedLocalPorts.set(numericPort, count - 1);
  };
}

install();

module.exports = {
  BLOCK_CODE,
  NetworkGuardError,
  install,
  resetStats,
  stats,
  registerLocalPort,
  isLocalHostname,
  parseDatabaseDestination,
};
