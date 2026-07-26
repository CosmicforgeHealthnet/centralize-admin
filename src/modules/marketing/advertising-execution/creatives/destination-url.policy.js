const dns = require("dns").promises;
const net = require("net");
const { domainToASCII } = require("url");
const { executionError } = require("../execution.errors");

const SIGNED_OR_SECRET_QUERY_KEY = /(?:^|_)(?:access|auth|signature|signed|token|secret|key|expires?|password|credential)(?:_|$)/i;
const UTM_KEYS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]);
const INTERNAL_NAME = /(^|\.)(?:localhost|local|internal|intranet|home|lan|corp|test)$/i;
const MAX_PARAMETER_NAME = 64;
const MAX_PARAMETER_VALUE = 512;

function blockedIpv4(value) {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 || a >= 240 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}

function blockedIpv6(value) {
  const address = value.toLowerCase().split("%")[0];
  return address === "::" || address === "::1" || address.startsWith("fc") ||
    address.startsWith("fd") || /^fe[89ab]/.test(address) || address.startsWith("ff") ||
    (address.startsWith("::ffff:") && blockedIpv4(address.slice(7)));
}

function assertPublicAddress(address) {
  const family = net.isIP(address);
  if (!family || (family === 4 ? blockedIpv4(address) : blockedIpv6(address))) {
    throw executionError("INVALID_EXECUTION_PLAN", { field: "destinationUrl", reasonCode: "DESTINATION_ADDRESS_BLOCKED" });
  }
}

function normalizeAllowedDomains(domains) {
  return domains.map((domain) => domainToASCII(String(domain).trim().replace(/^\.+|\.+$/g, "").toLowerCase())).filter(Boolean);
}

function normalizeDestinationUrl(value, {
  allowedDomains = [], allowSubdomains = false, requireUtm = false,
  allowedUtmKeys = UTM_KEYS, allowedCustomParameters = [],
} = {}) {
  let url;
  try { url = new URL(String(value || "")); } catch (_error) {
    throw executionError("INVALID_EXECUTION_PLAN", { field: "destinationUrl", reasonCode: "INVALID_DESTINATION_URL" });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") {
    throw executionError("INVALID_EXECUTION_PLAN", { field: "destinationUrl", reasonCode: "HTTPS_DESTINATION_REQUIRED" });
  }
  const hostname = domainToASCII(url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, ""));
  if (!hostname || hostname.length > 253 || INTERNAL_NAME.test(hostname) || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw executionError("INVALID_EXECUTION_PLAN", { field: "destinationUrl", reasonCode: "DESTINATION_HOST_BLOCKED" });
  }
  if (net.isIP(hostname)) assertPublicAddress(hostname);
  const domains = normalizeAllowedDomains(allowedDomains);
  const domainAllowed = domains.some((domain) => hostname === domain || (allowSubdomains && hostname.endsWith(`.${domain}`)));
  if (!domainAllowed) throw executionError("INVALID_EXECUTION_PLAN", { field: "destinationUrl", reasonCode: "DESTINATION_DOMAIN_NOT_ALLOWED", hostname });

  const allowed = new Set([...allowedUtmKeys].map((key) => String(key).toLowerCase()));
  const custom = new Set(allowedCustomParameters.map((key) => String(key).toLowerCase()));
  const collected = new Map();
  let hasUtm = false;
  for (const [rawKey, rawValue] of url.searchParams.entries()) {
    const key = rawKey.toLowerCase();
    const valuePart = String(rawValue).normalize("NFC").trim();
    if (!key || key.length > MAX_PARAMETER_NAME || valuePart.length > MAX_PARAMETER_VALUE) {
      throw executionError("INVALID_EXECUTION_PLAN", { field: `destinationUrl.${key}`, reasonCode: "URL_PARAMETER_BOUNDS_EXCEEDED" });
    }
    if (SIGNED_OR_SECRET_QUERY_KEY.test(key) || SIGNED_OR_SECRET_QUERY_KEY.test(valuePart)) {
      throw executionError("INVALID_EXECUTION_PLAN", { field: `destinationUrl.${key}`, reasonCode: "SIGNED_OR_SECRET_URL_FORBIDDEN" });
    }
    if (key.startsWith("utm_")) {
      hasUtm = true;
      if (!allowed.has(key)) throw executionError("INVALID_EXECUTION_PLAN", { field: `destinationUrl.${key}`, reasonCode: "UTM_PARAMETER_NOT_ALLOWED" });
    } else if (!custom.has(key)) {
      throw executionError("INVALID_EXECUTION_PLAN", { field: `destinationUrl.${key}`, reasonCode: "CUSTOM_PARAMETER_NOT_ALLOWED" });
    }
    if (collected.has(key) && collected.get(key) !== valuePart) {
      throw executionError("INVALID_EXECUTION_PLAN", { field: `destinationUrl.${key}`, reasonCode: "CONFLICTING_DUPLICATE_PARAMETER" });
    }
    collected.set(key, valuePart);
  }
  if (requireUtm && !hasUtm) throw executionError("INVALID_EXECUTION_PLAN", { field: "destinationUrl", reasonCode: "UTM_PARAMETERS_REQUIRED" });
  url.hash = "";
  url.hostname = hostname;
  url.search = "";
  for (const [key, parameter] of [...collected].sort(([a], [b]) => a.localeCompare(b))) url.searchParams.set(key, parameter);
  return url.toString();
}

async function assertDestinationNetworkSafe(value, {
  resolver = dns.lookup, timeoutMs = 1500, maxAddresses = 8,
} = {}) {
  const url = new URL(value);
  if (net.isIP(url.hostname)) { assertPublicAddress(url.hostname); return value; }
  let timer;
  try {
    const records = await Promise.race([
      resolver(url.hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("DNS_TIMEOUT")), Math.min(Math.max(timeoutMs, 100), 5000)); }),
    ]);
    const addresses = (Array.isArray(records) ? records : [records]).slice(0, maxAddresses);
    if (!addresses.length) throw new Error("DNS_EMPTY");
    addresses.forEach((record) => assertPublicAddress(record.address || record));
    return value;
  } catch (error) {
    if (error?.errors?.[0]?.code === "INVALID_EXECUTION_PLAN") throw error;
    throw executionError("INVALID_EXECUTION_PLAN", { field: "destinationUrl", reasonCode: "DESTINATION_DNS_UNSAFE_OR_UNAVAILABLE" });
  } finally { clearTimeout(timer); }
}

async function validateRedirectChain(initialUrl, {
  fetchHeaders, policy, maxRedirects = 3,
} = {}) {
  if (typeof fetchHeaders !== "function") throw executionError("INVALID_EXECUTION_CONFIG", { reasonCode: "SAFE_REDIRECT_TRANSPORT_REQUIRED" });
  let current = normalizeDestinationUrl(initialUrl, policy);
  for (let redirects = 0; redirects <= Math.min(maxRedirects, 5); redirects += 1) {
    await assertDestinationNetworkSafe(current, policy);
    const result = await fetchHeaders(current, { redirect: "manual", maxResponseBytes: 0 });
    if (![301, 302, 303, 307, 308].includes(result.status)) return current;
    if (!result.location || redirects === maxRedirects) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "DESTINATION_REDIRECT_LIMIT" });
    current = normalizeDestinationUrl(new URL(result.location, current).toString(), policy);
  }
  return current;
}

module.exports = {
  SIGNED_OR_SECRET_QUERY_KEY, UTM_KEYS, blockedIpv4, blockedIpv6, assertPublicAddress,
  normalizeDestinationUrl, assertDestinationNetworkSafe, validateRedirectChain,
};
