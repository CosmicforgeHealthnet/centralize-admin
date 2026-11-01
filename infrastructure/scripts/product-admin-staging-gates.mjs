#!/usr/bin/env node
// Section 13.3 staging acceptance gate evaluator (14 gates).
//
// Each gate reports PASS | FAIL | PENDING_EXTERNAL | NOT_RUN with evidence
// references, the tested SHA, environment, timestamp, reason and the
// external prerequisite where relevant. Rules:
//   - a gate that needs REAL staging evidence (release stage PASSED in the
//     staging state) is never PASS from disposable or rehearsal evidence;
//     disposable results are reported as supporting evidence only;
//   - a required input that is missing is NOT_RUN, never PASS;
//   - FULLY_CERTIFIED only when every gate is PASS; any FAIL ->
//     NOT_CERTIFIED; otherwise CODE_CERTIFIED_STAGING_PENDING.
//
//   node infrastructure/scripts/product-admin-staging-gates.mjs \
//     --sha SHA [--artifacts DIR] [--ci-status ci.json] [--staging-state state.json] \
//     [--base SHA] [--report out.json] [--markdown out.md]
//
// ci.json: { "<workflow name>": "success|failure|missing|in_progress" } for SHA.
// --artifacts: directory searched recursively for the known evidence files.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const REQUIRED_WORKFLOWS = ["Product Admin Platform CI", "Product Admin Infrastructure Security CI", "Monorepo Layout and Container CI"];
export const COMPAT_WORKFLOWS = ["Social Operations CI"];
// Paths a Product Admin release range may touch (Sections 1-13 scope).
const RELEASE_SCOPE = [/^services\/(karryam-admin|product-integration-core)\//, /^packages\//, /^infrastructure\/product-admin\//, /^infrastructure\/scripts\/(product-admin-|node-test-jsonl-reporter|tests\/)/, /^\.github\/workflows\/(product-admin-[a-z-]+|staging)\.yml$/, /^docs\/product-admin\//, /^services\/central-admin-api\/src\/modules\/product-gateway\//, /^services\/central-admin-api\/tests\/product-gateway/];
const PROTECTED_PATHS = [/^services\/central-admin-api\/src\/modules\/(mail|healthnet|marketing|auth|logistics)\//, /^services\/healthnet-admin\//, /^apps\/central-admin-web\//, /^\.github\/workflows\/production\.yml$/];

function findFiles(dir, names) {
  const out = {};
  if (!dir || !fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (names.includes(e.name)) (out[e.name] ||= []).push(p);
    }
  };
  walk(dir);
  return out;
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const gitRaw = (...args) => { try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
const git = (...args) => { const out = gitRaw(...args); return out === null ? null : out.trim(); };

/** Pure evaluation from collected inputs (unit-tested). */
export function evaluate(inp) {
  const now = inp.now || new Date().toISOString();
  // Only a real staging release state for this exact commit counts (a rehearsal state never does).
  const stagingState = inp.staging && inp.staging.environment === "staging" && inp.staging.current?.sha === inp.sha ? inp.staging : null;
  const stage = (id) => (stagingState ? stagingState.current.stages?.[id]?.status || "PENDING" : "NO_STAGING_STATE");
  const stagingPassed = (...ids) => ids.every((id) => stage(id) === "PASSED");
  const ci = (name) => (inp.ci || {})[name] || "missing";
  const ciGreen = (names) => names.every((n) => ci(n) === "success");
  const art = inp.artifacts || {};
  const gates = [];
  const gate = (id, title, status, { evidence = [], reason = "", prerequisite = null, supporting = [] } = {}) => gates.push({
    id, title, status, environment: status === "PASS" && evidence.some((e) => e.startsWith("staging:")) ? "staging" : "disposable-ci",
    sha: inp.sha, evaluated_at: now, evidence, supporting_evidence: supporting, reason, external_prerequisite: prerequisite,
  });
  // A staging gate: PASS only with staging evidence; disposable success is supporting only.
  const stagingGate = (id, title, stages, disposableOk, disposableEvidence, prerequisite) => {
    if (disposableOk === false) return gate(id, title, "FAIL", { evidence: disposableEvidence, reason: "disposable certification failed" });
    if (disposableOk === null) return gate(id, title, "NOT_RUN", { reason: "required disposable evidence missing", supporting: disposableEvidence });
    const failedStage = stages.find((s) => ["FAILED", "ROLLED_BACK"].includes(stage(s)));
    if (failedStage) return gate(id, title, "FAIL", { evidence: stages.map((s) => `staging:${s}=${stage(s)}`), reason: `staging stage ${failedStage} ${stage(failedStage)}` });
    if (stagingPassed(...stages)) return gate(id, title, "PASS", { evidence: stages.map((s) => `staging:${s}=PASSED`), supporting: disposableEvidence });
    return gate(id, title, "PENDING_EXTERNAL", { evidence: stages.map((s) => `staging:${s}=${stage(s)}`), supporting: disposableEvidence, reason: "disposable certification passed; real staging evidence not yet recorded", prerequisite });
  };
  const ok = (x) => (x === undefined ? null : x);

  // 1. Repository integrity
  const repo = inp.repo || {};
  if (!repo.checked) gate(1, "Repository integrity", "NOT_RUN", { reason: "git checks not available" });
  else if (!repo.onStaging || repo.unrelatedChanges.length || repo.protectedChanges.length) gate(1, "Repository integrity", "FAIL", { evidence: ["git"], reason: [!repo.onStaging && "commit not on origin/staging", repo.unrelatedChanges.length && `uncommitted changes: ${repo.unrelatedChanges.slice(0, 5).join(", ")}`, repo.protectedChanges.length && `Mail/HealthNet/other protected paths changed: ${repo.protectedChanges.slice(0, 5).join(", ")}`].filter(Boolean).join("; ") });
  else gate(1, "Repository integrity", "PASS", { evidence: [`git:${repo.range || inp.sha}`], reason: "on origin/staging, clean tree, no protected-module changes in the range" });

  // 2. Product naming
  const naming = inp.naming;
  if (!naming) gate(2, "Product naming", "NOT_RUN", { reason: "naming scan not run" });
  else gate(2, "Product naming", naming.violations.length ? "FAIL" : "PASS", { evidence: ["static:naming-scan"], reason: naming.violations.length ? naming.violations.slice(0, 5).join("; ") : "product_id=karryam; KarryGo only in repository names, pinned contract paths and legacy technical paths" });

  const required = art.required_suites;
  const dbDisposable = required === undefined ? null : required.every((r) => r.status === "PASS");
  // 3. Database isolation
  stagingGate(3, "Database isolation", ["S1"], ok(dbDisposable), ["ci:required-suites (section9, migrations, runtime-role negatives)"], "Operator: DB-A/DB-B roles, credentials, PUBLIC CONNECT revocation; then S1");
  // 4. Headquarters boundary
  stagingGate(4, "Headquarters boundary", ["S1", "S2"], ok(inp.boundaryStatic), ["static:network-policy", "ci:static-boundaries", "rehearsal:network-probe"], "S1 db_no_cross_credentials and S2 network probe on the real host");
  // 5. Private Bridge
  stagingGate(5, "Private Bridge", ["S3"], ok(inp.boundaryStatic), ["rehearsal:bridge-network-probe", "ci:connector-security (TLS 1.3 mTLS, pinned fingerprints)"], "Karryam Backoffice enrollment and attachment to cf-staging-karryam-bridge (S3)");
  // 6. Capability discovery
  const audit = art.contract_audit;
  stagingGate(6, "Capability discovery", ["S3"], audit === undefined ? null : audit.result === "PASS", ["ci:product-admin-contract-audit (435 capabilities)"], "Live discovery against the enrolled Bridge (S3)");
  // 7. Database migrations
  const drills = art.restore_drills;
  stagingGate(7, "Database migrations", ["S1"], drills === undefined && dbDisposable === null ? null : dbDisposable !== false && (drills === undefined || drills), ["ci:migrations + restore drills (disposable PostgreSQL)", "rehearsal:backup+migrate-apply"], "Staging backup, preview and approved migration (S1)");
  // 8. Synchronization
  const journeys = art.journeys;
  const j = (ids) => (journeys === undefined ? null : ids.every((id) => journeys.journeys?.find((x) => Number(x.id) === id)?.status === "PASS"));
  stagingGate(8, "Synchronization", ["S4"], j([3, 4, 5, 6, 7]), ["ci:journeys J3-J7", "ci:recovery-postgres"], "Authorized pilot feed partition (S4)");
  // 9. Product Admin Protocol (protocol/registry properties: disposable conformance is the certification)
  const j12 = j([12]);
  if (j12 === null) gate(9, "Product Admin Protocol", "NOT_RUN", { reason: "journey evidence missing" });
  else gate(9, "Product Admin Protocol", j12 && ciGreen(["Product Admin Platform CI"]) ? "PASS" : "FAIL", { evidence: ["ci:journey J12 (synthetic third product)", "ci:conformance-synthetic-third-postgres", "ci:packages"], reason: j12 ? "signed manifest, conformance, registry, dynamic routing and revocation proven with a synthetic third product; no product-specific HQ code" : "journey J12 failed" });
  // 10. Authorized resource reads
  stagingGate(10, "Authorized resource reads", ["S5"], j([1, 2]), ["ci:journeys J1-J2", "ci:api-security-postgres"], "Dataset certification and scoped staff grants on staging (S5)");
  // 11. Governed commands
  stagingGate(11, "Governed commands", ["S6"], j([9, 10]), ["ci:journeys J9-J10", "ci:high-risk-operations", "ci:section11-postgres"], "Source owner approval per command family (S6); none enabled today");
  // 12. Observability and emergency recovery
  stagingGate(12, "Observability and emergency recovery", ["S2"], ok(inp.rehearsal === undefined ? null : inp.rehearsal), ["rehearsal:deploy/rollback/disable/backup", "ci:promtool alert rules", "ci:journey J11 (revocation)"], "Deployed services with monitoring scrape and a staging restore drill");
  // 13. Existing platform compatibility
  const compat = COMPAT_WORKFLOWS.map((n) => `${n}=${ci(n)}`);
  if (COMPAT_WORKFLOWS.some((n) => ci(n) === "missing" || ci(n) === "in_progress")) gate(13, "Existing platform compatibility", "NOT_RUN", { evidence: compat, reason: "compatibility CI not finished for this commit" });
  else if (!ciGreen(COMPAT_WORKFLOWS) || (repo.protectedChanges || []).length) gate(13, "Existing platform compatibility", "FAIL", { evidence: compat, reason: "compatibility CI failed or protected modules changed" });
  else gate(13, "Existing platform compatibility", "PASS", { evidence: compat, reason: "API/Mail/HealthNet/Marketing suites green; no protected module changed; legacy logistics untouched" });
  // 14. Production separation
  const prod = inp.production || {};
  if (!prod.checked) gate(14, "Production separation", "NOT_RUN", { reason: "main/production checks not available" });
  else gate(14, "Production separation", prod.mainChanged || prod.productionWorkflowChanged ? "FAIL" : "PASS", { evidence: ["git:origin/main", "static:ops-workflow-staging-only"], reason: prod.mainChanged ? "main changed in the range" : prod.productionWorkflowChanged ? "production workflow changed" : "main unchanged; staging-only workflows; no staging-to-production routing" });

  const statuses = gates.map((g) => g.status);
  const result = statuses.every((s) => s === "PASS") ? "FULLY_CERTIFIED" : statuses.includes("FAIL") ? "NOT_CERTIFIED" : "CODE_CERTIFIED_STAGING_PENDING";
  return {
    report: "product-admin-staging-gates", schema_version: 1, sha: inp.sha, generated_at: now,
    result, counts: Object.fromEntries(["PASS", "FAIL", "PENDING_EXTERNAL", "NOT_RUN"].map((s) => [s, statuses.filter((x) => x === s).length])),
    staging_state: inp.staging ? { release_sha: inp.staging.current?.sha || null, matches_sha: inp.staging.current?.sha === inp.sha } : null,
    gates,
  };
}

export function collect({ sha, base, artifactsDir, ciStatusFile, stagingStateFile }) {
  const files = findFiles(artifactsDir, ["product-admin-contract-audit.json", "karryam-admin-required-suites.json", "pic-required-suites.json", "product-admin-e2e-journeys.json", "product-admin-security-coverage.json", "product-admin-release-state.json", "release-status.json"]);
  const artifacts = {};
  if (files["product-admin-contract-audit.json"]) artifacts.contract_audit = readJson(files["product-admin-contract-audit.json"][0]);
  const req = [...(files["karryam-admin-required-suites.json"] || []), ...(files["pic-required-suites.json"] || [])].map(readJson).filter(Boolean);
  if (req.length) artifacts.required_suites = req;
  if (files["product-admin-e2e-journeys.json"]) artifacts.journeys = readJson(files["product-admin-e2e-journeys.json"][0]);
  const rehearsalStatus = files["release-status.json"] ? readJson(files["release-status.json"][0]) : null;

  // Repository checks.
  const repo = { checked: false };
  const head = git("rev-parse", "HEAD");
  if (head) {
    git("fetch", "-q", "origin", "staging");
    const onStaging = git("merge-base", "--is-ancestor", sha, "origin/staging") !== null;
    // Tracked modifications only: untracked files of other agents are not part of any release commit.
    const status = (gitRaw("status", "--porcelain", "--untracked-files=no") || "").split("\n").filter(Boolean).map((l) => l.slice(3));
    const range = base ? `${base}..${sha}` : null;
    const changed = range ? (git("diff", "--name-only", range) || "").split("\n").filter(Boolean) : [];
    const outOfScope = changed.filter((p) => !RELEASE_SCOPE.some((r) => r.test(p)));
    Object.assign(repo, { checked: true, onStaging, unrelatedChanges: [...status, ...outOfScope.map((p) => "out of scope: " + p)], protectedChanges: changed.filter((p) => PROTECTED_PATHS.some((r) => r.test(p))), range });
  }
  // Production separation.
  const production = { checked: false };
  if (head && base) {
    git("fetch", "-q", "origin", "main:refs/remotes/origin/main");
    const mainHead = git("rev-parse", "origin/main");
    const changed = (git("diff", "--name-only", `${base}..${sha}`) || "").split("\n");
    // Promotion = the release commit reached main. Staging work must never do that.
    Object.assign(production, { checked: Boolean(mainHead), mainChanged: mainHead ? git("merge-base", "--is-ancestor", sha, "origin/main") !== null : false, productionWorkflowChanged: changed.includes(".github/workflows/production.yml") });
  }
  // Naming: new Product Admin files must use Karryam; KarryGo only in allowed technical contexts.
  const naming = { violations: [] };
  const allowed = /karrygo-backoffice|KarryGo repository|CosmicforgeHealthnet\/KarryGo|_karrygo|KARRYGO_|karrygo\/dispatch|legacy|pinned KarryGo|KarryGo checkout|KarryGo source|KarryGo staging|source_commit|KarryGo `services|KarryGo bridge|\bKarryGo\s*$|KarryGo (shared|services)\/|karrygo-[a-z-]+\.(v\d|json)/i;
  for (const dir of ["infrastructure/product-admin", "services/karryam-admin/src", "services/product-integration-core/src"]) {
    const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/contracts|node_modules/.test(e.name)) walk(p); } else if (/\.(js|mjs|json|md|yml|sh|sql)$/.test(e.name)) { const lines = fs.readFileSync(path.join(ROOT, p), "utf8").split("\n"); lines.forEach((l, i) => { if (/karrygo/i.test(l) && !allowed.test(l)) naming.violations.push(`${p.replace(/\\/g, "/")}:${i + 1}`); }); } } };
    if (fs.existsSync(path.join(ROOT, dir))) walk(dir);
  }
  const productIdOk = fs.readFileSync(path.join(ROOT, "services/karryam-admin/src/config/index.js"), "utf8").includes('const PRODUCT_ID = "karryam"');
  if (!productIdOk) naming.violations.push("Karryam Admin PRODUCT_ID is not karryam");
  // HQ boundary (static): PIC template has no Bridge credentials; policy forbids the bypasses.
  const policy = readJson(path.join(ROOT, "infrastructure/product-admin/staging/network-policy.json"));
  const picTemplate = fs.readFileSync(path.join(ROOT, "infrastructure/product-admin/staging/product-integration-core.env.template"), "utf8");
  const boundaryStatic = Boolean(policy) && !/KARRYAM_BRIDGE_|ADMIN_BACKOFFICE_/.test(picTemplate) &&
    ["central-admin-api", "product-integration-core"].every((m) => !policy.networks["karryam-bridge"].permitted_members.includes(m));
  const ci = ciStatusFile ? readJson(ciStatusFile) || {} : {};
  const staging = stagingStateFile ? readJson(stagingStateFile) : null;
  const rehearsal = rehearsalStatus ? ["S0", "S1", "S2"].every((s) => rehearsalStatus.stages?.[s]?.status === "PASSED" || rehearsalStatus.stages?.[s]?.status === "ROLLED_BACK") : undefined;
  return { sha, artifacts, repo, production, naming, boundaryStatic, ci, staging, rehearsal };
}

export function markdown(r) {
  const rows = r.gates.map((g) => `| ${g.id} | ${g.title} | **${g.status}** | ${g.reason.replace(/\|/g, "/")} | ${(g.external_prerequisite || "—").replace(/\|/g, "/")} |`);
  return [`# Staging gates — ${r.result}`, "", `SHA \`${r.sha}\`, evaluated ${r.generated_at}. PASS ${r.counts.PASS}, FAIL ${r.counts.FAIL}, PENDING_EXTERNAL ${r.counts.PENDING_EXTERNAL}, NOT_RUN ${r.counts.NOT_RUN}.`, "", "| # | Gate | Status | Reason | External prerequisite |", "|---|---|---|---|---|", ...rows, ""].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith("--") ? [...acc, [v.slice(2), arr[i + 1]]] : acc), []));
  const sha = a.sha || git("rev-parse", "HEAD");
  const r = evaluate(collect({ sha, base: a.base, artifactsDir: a.artifacts, ciStatusFile: a["ci-status"], stagingStateFile: a["staging-state"] }));
  if (a.report) { fs.mkdirSync(path.dirname(path.resolve(a.report)), { recursive: true }); fs.writeFileSync(a.report, JSON.stringify(r, null, 2)); }
  if (a.markdown) fs.writeFileSync(a.markdown, markdown(r));
  for (const g of r.gates) process.stdout.write(`${String(g.id).padStart(2)} ${g.status.padEnd(16)} ${g.title}: ${g.reason}\n`);
  process.stdout.write(`RESULT ${r.result}\n`);
  process.exit(r.result === "NOT_CERTIFIED" ? 1 : 0);
}
