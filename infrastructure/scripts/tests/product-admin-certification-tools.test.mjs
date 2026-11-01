// Section 13.1 certification tooling: security coverage gate (pure policy
// evaluation and lcov parsing), required-suite skip detection, and the
// contract audit in a mode that does not need a KarryGo checkout.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLcov, mergeCoverage, summarize, evaluate, pct, parseTapSummary } from "../product-admin-coverage-gate.mjs";
import { evaluateJsonl, evaluateTap, parseTap, parseJsonl } from "../product-admin-no-required-skips.mjs";
import { runAudit, samplePaths } from "../product-admin-contract-audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const POLICY = JSON.parse(fs.readFileSync(path.join(ROOT, "infrastructure/product-admin/coverage-policy.json"), "utf8"));

const LCOV = (sf, da, brda) => ["TN:", "SF:" + sf, ...da.map(([l, h]) => `DA:${l},${h}`), ...brda.map(([l, b, i, h]) => `BRDA:${l},${b},${i},${h}`), "end_of_record"].join("\n");

test("lcov: paths resolve against the project directory; lines union across runs, branches use the most-covering run", () => {
  const base = path.join(ROOT, "packages", "x");
  const a = parseLcov(LCOV("src\\a.js", [[1, 1], [2, 0], [3, 0]], [[1, 0, 0, 1], [1, 1, 0, 0]]), base);
  const b = parseLcov(LCOV("src/a.js", [[1, 0], [2, 4], [3, 0]], [[9, 0, 0, 1], [9, 1, 0, 1], [9, 2, 0, 0]]), base);
  assert.deepEqual(Object.keys(a), ["packages/x/src/a.js"]);
  const s = summarize(mergeCoverage([a, b])["packages/x/src/a.js"]);
  assert.deepEqual(s.lines, { found: 3, hit: 2 });
  assert.deepEqual(s.branches, { found: 3, hit: 2 }, "the run with more covered branches wins; BRDA ids are never unioned");
  assert.equal(pct({ found: 3, hit: 2 }), 66.66);
  assert.equal(pct({ found: 0, hit: 0 }), 100);
});

test("lcov: a run that merely loaded a module cannot outrank one that exercised it", () => {
  const loaded = parseLcov(LCOV("/r/m.js", [[1, 1]], [[1, 0, 0, 1]]), "/");
  const exercised = parseLcov(LCOV("/r/m.js", [[1, 1]], [[1, 0, 0, 5], [2, 1, 0, 3], [3, 2, 0, 0], [4, 3, 0, 0]]), "/");
  const key = Object.keys(loaded)[0];
  assert.deepEqual(summarize(mergeCoverage([loaded, exercised])[key]).branches, { found: 4, hit: 2 });
  assert.deepEqual(summarize(mergeCoverage([exercised, loaded])[key]).branches, { found: 4, hit: 2 });
});

test("TAP summary counts", () => {
  assert.deepEqual(parseTapSummary("# tests 4\n# pass 3\n# fail 1\n# skipped 0\n# todo 0\n# cancelled 0\n"), { tests: 4, pass: 3, fail: 1, skipped: 0, todo: 0, cancelled: 0 });
});

function cov(lines, branches) { return { da: new Map(Array.from({ length: lines[1] }, (_, i) => [String(i + 1), i < lines[0] ? 1 : 0])), branches: { found: branches[1], hit: branches[0] } }; }

test("policy evaluation: threshold, missing module, unlisted security file, dangling and unjustified entries", () => {
  const policy = {
    security_patterns: ["auth", "nonce"],
    modules: [{ path: "p/src/auth.js", category: "authz", lines: 90, branches: 80 }, { path: "p/src/gone.js", category: "x", lines: 0, branches: 0 }],
    exempt: [{ path: "p/src/nonce-memory.js", reason: "x" }],
  };
  const coverage = { "p/src/auth.js": cov([9, 10], [7, 10]) };
  const r = evaluate(policy, coverage, ["p/src/auth.js", "p/src/nonce-memory.js", "p/src/oauth-helper.js", "p/src/plain.js"]);
  assert.equal(r.status, "FAIL");
  assert.equal(r.modules.find((m) => m.path === "p/src/auth.js").status, "FAIL", "70% branches is below 80%");
  assert.equal(r.modules.find((m) => m.path === "p/src/gone.js").reason, "MISSING_FROM_COVERAGE");
  assert.deepEqual(r.unlisted, ["p/src/oauth-helper.js"]);
  assert.ok(r.problems.some((p) => p.includes("exemption without a written reason")));
  assert.ok(r.problems.some((p) => p.startsWith("p/src/gone.js: policy entry does not exist")));
  const ok = evaluate({ security_patterns: ["auth"], modules: [{ path: "p/src/auth.js", category: "authz", lines: 90, branches: 70 }], exempt: [] }, coverage, ["p/src/auth.js"]);
  assert.equal(ok.status, "PASS");
});

test("committed policy: every module and exemption exists, is unique, categorized and justified", () => {
  const all = [...POLICY.modules.map((m) => m.path), ...POLICY.exempt.map((e) => e.path)];
  assert.equal(new Set(all).size, all.length, "no duplicates");
  for (const m of POLICY.modules) {
    assert.ok(fs.existsSync(path.join(ROOT, m.path)), m.path);
    assert.ok(m.category && Number.isFinite(m.lines) && Number.isFinite(m.branches) && m.lines <= 100 && m.branches <= 100, m.path);
  }
  for (const e of POLICY.exempt) { assert.ok(fs.existsSync(path.join(ROOT, e.path)), e.path); assert.ok(e.reason.length >= 10, e.path); }
  const required = ["hmac", "delegation", "query_canonicalization", "permission_evaluation", "finance", "metric_coverage", "data_classification", "idempotency", "approval", "rate_limiting", "config_validation", "replay_protection"];
  const categories = new Set(POLICY.modules.map((m) => m.category));
  for (const c of required) assert.ok(categories.has(c), "category without a listed module: " + c);
});

test("required suites: skips, todos, failures, cancellations and missing files fail; others are ignored", () => {
  const ev = (type, file, name, extra = {}) => ({ type, file: "/x/tests/" + file, name, skip: false, todo: false, ...extra });
  const events = [
    ev("test:pass", "a-postgres.test.js", "ok"),
    ev("test:pass", "a-postgres.test.js", "skipped", { skip: "no database" }),
    ev("test:pass", "section11.test.js", "todo", { todo: true }),
    ev("test:fail", "connector-security.test.js", "cancelled", { failure_type: "cancelledByParent" }),
    ev("test:pass", "unit.test.js", "posix only", { skip: "POSIX" }),
  ];
  const r = evaluateJsonl(events, { requiredFiles: ["a-postgres.test.js", "section11.test.js", "connector-security.test.js", "high-risk-operations.test.js", "unit.test.js"] });
  assert.equal(r.status, "FAIL");
  assert.ok(r.problems.some((p) => p.includes("SKIPPED (no database)")));
  assert.ok(r.problems.some((p) => p.includes("is TODO")));
  assert.ok(r.problems.some((p) => p.includes("CANCELLED")));
  assert.ok(r.problems.some((p) => p.startsWith("high-risk-operations.test.js: required suite DID NOT RUN")));
  assert.ok(r.problems.some((p) => p.startsWith("section11.test.js: required suite executed no tests")));
  assert.equal(r.problems.some((p) => p.includes("unit.test.js")), false, "non-required suites may skip");
  assert.equal(evaluateJsonl(parseJsonl(JSON.stringify(ev("test:pass", "b-postgres.test.js", "fine")) + "\n"), { requiredFiles: ["b-postgres.test.js"] }).status, "PASS");
});

test("required suites (TAP fallback): any skip or todo fails", () => {
  const tap = "TAP version 13\nok 1 - fine\nok 2 - backup # SKIP pg_dump not installed\nnot ok 3 - later # TODO\n    ok 1 - nested\n";
  const parsed = parseTap(tap);
  assert.equal(parsed.length, 4);
  const r = evaluateTap(parsed);
  assert.equal(r.status, "FAIL");
  assert.equal(r.problems.length, 2);
  assert.equal(evaluateTap(parseTap("ok 1 - a\nok 2 - b\n")).status, "PASS");
});

test("gateway route regexes expand to concrete sample paths", () => {
  const frag = [["[a-z]+", "karryam"], ["[0-9]+", "7"]];
  assert.deepEqual(samplePaths("^\\/[a-z]+\\/x\\/(?:enable|disable)$", frag), ["/karryam/x/enable", "/karryam/x/disable"]);
  assert.deepEqual(samplePaths("^/[0-9]+/(?:a|b)/(?:c|d)$", frag), ["/7/a/c", "/7/a/d", "/7/b/c", "/7/b/d"]);
});

test("contract audit passes without a KarryGo checkout, and fails closed when one is required", async () => {
  const report = await runAudit({ checkout: path.join(ROOT, "no-such-karrygo-checkout"), requireCheckout: false });
  assert.equal(report.status, "PASS", JSON.stringify(report.checks.filter((c) => c.status === "FAIL")));
  const registry = report.checks.find((c) => c.id === "bridge.capability_registry");
  assert.equal(registry.detail.capabilities, 435);
  assert.equal(registry.detail.unique_ids, 435);
  assert.equal(report.checks.find((c) => c.id === "protocol.version").detail.version, "1.1");
  assert.equal(report.checks.find((c) => c.id === "hq_gateway.routes_map_to_pic").status, "PASS");
  assert.equal(report.checks.find((c) => c.id === "bridge.source_methods_and_paths").status, "SKIP");
  const strict = await runAudit({ checkout: path.join(ROOT, "no-such-karrygo-checkout"), requireCheckout: true });
  assert.equal(strict.status, "FAIL");
  assert.equal(strict.checks.find((c) => c.id === "bridge.source_methods_and_paths").status, "FAIL");
});
