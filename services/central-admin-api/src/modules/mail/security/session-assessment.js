"use strict";

// §17.1: private mail must not rely on a JavaScript-readable bearer token.
// HQ auth (src/shared/auth/session.config.js) supports three modes:
//   legacy  access JWT returned in the body and kept by the browser in
//           localStorage / a readable cookie (an XSS can steal it)
//   dual    adds httpOnly access/refresh cookies + CSRF (body token and
//           Bearer still accepted while old tabs drain)
//   cookie  httpOnly cookies + CSRF only; Bearer rejected for user sessions
// This module only reports the mode Mail is running under; switching modes
// is an HQ auth rollout owned by security (never flipped from Mail).

const { loadSessionConfig } = require("../../../shared/auth/session.config");

function assessMailSession({ env = process.env, config }) {
  let mode = "legacy";
  try {
    mode = loadSessionConfig(env).mode;
  } catch {
    mode = "legacy";
  }
  const hardened = mode === "cookie" || (mode === "dual" && config.session?.allowDual === true);
  const reason = mode === "cookie" ? null : mode === "dual" ? (hardened ? "DUAL_MODE_TRANSITIONAL" : "BODY_TOKEN_STILL_ISSUED") : "JS_READABLE_ACCESS_TOKEN";
  return {
    mode,
    hardened,
    required: config.session?.requireHardened === true,
    // OK = hardened; WARNING = not hardened, not required here; BLOCKING =
    // required but not hardened (enabled Mail reports not ready).
    status: hardened ? "OK" : config.session?.requireHardened ? "BLOCKING" : "WARNING",
    reason,
  };
}

module.exports = { assessMailSession };
