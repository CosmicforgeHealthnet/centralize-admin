#!/usr/bin/env node
// Section 13.1 security-critical coverage gate (dependency-free).
//
// Runs every Product Admin test project under Node's built-in coverage
// (lcov + TAP reporters), then enforces per-file line AND branch thresholds
// for the security-critical modules listed in
// infrastructure/product-admin/coverage-policy.json.
//
// The gate fails when:
//   - a listed module is missing from the coverage data (it was not loaded by
//     any test, or the file was moved/renamed without updating the policy);
//   - a listed module is below its line or branch threshold;
//   - a source file whose path matches a security-critical name pattern is
//     neither listed nor exempted with a written reason;
//   - a project's tests failed (unless --tests-may-fail, which marks the
//     report as non-certifying);
//   - a project marked "requires_database" ran without its test database URL
//     while PRODUCT_ADMIN_REQUIRE_DATABASE=1 (CI sets it).
//
// Coverage of a shared package counts every project's tests (service suites
// exercise package code too): line hits are unioned across projects, and
// branch totals come from the single run that covered the most branches.
// Thresholds therefore apply to the FULL run; --only, --reuse and
// --tests-may-fail are diagnostic and mark the report "certifying": false.
//
// Usage:
//   node infrastructure/scripts/product-admin-coverage-gate.mjs [--only <project>] [--tests-may-fail] [--measure] [--reuse]
// Env: COVERAGE_REPORT_DIR (default ./artifacts), KARRYAM_ADMIN_TEST_DATABASE_URL,
//      PIC_TEST_DATABASE_URL, PRODUCT_ADMIN_REQUIRE_DATABASE=1.
// Output: <dir>/product-admin-security-coverage.json, raw lcov/TAP per project.

import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY_FILE = path.join(ROOT, "infrastructure", "product-admin", "coverage-policy.json");

export function rel(file, base = ROOT) {
  let f = String(file).trim();
  if (f.startsWith("file://")) f = fileURLToPath(f);
  const r = path.relative(ROOT, path.resolve(base, f.replace(/\\/g, "/")));
  return r.split(path.sep).join("/");
}

/**
 * Parses lcov text into { file: { da: Map(line -> hits), branches: {found, hit} } }.
 * SF paths are resolved against baseDir (the project's working directory).
 * Branch totals come from BRDA records of this one run (Node numbers branch
 * blocks per process, so BRDA keys are not comparable across runs).
 */
export function parseLcov(text, baseDir = ROOT) {
  const out = {};
  let cur = null;
  let brda = null;
  const close = () => {
    if (cur && brda) cur.branches = { found: brda.size, hit: [...brda.values()].filter((v) => v > 0).length };
    cur = null; brda = null;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      close();
      const file = rel(line.slice(3), baseDir);
      cur = out[file] = { da: new Map(), branches: { found: 0, hit: 0 } };
      brda = new Map();
    } else if (!cur) continue;
    else if (line.startsWith("DA:")) {
      const [ln, hits] = line.slice(3).split(",");
      cur.da.set(ln, Math.max(cur.da.get(ln) || 0, Number(hits) || 0));
    } else if (line.startsWith("BRDA:")) {
      const [ln, block, branch, hits] = line.slice(5).split(",");
      const key = ln + "," + block + "," + branch;
      brda.set(key, Math.max(brda.get(key) || 0, hits === "-" ? 0 : Number(hits) || 0));
    } else if (line === "end_of_record") close();
  }
  close();
  return out;
}

/**
 * Combines runs of several projects. Lines are a true union (a line is
 * covered if any run executed it). Branches use the single run that covered the
 * most branches of that file (Node numbers branch blocks per process, so runs
 * cannot be unioned); this is a conservative lower bound of the true union.
 */
export function mergeCoverage(maps) {
  const out = {};
  for (const m of maps) {
    for (const [file, c] of Object.entries(m)) {
      const t = out[file] || (out[file] = { da: new Map(), branches: { found: 0, hit: 0 } });
      for (const [k, v] of c.da) t.da.set(k, Math.max(t.da.get(k) || 0, v));
      if (c.branches.hit > t.branches.hit || (c.branches.hit === t.branches.hit && c.branches.found < t.branches.found && t.branches.hit > 0)) t.branches = { ...c.branches };
      if (t.branches.found === 0) t.branches = { ...c.branches };
    }
  }
  return out;
}

/** { lines: {found, hit}, branches: {found, hit} } for one merged file. */
export function summarize(c) {
  return { lines: { found: c.da.size, hit: [...c.da.values()].filter((v) => v > 0).length }, branches: c.branches };
}

export function pct({ found, hit }) {
  return found === 0 ? 100 : Math.floor((hit / found) * 10000) / 100;
}

/** TAP summary: counts and failed/skipped test names. */
export function parseTapSummary(text) {
  const num = (k) => { const m = new RegExp("^# " + k + " (\\d+)$", "m").exec(text); return m ? Number(m[1]) : null; };
  return { tests: num("tests"), pass: num("pass"), fail: num("fail"), skipped: num("skipped"), todo: num("todo"), cancelled: num("cancelled") };
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules") out.push(...walk(p)); }
    else if (entry.name.endsWith(".js")) out.push(rel(p));
  }
  return out;
}

/**
 * Pure policy evaluation (unit-tested). coverage: parsed lcov map.
 * sources: every src file of the measured projects (repo-relative).
 */
export function evaluate(policy, coverage, sources) {
  const patterns = policy.security_patterns.map((p) => new RegExp(p, "i"));
  const listed = new Map(policy.modules.map((m) => [m.path, m]));
  const exempt = new Map((policy.exempt || []).map((e) => [e.path, e]));
  const modules = [];
  const problems = [];
  for (const m of policy.modules) {
    const c = coverage[m.path] ? summarize(coverage[m.path]) : null;
    if (!c) {
      modules.push({ path: m.path, category: m.category, status: "FAIL", reason: "MISSING_FROM_COVERAGE", threshold: { lines: m.lines, branches: m.branches } });
      problems.push(m.path + ": missing from coverage data");
      continue;
    }
    const lines = pct(c.lines);
    const branches = pct(c.branches);
    const ok = lines >= m.lines && branches >= m.branches;
    modules.push({ path: m.path, category: m.category, lines, branches, lines_found: c.lines.found, branches_found: c.branches.found, threshold: { lines: m.lines, branches: m.branches }, status: ok ? "PASS" : "FAIL", reason: ok ? null : "BELOW_THRESHOLD" });
    if (!ok) problems.push(`${m.path}: lines ${lines}% (min ${m.lines}), branches ${branches}% (min ${m.branches})`);
  }
  for (const e of policy.exempt || []) {
    if (!e.reason || String(e.reason).trim().length < 10) problems.push(e.path + ": exemption without a written reason");
    if (listed.has(e.path)) problems.push(e.path + ": both listed and exempted");
  }
  const unlisted = [];
  for (const src of sources) {
    if (listed.has(src) || exempt.has(src)) continue;
    if (patterns.some((re) => re.test(src))) unlisted.push(src);
  }
  for (const u of unlisted) problems.push(u + ": matches a security-critical pattern but is neither listed nor exempted");
  for (const p of [...listed.keys(), ...exempt.keys()]) {
    if (!sources.includes(p)) problems.push(p + ": policy entry does not exist in the source tree");
  }
  return { modules, unlisted, problems, status: problems.length === 0 ? "PASS" : "FAIL" };
}

// The root-only run is separate from ordinary CI. Accept its coverage only
// with successful same-commit evidence bound to the exact LCOV bytes.
export function readSupplementalCoverage(file, sourceSha, baseDir = ROOT) {
  const fail = (problem) => ({ coverage: null, problem });
  if (!file || !fs.existsSync(file)) return fail("required isolated operator coverage is missing");
  try {
    const text = fs.readFileSync(file, "utf8");
    const proof = JSON.parse(fs.readFileSync(file + ".json", "utf8"));
    if (!/^[0-9a-f]{40}$/.test(sourceSha || "") || proof.source_sha !== sourceSha || proof.exit_code !== 0 || proof.sandbox !== "isolated-root-postgresql" || proof.coverage_sha256 !== createHash("sha256").update(text).digest("hex")) return fail("operator coverage proof is not current and successful");
    const coverage = parseLcov(text, baseDir);
    if (!Object.keys(coverage).length) return fail("isolated operator coverage is empty");
    return { coverage, problem: null };
  } catch { return fail("operator coverage or its proof is unreadable or invalid"); }
}

function gitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return null; }
}

function runProject(project, outDir, env, reuse = false) {
  const cwd = path.join(ROOT, project.dir);
  const name = project.dir.replace(/[\\/]/g, "_");
  const lcovFile = path.join(outDir, name + ".lcov.info");
  const tapFile = path.join(outDir, name + ".tap");
  const tests = project.tests || ["tests/*.test.js"];
  const args = [
    "--test", "--experimental-test-coverage",
    "--test-reporter=lcov", "--test-reporter-destination=" + lcovFile,
    "--test-reporter=tap", "--test-reporter-destination=" + tapFile,
    ...tests,
  ];
  const started = new Date().toISOString();
  if (reuse) {
    // Re-evaluate previously written reporter output (no tests are run).
    const tap = fs.existsSync(tapFile) ? fs.readFileSync(tapFile, "utf8") : "";
    const summary = parseTapSummary(tap);
    const coverage = fs.existsSync(lcovFile) ? parseLcov(fs.readFileSync(lcovFile, "utf8"), cwd) : {};
    return { project: project.dir, started, finished: started, reused: true, exit_code: tap ? (summary.fail === 0 ? 0 : 1) : null, signal: null, summary, coverage, lcov: rel(lcovFile), tap: rel(tapFile) };
  }
  const res = spawnSync(process.execPath, args, { cwd, env, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  const finished = new Date().toISOString();
  const tap = fs.existsSync(tapFile) ? fs.readFileSync(tapFile, "utf8") : "";
  const coverage = fs.existsSync(lcovFile) ? parseLcov(fs.readFileSync(lcovFile, "utf8"), cwd) : {};
  return { project: project.dir, started, finished, exit_code: res.status, signal: res.signal || null, summary: parseTapSummary(tap), coverage, lcov: rel(lcovFile), tap: rel(tapFile) };
}

function parseArgs(argv) {
  const a = { only: null, testsMayFail: false, measure: false, reuse: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--only") a.only = argv[++i];
    else if (argv[i] === "--tests-may-fail") a.testsMayFail = true;
    else if (argv[i] === "--measure") a.measure = true;
    else if (argv[i] === "--reuse") a.reuse = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = JSON.parse(fs.readFileSync(POLICY_FILE, "utf8"));
  const outDir = path.resolve(process.env.COVERAGE_REPORT_DIR || path.join(ROOT, "artifacts"));
  fs.mkdirSync(outDir, { recursive: true });
  const requireDb = process.env.PRODUCT_ADMIN_REQUIRE_DATABASE === "1";
  const projects = policy.projects.filter((p) => !args.only || p.dir === args.only);
  const runs = [];
  const problems = [];
  for (const project of projects) {
    const dbVar = project.database_env || null;
    const dbAvailable = dbVar ? Boolean(process.env[dbVar]) : null;
    if (dbVar && requireDb && !dbAvailable) problems.push(project.dir + ": " + dbVar + " not set while PRODUCT_ADMIN_REQUIRE_DATABASE=1");
    process.stderr.write(`coverage: ${project.dir} (database: ${dbVar ? (dbAvailable ? "yes" : "no") : "n/a"})\n`);
    const run = runProject(project, outDir, { ...process.env }, args.reuse);
    run.postgresql = dbVar ? { env: dbVar, ran_with_database: dbAvailable } : null;
    if (project.supplemental_coverage_env) {
      const supplemental = process.env[project.supplemental_coverage_env];
      const extra = readSupplementalCoverage(supplemental, gitSha(), path.join(ROOT, project.dir));
      if (extra.problem) problems.push(project.dir + ": " + extra.problem);
      else {
        run.coverage = mergeCoverage([run.coverage, extra.coverage]);
        run.supplemental_coverage = path.basename(supplemental);
      }
    }
    if (run.exit_code !== 0) {
      const msg = `${project.dir}: tests failed (exit ${run.exit_code}, fail ${run.summary.fail})`;
      if (args.testsMayFail) run.tests_failed_tolerated = true; else problems.push(msg);
    }
    runs.push(run);
  }
  const coverage = mergeCoverage(runs.map((r) => r.coverage));
  const sources = [...new Set(projects.flatMap((p) => walk(path.join(ROOT, p.dir, "src"))))].sort();
  const scopedPolicy = { ...policy, modules: policy.modules.filter((m) => projects.some((p) => m.path.startsWith(p.dir + "/"))), exempt: (policy.exempt || []).filter((e) => projects.some((p) => e.path.startsWith(p.dir + "/"))) };
  const result = evaluate(scopedPolicy, coverage, sources);
  if (args.measure) {
    const rows = sources.map((s) => { const c = coverage[s] ? summarize(coverage[s]) : null; return c ? `${pct(c.lines).toFixed(2).padStart(7)} ${pct(c.branches).toFixed(2).padStart(7)}  ${s}` : `   n/a     n/a  ${s}`; });
    process.stderr.write("  lines  branch  file\n" + rows.join("\n") + "\n");
  }
  const all = [...problems, ...result.problems];
  const report = {
    artifact: "product-admin-security-coverage",
    schema_version: 1,
    source_sha: gitSha(),
    environment: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
    platform: process.platform,
    node_version: process.version,
    tool: "node --test --experimental-test-coverage (lcov)",
    policy_file: rel(POLICY_FILE),
    policy_revision: policy.revision,
    generated_at: new Date().toISOString(),
    certifying: !args.testsMayFail && !args.only && !args.reuse,
    projects: runs.map(({ coverage: _c, ...r }) => r),
    modules: result.modules,
    unlisted_security_files: result.unlisted,
    problems: all,
    status: all.length === 0 ? "PASS" : "FAIL",
  };
  const file = path.join(outDir, "product-admin-security-coverage.json");
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  for (const m of result.modules) process.stderr.write(`${m.status.padEnd(4)} ${String(m.lines ?? "-").padStart(6)}/${String(m.branches ?? "-").padStart(6)} (min ${m.threshold.lines}/${m.threshold.branches}) ${m.path}\n`);
  for (const p of all) process.stderr.write("PROBLEM: " + p + "\n");
  process.stderr.write(`coverage gate: ${report.status} -> ${rel(file)}\n`);
  process.exitCode = report.status === "PASS" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { process.stderr.write("coverage gate error: " + (err && err.stack || err) + "\n"); process.exit(2); });
}
