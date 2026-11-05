#!/usr/bin/env node
// Product Admin staging release state machine (Section 12.4, S0-S7).
//
// One state directory per environment (on the staging host:
// ${PA_HOST_ROOT}/release; in CI rehearsals a temp dir):
//   state.json     current release + history (rewritten atomically)
//   events.jsonl   append-only transition log (never rewritten)
//   evidence/      stage evidence files, referenced by sha256
//
// Rules (fail closed):
//   - a stage can begin only when every required earlier stage is PASSED
//     for the SAME release commit;
//   - it completes from evidence only: every automated check of the stage
//     must be present; FAIL or NOT_RUN -> FAILED; PENDING_EXTERNAL or a
//     missing operator evidence/authorization -> BLOCKED_EXTERNAL;
//   - evidence must name the same stage, commit and environment;
//   - independent authorization: the approver differs from whoever began
//     the stage;
//   - rollback marks the stage and every dependent stage ROLLED_BACK and
//     deletes nothing; a new commit starts a new release (old one kept).
//
// CLI: node release-state.mjs <init|begin|complete|rollback|status|verify> --dir D [...]

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STAGES = JSON.parse(fs.readFileSync(path.join(HERE, "stages.json"), "utf8"));
export const STATUSES = Object.freeze(STAGES.statuses);
const CHECK_STATUSES = new Set(["PASS", "FAIL", "PENDING_EXTERNAL", "NOT_RUN"]);
const SHA = /^[0-9a-f]{40}$/;
const ENVIRONMENTS = new Set(["staging", "rehearsal"]);
const STATE_SCHEMA = "cf-product-admin-release-state/v1";
const EVIDENCE_SCHEMA = "cf-product-admin-stage-evidence/v1";

export class ReleaseError extends Error {
  constructor(reason, detail) { super(reason + (detail ? ": " + detail : "")); this.reason = reason; this.detail = detail; }
}

const stageDef = (id) => {
  const s = STAGES.stages.find((x) => x.id === id);
  if (!s) throw new ReleaseError("UNKNOWN_STAGE", id);
  return s;
};

function dependents(id) {
  const out = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of STAGES.stages) {
      if (!out.has(s.id) && (s.requires.includes(id) || s.requires.some((r) => out.has(r)))) { out.add(s.id); grew = true; }
    }
  }
  return [...out];
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export function openStore(dir, { now = () => new Date() } = {}) {
  const stateFile = path.join(dir, "state.json");
  const eventsFile = path.join(dir, "events.jsonl");
  const evidenceDir = path.join(dir, "evidence");

  function read() {
    if (!fs.existsSync(stateFile)) return null;
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (state.schema !== STATE_SCHEMA) throw new ReleaseError("STATE_SCHEMA_UNSUPPORTED");
    return state;
  }
  function write(state) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = stateFile + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    fs.renameSync(tmp, stateFile);
  }
  function event(e) {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(eventsFile, JSON.stringify({ at: now().toISOString(), ...e }) + "\n");
  }
  function current() {
    const state = read();
    if (!state || !state.current) throw new ReleaseError("NO_RELEASE", "run init first");
    return state;
  }
  function setStage(state, id, patch, ev) {
    const prev = state.current.stages[id];
    state.current.stages[id] = { ...prev, ...patch, updated_at: now().toISOString() };
    event({ release_id: state.current.release_id, sha: state.current.sha, stage: id, from: prev.status, to: state.current.stages[id].status, ...ev });
  }

  return {
    dir,
    read,

    init({ sha, environment, actor }) {
      if (!SHA.test(String(sha))) throw new ReleaseError("SHA_INVALID");
      if (!ENVIRONMENTS.has(environment)) throw new ReleaseError("ENVIRONMENT_INVALID", environment);
      const state = read() || { schema: STATE_SCHEMA, environment, current: null, history: [] };
      if (state.environment !== environment) throw new ReleaseError("ENVIRONMENT_MISMATCH", `${state.environment} != ${environment}`);
      if (state.current && state.current.sha === sha) return state;
      if (state.current) state.history.push({ ...state.current, superseded_at: now().toISOString(), superseded_by: sha });
      const releaseId = `${now().toISOString().replace(/[:.]/g, "")}-${sha.slice(0, 12)}`;
      state.current = {
        release_id: releaseId, sha, created_at: now().toISOString(), initiated_by: actor || null,
        stages: Object.fromEntries(STAGES.stages.map((s) => [s.id, { status: "PENDING", evidence: [], updated_at: now().toISOString() }])),
      };
      write(state);
      event({ release_id: releaseId, sha, action: "init", actor: actor || null });
      return state;
    },

    begin(id, { actor, resume = false, rerun = false } = {}) {
      const def = stageDef(id);
      const state = current();
      const st = state.current.stages[id];
      for (const req of def.requires) {
        if (state.current.stages[req].status !== "PASSED") throw new ReleaseError("PREREQUISITE_NOT_PASSED", `${req} is ${state.current.stages[req].status}`);
      }
      if (st.status === "IN_PROGRESS" && !resume) throw new ReleaseError("STAGE_IN_PROGRESS", "use --resume to continue an interrupted run");
      if (st.status === "PASSED" && !rerun) throw new ReleaseError("STAGE_ALREADY_PASSED", "use --rerun to re-verify (dependent stages return to PENDING)");
      if (rerun && st.status === "PASSED") {
        for (const d of dependents(id)) if (state.current.stages[d].status !== "PENDING") setStage(state, d, { status: "PENDING", reason: "PREREQUISITE_RERUN" }, { action: "reset", actor });
      }
      setStage(state, id, { status: "IN_PROGRESS", started_by: actor || null, started_at: now().toISOString(), reason: null }, { action: resume ? "resume" : "begin", actor });
      write(state);
      return state.current.stages[id];
    },

    complete(id, evidencePath, { actor } = {}) {
      const def = stageDef(id);
      const state = current();
      const st = state.current.stages[id];
      if (st.status !== "IN_PROGRESS") throw new ReleaseError("STAGE_NOT_IN_PROGRESS", st.status);
      const bytes = fs.readFileSync(evidencePath);
      let ev;
      try { ev = JSON.parse(bytes.toString("utf8")); } catch { throw new ReleaseError("EVIDENCE_NOT_JSON"); }
      const { status, reasons } = evaluateEvidence(def, ev, { sha: state.current.sha, environment: state.environment, startedBy: st.started_by });
      const digest = sha256(bytes);
      fs.mkdirSync(evidenceDir, { recursive: true });
      const stored = path.join(evidenceDir, `${state.current.release_id}-${id}-${digest.slice(0, 16)}.json`);
      fs.writeFileSync(stored, bytes);
      setStage(state, id, { status, reason: reasons.join("; ") || null, evidence: [...st.evidence, { file: path.basename(stored), sha256: digest }], completed_at: now().toISOString() }, { action: "complete", actor, evidence_sha256: digest, reasons });
      write(state);
      return { status, reasons };
    },

    rollback(id, { actor, reason }) {
      stageDef(id);
      if (!reason) throw new ReleaseError("ROLLBACK_REASON_REQUIRED");
      const state = current();
      for (const s of [id, ...dependents(id)]) {
        if (state.current.stages[s].status !== "PENDING") setStage(state, s, { status: "ROLLED_BACK", reason: s === id ? reason : `DEPENDS_ON_ROLLED_BACK_${id}` }, { action: "rollback", actor });
      }
      write(state);
      return state.current.stages;
    },

    verify() {
      const state = current();
      const problems = [];
      for (const [id, st] of Object.entries(state.current.stages)) {
        for (const e of st.evidence) {
          const f = path.join(evidenceDir, e.file);
          if (!fs.existsSync(f)) problems.push(`${id}: evidence ${e.file} missing`);
          else if (sha256(fs.readFileSync(f)) !== e.sha256) problems.push(`${id}: evidence ${e.file} altered`);
        }
        if (st.status === "PASSED") {
          for (const r of stageDef(id).requires) if (state.current.stages[r].status !== "PASSED") problems.push(`${id} PASSED while ${r} is ${state.current.stages[r].status}`);
          if (!st.evidence.length) problems.push(`${id} PASSED without evidence`);
        }
      }
      return { ok: problems.length === 0, problems };
    },
  };
}

/** Pure evaluation of one evidence document against a stage definition. */
export function evaluateEvidence(def, ev, { sha, environment, startedBy }) {
  const reasons = [];
  let failed = false;
  let blocked = false;
  if (!ev || ev.schema !== EVIDENCE_SCHEMA) return { status: "FAILED", reasons: ["EVIDENCE_SCHEMA_INVALID"] };
  if (ev.stage !== def.id) return { status: "FAILED", reasons: ["EVIDENCE_STAGE_MISMATCH"] };
  if (ev.source_sha !== sha) return { status: "FAILED", reasons: ["EVIDENCE_SHA_MISMATCH"] };
  if (ev.environment !== environment) return { status: "FAILED", reasons: ["EVIDENCE_ENVIRONMENT_MISMATCH"] };
  if (!Date.parse(ev.generated_at)) return { status: "FAILED", reasons: ["EVIDENCE_TIMESTAMP_INVALID"] };
  const checks = new Map();
  for (const c of Array.isArray(ev.checks) ? ev.checks : []) {
    if (!c || !CHECK_STATUSES.has(c.status) || typeof c.id !== "string") return { status: "FAILED", reasons: ["EVIDENCE_CHECK_INVALID"] };
    if (checks.has(c.id)) return { status: "FAILED", reasons: ["EVIDENCE_CHECK_DUPLICATE:" + c.id] };
    checks.set(c.id, c);
  }
  for (const id of def.automated_checks) {
    const c = checks.get(id);
    if (!c) { failed = true; reasons.push("CHECK_MISSING:" + id); continue; }
    if (c.status === "FAIL") { failed = true; reasons.push("CHECK_FAILED:" + id); }
    else if (c.status === "NOT_RUN") { failed = true; reasons.push("CHECK_NOT_RUN:" + id); }
    else if (c.status === "PENDING_EXTERNAL") { blocked = true; reasons.push("CHECK_PENDING_EXTERNAL:" + id); }
  }
  const operator = new Map((Array.isArray(ev.operator_evidence) ? ev.operator_evidence : []).map((o) => [o && o.id, o]));
  for (const id of def.operator_evidence) {
    const o = operator.get(id);
    if (!o || typeof o.ref !== "string" || !o.ref.trim() || typeof o.by !== "string" || !o.by.trim()) { blocked = true; reasons.push("OPERATOR_EVIDENCE_MISSING:" + id); }
  }
  if (def.authorization.required) {
    const a = ev.authorization || {};
    if (!a.by) { blocked = true; reasons.push("AUTHORIZATION_MISSING"); }
    if (def.authorization.confirm && a.confirm !== def.authorization.confirm) { blocked = true; reasons.push("AUTHORIZATION_CONFIRMATION_MISSING"); }
    if (["independent-approver", "owner", "source-owner"].includes(def.authorization.by)) {
      if (!a.approved_by) { blocked = true; reasons.push("INDEPENDENT_APPROVAL_MISSING"); }
      else if (startedBy && a.approved_by === startedBy) { failed = true; reasons.push("APPROVER_NOT_INDEPENDENT"); }
    }
  }
  return { status: failed ? "FAILED" : blocked ? "BLOCKED_EXTERNAL" : "PASSED", reasons };
}

/** Builds an evidence document (used by the ops workflow and rehearsals). */
export function buildEvidence({ stage, sha, environment, checks, operatorEvidence = [], authorization = null, artifacts = [], tool = "release-state.mjs" }) {
  return { schema: EVIDENCE_SCHEMA, stage, source_sha: sha, environment, generated_at: new Date().toISOString(), tool, checks, operator_evidence: operatorEvidence, authorization, artifacts };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    else out._.push(argv[i]);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const actor = args.actor || process.env.GITHUB_ACTOR || null;
  try {
    if (!args.dir) throw new ReleaseError("DIR_REQUIRED");
    const store = openStore(args.dir);
    let out;
    switch (cmd) {
      case "init": out = store.init({ sha: args.sha, environment: args.environment, actor }).current; break;
      case "begin": out = store.begin(args.stage, { actor, resume: args.resume === "true", rerun: args.rerun === "true" }); break;
      case "complete": out = store.complete(args.stage, args.evidence, { actor }); break;
      case "rollback": out = store.rollback(args.stage, { actor, reason: args.reason }); break;
      case "status": { const s = store.read(); out = s ? { environment: s.environment, release_id: s.current?.release_id, sha: s.current?.sha, stages: Object.fromEntries(Object.entries(s.current?.stages || {}).map(([k, v]) => [k, { status: v.status, reason: v.reason || null }])), previous_releases: s.history.length } : { status: "NO_STATE" }; break; }
      case "verify": out = store.verify(); if (!out.ok) { process.stdout.write(JSON.stringify(out) + "\n"); process.exit(1); } break;
      default: throw new ReleaseError("UNKNOWN_COMMAND", String(cmd));
    }
    process.stdout.write(JSON.stringify(out) + "\n");
    if (cmd === "complete" && out.status !== "PASSED") process.exit(out.status === "BLOCKED_EXTERNAL" ? 3 : 1);
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.reason || "ERROR", detail: err.detail || err.message }) + "\n");
    process.exit(1);
  }
}
