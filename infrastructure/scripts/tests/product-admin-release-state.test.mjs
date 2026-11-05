// S0-S7 release state machine: ordering, evidence validation, independent
// authorization, resume, rerun, rollback and tamper detection.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, buildEvidence, evaluateEvidence, STAGES, ReleaseError } from "../../product-admin/release/release-state.mjs";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const def = (id) => STAGES.stages.find((s) => s.id === id);

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-release-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function evidence(dir, stage, { status = "PASS", sha = SHA, environment = "staging", override = {}, approver = "owner-2" } = {}) {
  const d = def(stage);
  const ev = buildEvidence({
    stage, sha, environment,
    checks: d.automated_checks.map((id) => ({ id, status: typeof status === "function" ? status(id) : status })),
    operatorEvidence: d.operator_evidence.map((id) => ({ id, ref: "ticket:" + id, by: "operator-1" })),
    authorization: d.authorization.required ? { by: "operator-1", confirm: d.authorization.confirm || undefined, approved_by: approver } : null,
  });
  const file = path.join(dir, `${stage}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...ev, ...override }));
  return file;
}

const must = (fn, reason) => assert.throws(fn, (e) => e instanceof ReleaseError && e.reason === reason);

test("stages are S0..S7 in order, each depending only on earlier stages", () => {
  assert.deepEqual(STAGES.stages.map((s) => s.id), ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
  STAGES.stages.forEach((s, i) => { for (const r of s.requires) assert.ok(STAGES.stages.findIndex((x) => x.id === r) < i); assert.ok(s.automated_checks.length > 0); });
});

test("full staging release passes in order with complete evidence", (t) => {
  const dir = tmp(t);
  const store = openStore(path.join(dir, "state"));
  store.init({ sha: SHA, environment: "staging", actor: "operator-1" });
  for (const s of STAGES.stages) {
    store.begin(s.id, { actor: "operator-1" });
    assert.equal(store.complete(s.id, evidence(dir, s.id)).status, "PASSED", s.id);
  }
  assert.deepEqual(store.verify(), { ok: true, problems: [] });
});

test("a stage cannot begin before its prerequisites passed", (t) => {
  const dir = tmp(t);
  const store = openStore(path.join(dir, "state"));
  store.init({ sha: SHA, environment: "staging" });
  must(() => store.begin("S2"), "PREREQUISITE_NOT_PASSED");
  store.begin("S0");
  store.complete("S0", evidence(dir, "S0", { status: (id) => (id === "required_ci_green" ? "FAIL" : "PASS") }));
  must(() => store.begin("S1"), "PREREQUISITE_NOT_PASSED");
});

test("missing, NOT_RUN and FAIL checks fail the stage; PENDING_EXTERNAL blocks it", (t) => {
  const dir = tmp(t);
  const d = def("S0");
  const base = { sha: SHA, environment: "staging", startedBy: "x" };
  const ev = (checks) => buildEvidence({ stage: "S0", sha: SHA, environment: "staging", checks });
  assert.equal(evaluateEvidence(d, ev(d.automated_checks.slice(1).map((id) => ({ id, status: "PASS" }))), base).status, "FAILED");
  assert.equal(evaluateEvidence(d, ev(d.automated_checks.map((id, i) => ({ id, status: i ? "PASS" : "NOT_RUN" }))), base).status, "FAILED");
  assert.equal(evaluateEvidence(d, ev(d.automated_checks.map((id, i) => ({ id, status: i ? "PASS" : "PENDING_EXTERNAL" }))), base).status, "BLOCKED_EXTERNAL");
  assert.equal(evaluateEvidence(d, ev([...d.automated_checks.map((id) => ({ id, status: "PASS" })), { id: d.automated_checks[0], status: "PASS" }]), base).status, "FAILED", "duplicate check id");
  assert.equal(evaluateEvidence(d, ev(d.automated_checks.map((id) => ({ id, status: "SKIP" }))), base).status, "FAILED", "SKIP is not a status");
  void dir;
});

test("evidence for another commit, stage or environment is refused", (t) => {
  const dir = tmp(t);
  const store = openStore(path.join(dir, "state"));
  store.init({ sha: SHA, environment: "staging" });
  store.begin("S0");
  assert.deepEqual(store.complete("S0", evidence(dir, "S0", { sha: SHA2 })).reasons, ["EVIDENCE_SHA_MISMATCH"]);
  store.begin("S0", { resume: true });
  assert.deepEqual(store.complete("S0", evidence(dir, "S0", { environment: "rehearsal" })).reasons, ["EVIDENCE_ENVIRONMENT_MISMATCH"]);
  store.begin("S0", { resume: true });
  assert.deepEqual(store.complete("S0", evidence(dir, "S0", { override: { stage: "S1" } })).reasons, ["EVIDENCE_STAGE_MISMATCH"]);
});

test("authorization: missing confirmation blocks; same-person approval fails", (t) => {
  const dir = tmp(t);
  const store = openStore(path.join(dir, "state"));
  store.init({ sha: SHA, environment: "staging" });
  store.begin("S0"); store.complete("S0", evidence(dir, "S0"));
  store.begin("S1", { actor: "operator-1" });
  const r = store.complete("S1", evidence(dir, "S1", { override: { authorization: { by: "operator-1" } } }));
  assert.equal(r.status, "BLOCKED_EXTERNAL");
  assert.ok(r.reasons.includes("AUTHORIZATION_CONFIRMATION_MISSING"));
  // S5 needs an independent approver.
  for (const s of ["S1", "S2", "S3", "S4"]) { store.begin(s, { actor: "operator-1", resume: s === "S1" }); assert.equal(store.complete(s, evidence(dir, s)).status, "PASSED", s); }
  store.begin("S5", { actor: "operator-1" });
  const same = store.complete("S5", evidence(dir, "S5", { approver: "operator-1" }));
  assert.equal(same.status, "FAILED");
  assert.ok(same.reasons.includes("APPROVER_NOT_INDEPENDENT"));
  store.begin("S5", { actor: "operator-1" });
  const none = store.complete("S5", evidence(dir, "S5", { override: { authorization: { by: "operator-1" } } }));
  assert.equal(none.status, "BLOCKED_EXTERNAL");
});

test("missing operator evidence keeps a stage BLOCKED_EXTERNAL (never PASSED from automation alone)", (t) => {
  const dir = tmp(t);
  const d = def("S3");
  const ev = buildEvidence({ stage: "S3", sha: SHA, environment: "staging", checks: d.automated_checks.map((id) => ({ id, status: "PASS" })), authorization: { by: "op", approved_by: "source-owner" } });
  const r = evaluateEvidence(d, ev, { sha: SHA, environment: "staging", startedBy: "op" });
  assert.equal(r.status, "BLOCKED_EXTERNAL");
  assert.ok(r.reasons.some((x) => x.startsWith("OPERATOR_EVIDENCE_MISSING:")));
  void dir; void t;
});

test("interrupted stage resumes only explicitly; a passed stage reruns only explicitly and resets dependents", (t) => {
  const dir = tmp(t);
  const store = openStore(path.join(dir, "state"));
  store.init({ sha: SHA, environment: "staging" });
  store.begin("S0");
  must(() => store.begin("S0"), "STAGE_IN_PROGRESS");
  store.begin("S0", { resume: true });
  store.complete("S0", evidence(dir, "S0"));
  store.begin("S1"); store.complete("S1", evidence(dir, "S1"));
  must(() => store.begin("S0"), "STAGE_ALREADY_PASSED");
  store.begin("S0", { rerun: true });
  assert.equal(store.read().current.stages.S1.status, "PENDING");
  assert.equal(store.read().current.stages.S1.reason, "PREREQUISITE_RERUN");
});

test("rollback marks the stage and all dependents ROLLED_BACK and keeps every evidence file and event", (t) => {
  const dir = tmp(t);
  const store = openStore(path.join(dir, "state"));
  store.init({ sha: SHA, environment: "staging" });
  for (const s of ["S0", "S1", "S2", "S3"]) { store.begin(s); store.complete(s, evidence(dir, s)); }
  const before = fs.readdirSync(path.join(dir, "state", "evidence")).length;
  must(() => store.rollback("S2", {}), "ROLLBACK_REASON_REQUIRED");
  const stages = store.rollback("S2", { actor: "op", reason: "health check failed" });
  assert.equal(stages.S2.status, "ROLLED_BACK");
  assert.equal(stages.S3.status, "ROLLED_BACK");
  assert.equal(stages.S4.status, "PENDING", "never-started stages stay PENDING");
  assert.equal(stages.S1.status, "PASSED");
  assert.equal(fs.readdirSync(path.join(dir, "state", "evidence")).length, before);
  const events = fs.readFileSync(path.join(dir, "state", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(events.filter((e) => e.action === "rollback").length === 2);
  assert.ok(events.filter((e) => e.action === "complete").length === 4);
  must(() => store.begin("S3"), "PREREQUISITE_NOT_PASSED");
});

test("a new commit starts a new release; the old release and its evidence are kept", (t) => {
  const dir = tmp(t);
  const store = openStore(path.join(dir, "state"));
  store.init({ sha: SHA, environment: "staging" });
  store.begin("S0"); store.complete("S0", evidence(dir, "S0"));
  store.init({ sha: SHA2, environment: "staging" });
  const s = store.read();
  assert.equal(s.current.sha, SHA2);
  assert.equal(s.current.stages.S0.status, "PENDING", "evidence never carries over to another commit");
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].stages.S0.status, "PASSED");
  must(() => store.init({ sha: SHA2, environment: "rehearsal" }), "ENVIRONMENT_MISMATCH");
});

test("verify detects altered or missing evidence and inconsistent PASSED stages", (t) => {
  const dir = tmp(t);
  const store = openStore(path.join(dir, "state"));
  store.init({ sha: SHA, environment: "staging" });
  store.begin("S0"); store.complete("S0", evidence(dir, "S0"));
  const evDir = path.join(dir, "state", "evidence");
  const f = path.join(evDir, fs.readdirSync(evDir)[0]);
  fs.appendFileSync(f, " ");
  assert.equal(store.verify().ok, false);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state", "state.json"), "utf8"));
  state.current.stages.S2.status = "PASSED";
  fs.writeFileSync(path.join(dir, "state", "state.json"), JSON.stringify(state));
  const v = store.verify();
  assert.ok(v.problems.some((p) => p.startsWith("S2 PASSED while S1")));
  assert.ok(v.problems.some((p) => p === "S2 PASSED without evidence"));
});
