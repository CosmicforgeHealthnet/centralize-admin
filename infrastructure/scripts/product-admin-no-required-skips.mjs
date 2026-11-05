#!/usr/bin/env node
// Fails when a REQUIRED security/database suite was skipped, todo'd, failed,
// cancelled or did not run at all. A skipped required test is never a pass.
//
// Input: JSON lines from node-test-jsonl-reporter.mjs (preferred: carries the
// file), or TAP from --test-reporter=tap (no file attribution: any SKIP/TODO
// anywhere fails, and "did not run" cannot be checked).
//
//   node infrastructure/scripts/product-admin-no-required-skips.mjs \
//     --results out.jsonl --tests-dir services/karryam-admin/tests \
//     [--require <regex>]... [--report <file.json>]
//
// Default required patterns (file basename): -postgres\.test\.js$,
// ^section11, ^connector-security, ^api-security-postgres,
// ^high-risk-operations, ^identity-gate.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_REQUIRED = ["-postgres\\.test\\.js$", "^section11", "^connector-security", "^api-security-postgres", "^high-risk-operations", "^identity-gate"];

function basenameOf(file) {
  if (!file) return null;
  let f = String(file);
  if (f.startsWith("file://")) f = fileURLToPath(f);
  return f.split(/[\\/]/).pop();
}

export function parseJsonl(text) {
  return String(text).split(/\r?\n/).filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
}

/** TAP: returns [{ name, skip, todo, failed }] (no file attribution). */
export function parseTap(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(not ok|ok) \d+ - (.*?)(?:\s+#\s*(SKIP|TODO)\b(.*))?$/i.exec(line);
    if (!m) continue;
    out.push({ name: m[2], failed: m[1] === "not ok" && !(m[3] && m[3].toUpperCase() === "TODO"), skip: m[3] && m[3].toUpperCase() === "SKIP" ? (m[4] || "").trim() || true : false, todo: m[3] && m[3].toUpperCase() === "TODO" ? (m[4] || "").trim() || true : false });
  }
  return out;
}

/**
 * events: parsed JSONL events. requiredFiles: basenames that must have run.
 * patterns: RegExp[] marking which result files are required.
 */
export function evaluateJsonl(events, { requiredFiles = [], patterns = DEFAULT_REQUIRED.map((p) => new RegExp(p)) } = {}) {
  const isRequired = (base) => base && patterns.some((re) => re.test(base));
  const perFile = new Map();
  const problems = [];
  for (const e of events) {
    const base = basenameOf(e.file);
    if (!isRequired(base)) continue;
    const s = perFile.get(base) || { file: base, executed: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
    perFile.set(base, s);
    if (e.skip) { s.skipped += 1; problems.push(`${base}: "${e.name}" was SKIPPED${typeof e.skip === "string" ? " (" + e.skip + ")" : ""}`); continue; }
    if (e.todo) { s.todo += 1; problems.push(`${base}: "${e.name}" is TODO`); continue; }
    s.executed += 1;
    if (e.type === "test:fail") { s.failed += 1; problems.push(`${base}: "${e.name}" ${e.failure_type === "cancelledByParent" ? "was CANCELLED" : "FAILED"}`); } else s.passed += 1;
  }
  for (const f of requiredFiles.filter(isRequired)) {
    if (!perFile.has(f)) { perFile.set(f, { file: f, executed: 0, passed: 0, failed: 0, skipped: 0, todo: 0 }); problems.push(`${f}: required suite DID NOT RUN`); }
    else if (perFile.get(f).executed === 0) problems.push(`${f}: required suite executed no tests`);
  }
  return { files: [...perFile.values()].sort((a, b) => a.file.localeCompare(b.file)), problems: [...new Set(problems)], status: problems.length ? "FAIL" : "PASS" };
}

export function evaluateTap(results) {
  const problems = [];
  for (const r of results) {
    if (r.skip) problems.push(`"${r.name}" was SKIPPED (TAP input: no file attribution, every skip fails)`);
    else if (r.todo) problems.push(`"${r.name}" is TODO`);
    else if (r.failed) problems.push(`"${r.name}" FAILED`);
  }
  return { files: [], problems, status: problems.length ? "FAIL" : "PASS", note: "TAP input cannot prove that every required file ran; use the JSONL reporter" };
}

function main(argv) {
  const opts = { results: [], testsDirs: [], patterns: [], report: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--results") opts.results.push(argv[++i]);
    else if (argv[i] === "--tests-dir") opts.testsDirs.push(argv[++i]);
    else if (argv[i] === "--require") opts.patterns.push(argv[++i]);
    else if (argv[i] === "--report") opts.report = argv[++i];
    else throw new Error("unknown argument " + argv[i]);
  }
  if (opts.results.length === 0) throw new Error("--results <file> is required");
  const patterns = (opts.patterns.length ? opts.patterns : DEFAULT_REQUIRED).map((p) => new RegExp(p));
  const requiredFiles = opts.testsDirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith(".test.js") || f.endsWith(".test.mjs")));
  let result;
  const texts = opts.results.map((f) => { if (!fs.existsSync(f)) throw new Error("results file missing: " + f); return fs.readFileSync(f, "utf8"); });
  if (texts.every((t) => t.trim() === "" || t.trimStart().startsWith("{"))) {
    result = evaluateJsonl(texts.flatMap(parseJsonl), { requiredFiles, patterns });
  } else {
    result = evaluateTap(texts.flatMap(parseTap));
  }
  const report = { artifact: "product-admin-required-suites", generated_at: new Date().toISOString(), required_patterns: patterns.map(String), inputs: opts.results.map((f) => path.basename(f)), ...result };
  if (opts.report) fs.writeFileSync(opts.report, JSON.stringify(report, null, 2) + "\n");
  for (const f of result.files) process.stderr.write(`${f.file}: executed ${f.executed}, passed ${f.passed}, failed ${f.failed}, skipped ${f.skipped}, todo ${f.todo}\n`);
  for (const p of result.problems) process.stderr.write("REQUIRED: " + p + "\n");
  process.stderr.write(`required suites: ${result.status}\n`);
  return result.status === "PASS" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (err) { process.stderr.write("no-required-skips: " + err.message + "\n"); process.exitCode = 2; }
}
