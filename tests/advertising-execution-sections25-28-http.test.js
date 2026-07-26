const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const ApiError = require("../src/shared/utils/ApiError");
const { errorHandler } = require("../src/shared/middlewares/error.middleware");
const { createExecutionRouter } = require("../src/modules/marketing/advertising-execution/execution.routes");
const { closeServer } = require("./helpers/server-close");

const ID = "11111111-1111-4111-8111-111111111111";
const ENDPOINTS = [
  ["GET", "/capabilities", "VIEW"], ["GET", "/policies", "VIEW"], ["PATCH", "/policies", "EXECUTION_ADMIN"], ["POST", "/overrides", "EMERGENCY_OPERATOR"],
  ["POST", "/plans", "AUTHOR"], ["GET", "/plans", "VIEW"], ["GET", `/plans/${ID}`, "VIEW"], ["PATCH", `/plans/${ID}`, "AUTHOR"], ["DELETE", `/plans/${ID}`, "AUTHOR"],
  ["POST", `/plans/${ID}/validate`, "AUTHOR"], ["POST", `/plans/${ID}/submit`, "AUTHOR"], ["POST", `/plans/${ID}/approve`, "APPROVER"], ["POST", `/plans/${ID}/reject`, "APPROVER"], ["POST", `/plans/${ID}/revoke-approval`, "APPROVER"],
  ["POST", `/plans/${ID}/queue`, "AUTHOR"], ["POST", `/plans/${ID}/cancel`, "AUTHOR"], ["POST", `/plans/${ID}/create-compensation`, "AUTHOR"], ["GET", "/runs", "VIEW"], ["GET", `/runs/${ID}`, "VIEW"],
  ["GET", `/operations/${ID}`, "VIEW"], ["POST", `/operations/${ID}/retry`, "EXECUTION_ADMIN"], ["GET", "/drift", "VIEW"], ["POST", `/drift/${ID}/acknowledge`, "EXECUTION_ADMIN"],
  ["POST", `/recommendations/${ID}/create-plan`, "AUTHOR"], ["POST", `/creatives/${ID}/publications`, "AUTHOR"], ["GET", `/creatives/${ID}/publications`, "VIEW"], ["GET", "/health", "VIEW"],
];

const CONTROLLERS = ["getCapabilities", "getPolicies", "updatePolicy", "createEmergencyOverride", "createPlan", "listPlans", "getPlan", "updatePlan", "deletePlan", "validatePlan", "submitPlan", "approvePlan", "rejectPlan", "revokeApproval", "queuePlan", "cancelPlan", "createCompensation", "listRuns", "getRun", "getOperation", "retryOperation", "listDrift", "acknowledgeDrift", "convertRecommendation", "createCreativePublication", "listCreativePublications", "getHealth"];

async function withServer(callback) {
  const controller = Object.fromEntries(CONTROLLERS.map((name) => [name, (req, res) => res.status(200).json({ success: true, handler: name, actor: req.adminUser.id })]));
  const authenticateMiddleware = (req, _res, next) => { if (!req.get("x-test-auth")) return next(new ApiError(401, "No token provided")); req.adminUser = { id: "actor", tier: req.get("x-test-role") === "SUPER" ? "SUPER" : "ADMIN" }; next(); };
  const sectionGate = (_module, _section, mode) => (req, _res, next) => { const granted = req.get("x-test-mode"); if (mode === "VIEW" && ["VIEW", "EDIT"].includes(granted) || mode === "EDIT" && granted === "EDIT") return next(); return next(new ApiError(403, "Section access denied")); };
  const fineGate = (role) => (req, _res, next) => req.get("x-test-role") === role || req.get("x-test-role") === "SUPER" ? next() : next(new ApiError(403, `${role} required`));
  const app = express(); app.use(express.json()); app.use("/execution", createExecutionRouter({ controller, authenticateMiddleware, sectionGate, fineGate })); app.use(errorHandler);
  const server = await new Promise((resolve) => { const value = app.listen(0, () => resolve(value)); });
  try { return await callback(`http://127.0.0.1:${server.address().port}/execution`); } finally { await closeServer(server); }
}

test("all Sections 25-28 primary HTTP endpoints enforce authentication, section access and fine role", { timeout: 120000 }, async (t) => {
  assert.equal(ENDPOINTS.length, 27);
  for (const [method, path, role] of ENDPOINTS) await t.test(`${method} ${path}`, async () => withServer(async (base) => {
    const options = (headers) => ({ method, headers: { ...headers, ...(method === "GET" ? {} : { "content-type": "application/json" }) }, ...(method === "GET" ? {} : { body: "{}" }) });
    assert.equal((await fetch(`${base}${path}`, options({}))).status, 401);
    const actors = [
      ["VIEW_ONLY", "VIEW"], ["EDIT_ONLY", "EDIT"], ["AUTHOR", "EDIT"], ["APPROVER", "EDIT"],
      ["EXECUTION_ADMIN", "EDIT"], ["EMERGENCY_OPERATOR", "EDIT"], ["SUPER", "EDIT"],
    ];
    for (const [candidateRole, mode] of actors) {
      const response = await fetch(`${base}${path}`, options({ "x-test-auth": "yes", "x-test-mode": mode, "x-test-role": candidateRole }));
      const expected = role === "VIEW" || candidateRole === role || candidateRole === "SUPER" ? 200 : 403;
      assert.equal(response.status, expected, `${candidateRole}/${mode} on ${method} ${path}`);
    }
  }));
});
