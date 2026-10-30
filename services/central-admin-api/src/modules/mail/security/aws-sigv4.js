"use strict";

// Minimal AWS Signature Version 4 signer (node:crypto only, no SDK).
// Used for S3-compatible private object storage and the AWS KMS JSON API.
// Credentials are passed in per call and never logged.

const crypto = require("crypto");

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

// RFC 3986 encoding as required by SigV4 (S3 keeps "/" in paths).
function encodeRfc3986(value, { keepSlash = false } = {}) {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? encoded.replace(/%2F/g, "/") : encoded;
}

function amzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function canonicalQuery(searchParams) {
  return [...searchParams.entries()]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)])
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/**
 * Signs a request and returns the headers to send (including Authorization).
 * `body` may be a Buffer or string; `payloadHash` overrides the computed hash.
 */
function signRequest({ method, url, headers = {}, body, region, service, credentials, now = new Date(), payloadHash }) {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) throw new Error("SigV4 credentials are not configured");
  const target = new URL(url);
  const timestamp = amzDate(now);
  const day = timestamp.slice(0, 8);
  const hash = payloadHash || (body === undefined || body === null || body.length === 0 ? EMPTY_SHA256 : sha256Hex(body));

  const signed = { ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).trim()])) };
  signed.host = target.host;
  signed["x-amz-date"] = timestamp;
  if (service === "s3") signed["x-amz-content-sha256"] = hash;
  if (credentials.sessionToken) signed["x-amz-security-token"] = credentials.sessionToken;

  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((name) => `${name}:${signed[name].replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const path = service === "s3"
    ? target.pathname.split("/").map((segment) => encodeRfc3986(decodeURIComponent(segment))).join("/") || "/"
    : target.pathname || "/";
  const canonicalRequest = [method.toUpperCase(), path, canonicalQuery(target.searchParams), canonicalHeaders, signedHeaders, hash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const result = { ...signed };
  delete result.host;
  result.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: result, canonicalRequest, stringToSign, signature, payloadHash: hash };
}

module.exports = { signRequest, sha256Hex, EMPTY_SHA256, encodeRfc3986, amzDate };
