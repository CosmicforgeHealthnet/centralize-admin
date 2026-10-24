"use strict";

const { createHmac, timingSafeEqual } = require("node:crypto");

function isAuthorized(header, config, now = Date.now()) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return false;
  const parts = token.split(".");
  try {
    const protectedHeader = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (protectedHeader.alg !== "HS256" || protectedHeader.typ !== "JWT") return false;
    const expected = createHmac("sha256", config.secret)
      .update(parts[0] + "." + parts[1]).digest();
    const actual = Buffer.from(parts[2], "base64url");
    if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) return false;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const seconds = Math.floor(now / 1000);
    if (claims.iss !== "central-admin-hq" || claims.aud !== "healthnet-admin" ||
        typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 256 ||
        !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
        claims.iat > seconds + 10 || claims.exp <= seconds ||
        claims.exp - claims.iat < 1 || claims.exp - claims.iat > 90) {
      return false;
    }
    return Array.isArray(claims.scopes) && claims.scopes.includes("healthnet:dashboard:read");
  } catch {
    return false;
  }
}

module.exports = { isAuthorized };
