const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const BASELINE = require("./npm-audit-risk-baseline.json");

function npmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runAudit(args = []) {
  try {
    const commandArgs = ["audit", "--json", ...args];
    const output = process.platform === "win32"
      ? execSync([npmBin(), ...commandArgs].join(" "), {
          cwd: ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })
      : execFileSync(npmBin(), commandArgs, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
        });
    return JSON.parse(output);
  } catch (error) {
    if (!error.stdout) throw error;
    return JSON.parse(error.stdout.toString("utf8"));
  }
}

function advisoryIds(vulnerability) {
  const ids = new Set();
  for (const via of vulnerability.via || []) {
    if (typeof via === "string") continue;
    const match = String(via.url || "").match(/GHSA-[a-z0-9-]+/i);
    if (match) ids.add(match[0].toUpperCase());
    else if (via.source) ids.add(String(via.source));
  }
  return [...ids];
}

function flattenFindings(report) {
  const baselineByPackage = new Map();
  for (const entry of BASELINE.allowedAdvisories) {
    for (const packageName of entry.affectedPackages || []) {
      baselineByPackage.set(packageName, entry.id.toUpperCase());
    }
  }
  return Object.values(report.vulnerabilities || {}).flatMap((vulnerability) => {
    const ids = advisoryIds(vulnerability);
    if (!ids.length && baselineByPackage.has(vulnerability.name)) {
      ids.push(baselineByPackage.get(vulnerability.name));
    }
    return (ids.length ? ids : [vulnerability.name]).map((id) => ({
      id,
      packageName: vulnerability.name,
      severity: vulnerability.severity,
      isDirect: vulnerability.isDirect,
      fixAvailable: vulnerability.fixAvailable,
    }));
  });
}

function policyFailures(report) {
  const allowed = new Set(BASELINE.allowedAdvisories.map((entry) => entry.id.toUpperCase()));
  const findings = flattenFindings(report);
  const failures = [];
  for (const finding of findings) {
    const severity = String(finding.severity || "").toLowerCase();
    if (["critical", "high"].includes(severity)) {
      failures.push({ ...finding, reason: "HIGH_OR_CRITICAL" });
      continue;
    }
    if (severity === "moderate" && !allowed.has(String(finding.id).toUpperCase())) {
      failures.push({ ...finding, reason: "MODERATE_NOT_BASELINED" });
    }
  }
  return { findings, failures };
}

function packageJsonHasForceDowngrade() {
  const packageJson = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  return /audit\s+fix\s+--force/.test(packageJson) || /"prisma"\s*:\s*"\^?6\.19\.3"/.test(packageJson);
}

function main() {
  const productionOnly = process.argv.includes("--omit-dev");
  const report = runAudit(productionOnly ? ["--omit=dev"] : []);
  const { findings, failures } = policyFailures(report);
  if (packageJsonHasForceDowngrade()) {
    failures.push({ id: "PACKAGE_POLICY", packageName: "package.json", reason: "FORCE_FIX_OR_PRISMA_DOWNGRADE" });
  }
  const ids = [...new Set(findings.map((finding) => finding.id))].sort();
  const totals = report.metadata?.vulnerabilities || {};
  console.log(
    `npm-audit-policy mode=${productionOnly ? "production" : "full"} total=${totals.total || 0} critical=${totals.critical || 0} high=${totals.high || 0} moderate=${totals.moderate || 0} residual_ids=${ids.join(",") || "none"} failures=${failures.length}`,
  );
  for (const failure of failures) {
    console.log(`${failure.id}:${failure.packageName}:${failure.reason}`);
  }
  if (failures.length) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  runAudit,
  policyFailures,
  flattenFindings,
};
