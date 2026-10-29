"use strict";
const router = require("express").Router();
const http = require("node:http");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { authenticate, requireAuthSchema, requireRecentMfa } = require("../../shared/middlewares/auth.middleware");
const { requireSection } = require("../../shared/middlewares/rbac.middleware");
const asyncHandler = require("../../shared/utils/asyncHandler");
const ApiError = require("../../shared/utils/ApiError");

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
function authorizeLocalCall(req, env = process.env) {
  const fields = [env.KARRYAM_ADMIN_MARKET, env.KARRYAM_ADMIN_ORGANIZATION, env.KARRYAM_ADMIN_ACR, req.adminUser?.tier];
  if (env.KARRYAM_ADMIN_ENABLED !== "true" ||
      !env.KARRYAM_ADMIN_SOCKET_PATH || !env.KARRYAM_ADMIN_SOCKET_PATH.startsWith("/") ||
      env.KARRYAM_ADMIN_SOCKET_PATH.includes("..") || !fields.every(v => typeof v === "string" && OPAQUE.test(v))) {
    throw new ApiError(503, "Karryam integration is not configured");
  }
  const session = req.authSession;
  const authTime = session?.mfaVerifiedAt ? Math.floor(new Date(session.mfaVerifiedAt).getTime() / 1000) : 0;
  const now = Math.floor(Date.now() / 1000);
  if (!session?.id || !OPAQUE.test(req.adminUser.id) || !OPAQUE.test(session.id) ||
      !Number.isFinite(authTime) || authTime < now - 300 || authTime > now) {
    throw new ApiError(403, "A recent verified staff session is required");
  }
  const secretFile = env.KARRYAM_HQ_DELEGATION_SECRET_FILE;
  if (!secretFile || !secretFile.startsWith("/")) throw new ApiError(503, "Karryam integration is not configured");
  let secret;
  try { secret = Buffer.from(fs.readFileSync(secretFile, "utf8").trim(), "base64url"); }
  catch { throw new ApiError(503, "Karryam integration is not configured"); }
  if (secret.length < 32) throw new ApiError(503, "Karryam integration is not configured");
  const payload = {
    iss:"central-admin-api", aud:"karryam-admin-local", product:"karryam",
    sub:req.adminUser.id, session_id:session.id, role:req.adminUser.tier,
    permission:"bridge.capabilities.read", market:env.KARRYAM_ADMIN_MARKET,
    organization:env.KARRYAM_ADMIN_ORGANIZATION, acr:env.KARRYAM_ADMIN_ACR,
    auth_time:authTime, iat:now, exp:now + 15, operation:"capabilities.read"
  };
  const raw = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const token = raw + "." + crypto.createHmac("sha256", secret).update(raw).digest("base64url");
  return { socketPath:env.KARRYAM_ADMIN_SOCKET_PATH, token };
}
function readCapabilities({ socketPath, token }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method:"GET", path:"/v1/capabilities",
      headers:{ "X-CF-HQ-Delegation":token, Accept:"application/json" }, timeout:5500 }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error("bridge_unavailable")); return; }
      const parts = [];
      let size = 0;
      response.on("data", (part) => {
        size += part.length;
        if (size > 262144) { request.destroy(new Error("oversized_response")); return; }
        parts.push(part);
      });
      response.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(parts).toString("utf8"));
          if (!result || result.product !== "karryam" || result.error) throw new Error("invalid_response");
          resolve(result);
        } catch { reject(new Error("invalid_response")); }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end();
  });
}
// Do not grant any Karryam permission implicitly from a staff tier.
// SUPER remains subject to the existing explicit HQ bypass policy and MFA;
// everyone else needs the operations/karryam section grant.
router.use(authenticate, requireAuthSchema, requireSection("operations", "karryam", "VIEW"), requireRecentMfa(5 * 60 * 1000));
router.get("/capabilities", asyncHandler(async (req, res) => {
  const delegated = authorizeLocalCall(req);
  try {
    const result = await readCapabilities(delegated);
    res.set("Cache-Control", "no-store");
    res.status(200).json(result);
  } catch {
    throw new ApiError(503, "Karryam private bridge is unavailable");
  }
}));
module.exports = router;
module.exports.authorizeLocalCall = authorizeLocalCall;
module.exports.readCapabilities = readCapabilities;
