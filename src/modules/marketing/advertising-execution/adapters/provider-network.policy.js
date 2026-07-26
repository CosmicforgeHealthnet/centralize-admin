const dns = require("dns");
const net = require("net");
const { executionError } = require("../execution.errors");

const PROVIDER_HOSTS = Object.freeze({
  GOOGLE_ADS: Object.freeze(["googleads.googleapis.com", "oauth2.googleapis.com"]),
  META: Object.freeze(["graph.facebook.com"]),
  TIKTOK: Object.freeze(["business-api.tiktok.com"]),
  LINKEDIN: Object.freeze(["api.linkedin.com", "www.linkedin.com"]),
  X: Object.freeze(["ads-api.x.com"]),
});

function networkError(subject, reasonCode) { return executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: subject, reasonCode }); }

function assertPublicAddress(address, subject = "NETWORK") {
  const value = String(address || "").trim().toLowerCase();
  const family = net.isIP(value);
  if (!family) throw networkError(subject, "DNS_ADDRESS_INVALID");
  if (family === 4) {
    const octets = value.split(".").map(Number);
    const forbidden = octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224
      || octets[0] === 169 && octets[1] === 254 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
      || octets[0] === 192 && octets[1] === 168 || octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
      || octets[0] === 198 && [18, 19].includes(octets[1]);
    if (forbidden) throw networkError(subject, "PRIVATE_OR_RESERVED_ADDRESS_FORBIDDEN");
  } else if (value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb") || value.startsWith("ff")) {
    throw networkError(subject, "PRIVATE_OR_RESERVED_ADDRESS_FORBIDDEN");
  }
  return value;
}

function assertAllowedHttpsUrl(value, { allowedHosts, subject = "NETWORK" } = {}) {
  let url;
  try { url = new URL(value); } catch (_error) { throw networkError(subject, "INVALID_PROVIDER_ENDPOINT"); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || !allowedHosts?.map((host) => String(host).toLowerCase()).includes(hostname) || net.isIP(hostname)) throw networkError(subject, "UNAPPROVED_PROVIDER_ENDPOINT");
  return url;
}

function assertProviderUrl(provider, value) { return assertAllowedHttpsUrl(value, { allowedHosts: PROVIDER_HOSTS[provider], subject: provider }); }

function safeRedirectPolicy(provider, from, to) {
  const source = assertProviderUrl(provider, from);
  const destination = assertProviderUrl(provider, to);
  if (source.origin !== destination.origin) throw networkError(provider, "CROSS_ORIGIN_REDIRECT_FORBIDDEN");
  return destination;
}

function sanitizeHeaders(headers = {}) {
  const forbidden = /^(?:host|connection|proxy-authorization|proxy-authenticate|forwarded|x-forwarded-|transfer-encoding)/i;
  return Object.fromEntries(Object.entries(headers).filter(([key, value]) => !forbidden.test(key) && value != null).slice(0, 50).map(([key, value]) => [String(key).slice(0, 100), String(value).replace(/[\r\n]/g, "").slice(0, 8192)]));
}

function guardedLookup(subject) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...(typeof options === "object" ? options : {}), all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      try {
        const checked = addresses.map((entry) => ({ ...entry, address: assertPublicAddress(entry.address, subject) }));
        if (typeof options === "object" && options.all) return callback(null, checked);
        const selected = checked[0];
        return callback(null, selected.address, selected.family);
      } catch (policyError) { return callback(policyError); }
    });
  };
}

function createNetworkGuard({ provider = null, allowedHosts = null, subject = provider || "NETWORK", timeoutMs = 5000, maximumResponseBytes = 256 * 1024 } = {}) {
  const hosts = allowedHosts || PROVIDER_HOSTS[provider];
  if (!Array.isArray(hosts) || !hosts.length) throw networkError(subject, "PROVIDER_HOST_ALLOWLIST_REQUIRED");
  function assertUrl(value) { return provider ? assertProviderUrl(provider, value) : assertAllowedHttpsUrl(value, { allowedHosts: hosts, subject }); }
  function requestOptions(config = {}) {
    const url = assertUrl(config.url);
    return {
      ...config,
      url: url.toString(),
      headers: sanitizeHeaders(config.headers),
      timeout: Math.min(Math.max(Number(config.timeout) || timeoutMs, 500), 10000),
      maxRedirects: 0,
      maxContentLength: Math.min(Math.max(Number(config.maxContentLength) || maximumResponseBytes, 1024), maximumResponseBytes),
      maxBodyLength: Math.min(Math.max(Number(config.maxBodyLength) || maximumResponseBytes, 0), 64 * 1024 * 1024),
      lookup: guardedLookup(subject),
      proxy: false,
    };
  }
  async function request(httpClient, config) {
    const response = await httpClient.request(requestOptions(config));
    if (response?.status >= 300 && response.status < 400) throw networkError(subject, "PROVIDER_REDIRECT_FORBIDDEN");
    const length = Number(response?.headers?.["content-length"] || response?.headers?.get?.("content-length") || 0);
    if (length > maximumResponseBytes) throw networkError(subject, "PROVIDER_RESPONSE_TOO_LARGE");
    return response;
  }
  return Object.freeze({ assertUrl, requestOptions, request, maximumResponseBytes, redirectsFollowed: 0 });
}

module.exports = { PROVIDER_HOSTS, assertPublicAddress, assertAllowedHttpsUrl, assertProviderUrl, safeRedirectPolicy, sanitizeHeaders, guardedLookup, createNetworkGuard };
