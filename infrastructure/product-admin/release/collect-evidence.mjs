#!/usr/bin/env node
// Builds one stage evidence document (release-state.mjs schema) from the
// PA_CHECK lines printed by pa-staging-ops.sh and from report files.
//
//   node collect-evidence.mjs --stage S2 --sha SHA --environment staging|rehearsal \
//     --log ops.log [--log more.log] [--probe-report ingress.json] [--extra checks.json] \
//     [--operator-evidence op.json] [--authorization auth.json] --out evidence.json
//
// The latest line for a check wins (a re-run supersedes). Stage checks that
// aggregate several host checks are derived here; a missing input is
// NOT_RUN, never PASS.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STAGES, buildEvidence } from "./release-state.mjs";

const COMPOSITE = {
  migration_preview_ok: ["migration_preview_pic", "migration_preview_karryam"],
  migrations_applied: ["migration_apply_pic", "migration_apply_karryam"],
};

export function parseChecks(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^PA_CHECK (\{.*\})\s*$/.exec(line);
    if (!m) continue;
    try { const c = JSON.parse(m[1]); if (c && c.id && c.status) out.set(c.id, { id: c.id, status: c.status, detail: c.detail || "" }); } catch { /* ignore malformed */ }
  }
  return out;
}

function combine(parts) {
  if (parts.some((p) => !p)) return "NOT_RUN";
  if (parts.some((p) => p.status === "FAIL")) return "FAIL";
  if (parts.some((p) => p.status === "NOT_RUN")) return "NOT_RUN";
  if (parts.some((p) => p.status === "PENDING_EXTERNAL")) return "PENDING_EXTERNAL";
  return "PASS";
}

export function stageChecks(stageId, found) {
  const def = STAGES.stages.find((s) => s.id === stageId);
  if (!def) throw new Error("UNKNOWN_STAGE " + stageId);
  return def.automated_checks.map((id) => {
    if (found.has(id)) return found.get(id);
    if (COMPOSITE[id]) {
      const parts = COMPOSITE[id].map((p) => found.get(p));
      return { id, status: combine(parts), detail: COMPOSITE[id].map((p) => `${p}=${found.get(p)?.status || "MISSING"}`).join(", ") };
    }
    return { id, status: "NOT_RUN", detail: "no result recorded for this run" };
  });
}

function parseArgs(argv) {
  const out = { log: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2); const v = argv[i + 1];
    if (k === "log") out.log.push(v); else out[k] = v;
    i += 1;
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = parseArgs(process.argv.slice(2));
  const found = new Map();
  for (const f of a.log) for (const [k, v] of parseChecks(fs.readFileSync(f, "utf8"))) found.set(k, v);
  if (a["probe-report"]) {
    const r = JSON.parse(fs.readFileSync(a["probe-report"], "utf8"));
    found.set("nginx_internal_denied", { id: "nginx_internal_denied", status: r.result === "PASS" ? "PASS" : "FAIL", detail: `${r.passed}/${r.total} ingress cases (${r.mode})` });
  }
  if (a.extra) for (const c of JSON.parse(fs.readFileSync(a.extra, "utf8"))) found.set(c.id, c);
  const ev = buildEvidence({
    stage: a.stage, sha: a.sha, environment: a.environment,
    checks: stageChecks(a.stage, found),
    operatorEvidence: a["operator-evidence"] ? JSON.parse(fs.readFileSync(a["operator-evidence"], "utf8")) : [],
    authorization: a.authorization ? JSON.parse(fs.readFileSync(a.authorization, "utf8")) : null,
    artifacts: [...a.log.map((f) => path.basename(f)), ...(a["probe-report"] ? [path.basename(a["probe-report"])] : [])],
    tool: "collect-evidence.mjs",
  });
  fs.writeFileSync(a.out, JSON.stringify(ev, null, 2));
  const summary = ev.checks.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] || 0) + 1 }), {});
  process.stdout.write(JSON.stringify({ stage: a.stage, checks: summary }) + "\n");
}
