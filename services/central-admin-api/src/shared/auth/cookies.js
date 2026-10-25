"use strict";

const { loadSessionConfig } = require("./session.config");

function base(config, { path = "/", maxAgeMs } = {}) {
  const options = { httpOnly: true, secure: config.cookie.secure, sameSite: config.cookie.sameSite, path };
  if (config.cookie.domain && !config.cookie.accessName.startsWith("__Host-")) options.domain = config.cookie.domain;
  if (maxAgeMs !== undefined) options.maxAge = maxAgeMs;
  return options;
}

// Legacy refresh cookie options, identical to the pre-session behaviour.
function legacyRefreshOptions(env = process.env) {
  const production = env.NODE_ENV === "production";
  return { httpOnly: true, secure: production, sameSite: production ? "none" : "strict", maxAge: 7 * 24 * 60 * 60 * 1000 };
}

function legacyHintOptions(env = process.env) {
  const production = env.NODE_ENV === "production";
  return { httpOnly: false, secure: production, sameSite: production ? "none" : "strict", maxAge: 7 * 24 * 60 * 60 * 1000 };
}

function setSessionCookies(res, { accessToken, refreshToken, accessTtlSeconds, refreshTtlMs }, config = loadSessionConfig()) {
  if (!config.cookiesEnabled) return;
  res.cookie(config.cookie.accessName, accessToken, base(config, { maxAgeMs: accessTtlSeconds * 1000 }));
  res.cookie(config.cookie.refreshName, refreshToken, base(config, { path: config.cookie.refreshPath, maxAgeMs: refreshTtlMs }));
}

function clearSessionCookies(res, config = loadSessionConfig()) {
  res.clearCookie(config.cookie.accessName, base(config));
  res.clearCookie(config.cookie.refreshName, base(config, { path: config.cookie.refreshPath }));
  res.clearCookie(config.cookie.mfaChallengeName, base(config, { path: config.cookie.refreshPath }));
  res.clearCookie(config.legacyRefreshCookie, { ...legacyRefreshOptions(), maxAge: undefined });
  res.clearCookie("isLoggedIn", { ...legacyHintOptions(), maxAge: undefined });
}

function setMfaChallengeCookie(res, token, ttlMs, config = loadSessionConfig()) {
  res.cookie(config.cookie.mfaChallengeName, token, base(config, { path: config.cookie.refreshPath, maxAgeMs: ttlMs }));
}

module.exports = { setSessionCookies, clearSessionCookies, setMfaChallengeCookie, legacyRefreshOptions, legacyHintOptions };
