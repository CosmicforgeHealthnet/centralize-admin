const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const GUARD_PATH_PATTERN = /--require\s+\.\/tests\/helpers\/network-guard\.js/;
const PROHIBITED_SHELL_NETWORK = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/i;

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function assert(condition, id) {
  if (!condition) throw new Error(id);
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, "/");
}

function scanForProhibitedShellNetwork() {
  const roots = ["tests", "scripts"].map((dir) => path.join(ROOT, dir));
  const findings = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      if (relative(file) === "scripts/security/check-test-network-safety.js") continue;
      if (!/\.(js|mjs|cjs|ts|json|yml|yaml|ps1|sh|cmd|bat)$/i.test(file)) continue;
      const source = fs.readFileSync(file, "utf8");
      if (PROHIBITED_SHELL_NETWORK.test(source)) findings.push(relative(file));
    }
  }
  return findings;
}

function main() {
  const packageJson = JSON.parse(read("package.json"));
  const scripts = packageJson.scripts || {};
  const focusedRunner = read("scripts/social-operations/run-focused-tests.js");
  const workflow = read(".github/workflows/social-operations-ci.yml");
  const guard = read("tests/helpers/network-guard.js");

  assert(GUARD_PATH_PATTERN.test(scripts.test || ""), "NPM_TEST_GUARD_MISSING");
  assert(GUARD_PATH_PATTERN.test(scripts["test:network-guard"] || ""), "NETWORK_GUARD_TEST_SCRIPT_MISSING");
  assert(/tests[\\/"]\s*,\s*["']helpers[\\/"]\s*,\s*["']network-guard\.js/.test(focusedRunner), "FOCUSED_RUNNER_GUARD_MISSING");
  assert(/TEST_NETWORK_GUARD_ENABLED:\s*"true"/.test(workflow), "CI_GUARD_ENV_MISSING");
  assert(/npm run test:network-guard/.test(workflow), "CI_RUNTIME_GUARD_TEST_MISSING");
  assert(/npm run test:social-operations/.test(workflow), "CI_FOCUSED_TEST_MISSING");
  assert(/npm test/.test(workflow), "CI_FULL_TEST_MISSING");
  assert(/META_SOCIAL_ENABLED:\s*"false"/.test(workflow), "CI_META_PROVIDER_ENABLED");
  assert(/TIKTOK_SOCIAL_ENABLED:\s*"false"/.test(workflow), "CI_TIKTOK_PROVIDER_ENABLED");
  assert(/X_SOCIAL_ENABLED:\s*"false"/.test(workflow), "CI_X_PROVIDER_ENABLED");
  assert(/LINKEDIN_SOCIAL_ENABLED:\s*"false"/.test(workflow), "CI_LINKEDIN_PROVIDER_ENABLED");
  assert(/SOCIAL_WORKERS_ENABLED:\s*"false"/.test(workflow), "CI_WORKERS_ENABLED");
  assert(/SOCIAL_PHASE_D_ENABLED:\s*"false"/.test(workflow), "CI_PHASE_D_ENABLED");
  assert(/SOCIAL_INBOX_ENABLED:\s*"false"/.test(workflow), "CI_INBOX_ENABLED");
  assert(/UNEXPECTED_EXTERNAL_NETWORK_REQUEST/.test(guard), "GUARD_ERROR_CODE_MISSING");
  assert(/globalThis\.fetch/.test(guard), "FETCH_PATCH_MISSING");
  assert(/patchHttpModule\(state,\s*http/.test(guard) && /patchHttpModule\(state,\s*https/.test(guard), "HTTP_PATCH_MISSING");
  assert(/net\.connect/.test(guard) && /tls\.connect/.test(guard), "SOCKET_PATCH_MISSING");
  assert(/dns\.lookup/.test(guard), "DNS_PATCH_MISSING");

  const shellFindings = scanForProhibitedShellNetwork();
  assert(shellFindings.length === 0, `PROHIBITED_NETWORK_SHELL_COMMAND:${shellFindings.join(",")}`);

  console.log("test-network-safety checks=18 prohibited_shell_network=0 status=ok");
}

try {
  main();
} catch (error) {
  console.log(`test-network-safety status=failed reason=${error.message}`);
  process.exit(1);
}
