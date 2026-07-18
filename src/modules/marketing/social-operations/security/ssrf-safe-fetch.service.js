const dns = require("dns").promises;
const net = require("net");
const ApiError = require("../../../../shared/utils/ApiError");

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function splitHosts(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function allowConfig({ allowedHosts, allowedSubdomainSuffixes } = {}) {
  return {
    allowedHosts: new Set(
      allowedHosts || splitHosts(process.env.SOCIAL_REMOTE_MEDIA_ALLOWED_HOSTS),
    ),
    allowedSubdomainSuffixes: new Set(allowedSubdomainSuffixes || []),
  };
}

function exactOrSafeSubdomain(hostname, config) {
  const host = String(hostname || "").toLowerCase();
  if (config.allowedHosts.has(host)) return true;
  return [...config.allowedSubdomainSuffixes].some(
    (suffix) => host.endsWith(`.${suffix}`) && host !== suffix,
  );
}

function ipv4ToNumber(ip) {
  return ip.split(".").reduce((total, part) => total * 256 + Number(part), 0);
}

function ipv4In(ip, cidr, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToNumber(ip) & mask) === (ipv4ToNumber(cidr) & mask);
}

function isUnsafeIPv4(ip) {
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ].some(([cidr, bits]) => ipv4In(ip, cidr, bits));
}

function normalizeIPv6(ip) {
  return String(ip || "").toLowerCase();
}

function isUnsafeIPv6(ip) {
  const normalized = normalizeIPv6(ip);
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("ff")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isUnsafeIPv4(mapped[1]) : false;
}

function isUnsafeAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return isUnsafeIPv4(address);
  if (version === 6) return isUnsafeIPv6(address);
  return true;
}

function assertSafeRemoteMediaUrl({
  url,
  allowedHosts,
  allowedSubdomainSuffixes,
  allowHttpLocalTest = false,
  nodeEnv = process.env.NODE_ENV,
} = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(400, "Remote media URL is not allowed");
  }

  const testEnv = ["test", "development"].includes(String(nodeEnv || "").toLowerCase());
  if (parsed.username || parsed.password) {
    throw new ApiError(400, "Remote media URL is not allowed");
  }
  if (parsed.protocol !== "https:") {
    const localHttp =
      parsed.protocol === "http:" &&
      allowHttpLocalTest &&
      testEnv &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (!localHttp) throw new ApiError(400, "Remote media URL is not allowed");
  }
  if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) && !allowHttpLocalTest) {
    throw new ApiError(400, "Remote media URL is not allowed");
  }
  if (
    !exactOrSafeSubdomain(
      parsed.hostname,
      allowConfig({ allowedHosts, allowedSubdomainSuffixes }),
    )
  ) {
    throw new ApiError(400, "Remote media URL is not allowed");
  }
  return parsed;
}

async function resolveAndValidateHost({ hostname, resolver = dns.lookup } = {}) {
  const records = await resolver(hostname, { all: true, verbatim: true });
  const addresses = Array.isArray(records) ? records : [records];
  if (addresses.length === 0 || addresses.some((record) => isUnsafeAddress(record.address))) {
    throw new ApiError(400, "Remote media URL is not allowed");
  }
  return addresses;
}

async function validateRemoteMediaRequest({
  url,
  allowedHosts,
  allowedSubdomainSuffixes,
  resolver,
  allowHttpLocalTest,
  nodeEnv,
} = {}) {
  const parsed = assertSafeRemoteMediaUrl({
    url,
    allowedHosts,
    allowedSubdomainSuffixes,
    allowHttpLocalTest,
    nodeEnv,
  });
  const addresses = await resolveAndValidateHost({ hostname: parsed.hostname, resolver });
  return {
    url: parsed.toString(),
    hostname: parsed.hostname,
    addresses: addresses.map((record) => record.address),
  };
}

async function fetchRemoteMediaSafely({
  url,
  fetcher,
  resolver,
  allowedHosts,
  allowedSubdomainSuffixes,
  allowedContentTypes = [],
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = 10_000,
  allowHttpLocalTest,
  nodeEnv,
} = {}) {
  if (!fetcher) throw new Error("A safe remote media fetcher must be injected");

  let currentUrl = url;
  for (let redirectNo = 0; redirectNo <= maxRedirects; redirectNo += 1) {
    await validateRemoteMediaRequest({
      url: currentUrl,
      allowedHosts,
      allowedSubdomainSuffixes,
      resolver,
      allowHttpLocalTest,
      nodeEnv,
    });
    const response = await fetcher(currentUrl, {
      headers: {},
      timeoutMs,
      maxBytes,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers?.location || redirectNo === maxRedirects) {
        throw new ApiError(400, "Remote media URL is not allowed");
      }
      currentUrl = new URL(response.headers.location, currentUrl).toString();
      continue;
    }
    const contentType = String(response.headers?.["content-type"] || "").split(";")[0];
    if (
      allowedContentTypes.length &&
      !allowedContentTypes.some((allowed) => contentType === allowed)
    ) {
      throw new ApiError(400, "Remote media content type is not allowed");
    }
    const body = Buffer.isBuffer(response.body)
      ? response.body
      : Buffer.from(response.body || "");
    if (body.length > maxBytes) throw new ApiError(400, "Remote media response is too large");
    return {
      url: currentUrl,
      contentType,
      body,
    };
  }
  throw new ApiError(400, "Remote media URL is not allowed");
}

module.exports = {
  assertSafeRemoteMediaUrl,
  resolveAndValidateHost,
  validateRemoteMediaRequest,
  fetchRemoteMediaSafely,
  isUnsafeAddress,
};
