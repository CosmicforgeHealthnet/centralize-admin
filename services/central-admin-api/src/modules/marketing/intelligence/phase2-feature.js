const { marketingError } = require("./errors");

const PHASE2_FLAG = "MARKETING_INTELLIGENCE_PHASE2_ENABLED";
const PHASE2_DISABLED_CODE = "MARKETING_INTELLIGENCE_PHASE2_DISABLED";

function isPhase2Enabled(env = process.env) {
  return String(env?.[PHASE2_FLAG] || "").trim().toLowerCase() === "true";
}

function disabledResult(action = "PHASE2_OPERATION") {
  return {
    skipped: true,
    status: "DISABLED",
    reason: "phase2_disabled",
    reasonCode: PHASE2_DISABLED_CODE,
    action,
  };
}

function phase2DisabledError(action = "PHASE2_OPERATION") {
  return marketingError(PHASE2_DISABLED_CODE, [], {
    detail: { action },
  });
}

function requirePhase2Enabled(req, _res, next) {
  if (isPhase2Enabled()) return next();
  return next(phase2DisabledError(`${req.method || "REQUEST"} ${req.baseUrl || ""}${req.path || ""}`.trim()));
}

async function runPhase2Operation(action, operation, env = process.env) {
  if (!isPhase2Enabled(env)) return disabledResult(action);
  return operation();
}

module.exports = {
  PHASE2_FLAG,
  PHASE2_DISABLED_CODE,
  isPhase2Enabled,
  disabledResult,
  phase2DisabledError,
  requirePhase2Enabled,
  runPhase2Operation,
};
