// Section 13.3 gate evaluator: disposable evidence never certifies a staging
// gate, missing evidence is NOT_RUN, failures propagate, and FULLY_CERTIFIED
// needs every gate PASS with real staging evidence for the same commit.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, markdown } from "../product-admin-staging-gates.mjs";

const SHA = "c".repeat(40);
const journeys = (status = "PASS") => ({ status, journeys: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, status })) });
const ciAll = { "Product Admin Platform CI": "success", "Product Admin Infrastructure Security CI": "success", "Monorepo Layout and Container CI": "success", "Social Operations CI": "success" };
const stagingState = (status, { sha = SHA, environment = "staging" } = {}) => ({ environment, current: { sha, stages: Object.fromEntries(["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7"].map((s) => [s, { status }])) } });

function inputs(over = {}) {
  return {
    sha: SHA, now: "2026-11-01T00:00:00.000Z",
    repo: { checked: true, onStaging: true, unrelatedChanges: [], protectedChanges: [] },
    production: { checked: true, mainChanged: false, productionWorkflowChanged: false },
    naming: { violations: [] }, boundaryStatic: true, ci: ciAll, rehearsal: true,
    artifacts: { contract_audit: { result: "PASS" }, required_suites: [{ status: "PASS" }, { status: "PASS" }], journeys: journeys() },
    staging: null,
    ...over,
  };
}
const byId = (r) => Object.fromEntries(r.gates.map((g) => [g.id, g.status]));

test("disposable evidence only: code-level gates pass, staging gates stay PENDING_EXTERNAL", () => {
  const r = evaluate(inputs());
  assert.equal(r.result, "CODE_CERTIFIED_STAGING_PENDING");
  assert.equal(r.gates.length, 14);
  const s = byId(r);
  for (const id of [1, 2, 9, 13, 14]) assert.equal(s[id], "PASS", `gate ${id}`);
  for (const id of [3, 4, 5, 6, 7, 8, 10, 11, 12]) assert.equal(s[id], "PENDING_EXTERNAL", `gate ${id}`);
  for (const g of r.gates.filter((x) => x.status === "PENDING_EXTERNAL")) {
    assert.ok(g.external_prerequisite, `gate ${g.id} names its prerequisite`);
    assert.ok(g.supporting_evidence.length > 0);
    assert.equal(g.environment, "disposable-ci");
  }
  assert.match(markdown(r), /CODE_CERTIFIED_STAGING_PENDING/);
});

test("a rehearsal state, or a staging state for another commit, never satisfies a staging gate", () => {
  for (const staging of [stagingState("PASSED", { environment: "rehearsal" }), stagingState("PASSED", { sha: "d".repeat(40) })]) {
    const r = evaluate(inputs({ staging }));
    assert.equal(r.result, "CODE_CERTIFIED_STAGING_PENDING");
    assert.equal(byId(r)[3], "PENDING_EXTERNAL");
  }
});

test("FULLY_CERTIFIED only when every stage PASSED on staging for this commit", () => {
  const r = evaluate(inputs({ staging: stagingState("PASSED") }));
  assert.equal(r.result, "FULLY_CERTIFIED");
  assert.ok(r.gates.filter((g) => [3, 4, 5, 6, 7, 8, 10, 11, 12].includes(g.id)).every((g) => g.environment === "staging"));
  const partial = stagingState("PASSED");
  partial.current.stages.S4.status = "BLOCKED_EXTERNAL";
  const p = evaluate(inputs({ staging: partial }));
  assert.equal(p.result, "CODE_CERTIFIED_STAGING_PENDING");
  assert.equal(byId(p)[8], "PENDING_EXTERNAL");
  assert.equal(byId(p)[3], "PASS");
});

test("failures propagate: rolled-back stage, failed journeys, failed audit, protected changes, promotion to main", () => {
  const rolled = stagingState("PASSED"); rolled.current.stages.S2.status = "ROLLED_BACK";
  assert.equal(byId(evaluate(inputs({ staging: rolled })))[12], "FAIL");
  const fj = evaluate(inputs({ artifacts: { ...inputs().artifacts, journeys: journeys("FAIL") } }));
  assert.equal(fj.result, "NOT_CERTIFIED");
  assert.equal(byId(fj)[9], "FAIL");
  assert.equal(byId(evaluate(inputs({ artifacts: { ...inputs().artifacts, contract_audit: { result: "FAIL" } } })))[6], "FAIL");
  const prot = evaluate(inputs({ repo: { checked: true, onStaging: true, unrelatedChanges: [], protectedChanges: ["services/central-admin-api/src/modules/mail/x.js"] } }));
  assert.equal(byId(prot)[1], "FAIL");
  assert.equal(byId(prot)[13], "FAIL");
  assert.equal(byId(evaluate(inputs({ production: { checked: true, mainChanged: true } })))[14], "FAIL");
  assert.equal(byId(evaluate(inputs({ naming: { violations: ["x.js:1"] } })))[2], "FAIL");
});

test("missing inputs are NOT_RUN, never PASS", () => {
  const r = evaluate({ sha: SHA, now: "2026-11-01T00:00:00.000Z" });
  assert.equal(r.result, "CODE_CERTIFIED_STAGING_PENDING");
  const s = byId(r);
  for (const id of [1, 2, 3, 6, 8, 9, 10, 11, 12, 13, 14]) assert.equal(s[id], "NOT_RUN", `gate ${id}`);
  assert.equal(evaluate(inputs({ ci: { ...ciAll, "Social Operations CI": "in_progress" } })).gates.find((g) => g.id === 13).status, "NOT_RUN");
});
