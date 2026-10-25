"use strict";

// The MFA lifecycle service lives in src/shared/auth so other modules (Mail
// step-up) can use the same verifier without importing auth-module internals.
module.exports = require("../../shared/auth/mfa.service");
