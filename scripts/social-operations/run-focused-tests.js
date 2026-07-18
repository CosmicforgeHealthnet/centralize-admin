const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

function list(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(predicate)
    .sort()
    .map((name) => path.join(dir, name));
}

const files = [
  path.join(ROOT, "tests", "marketing-legacy-social-freeze.test.js"),
  ...list(path.join(ROOT, "src", "modules", "marketing", "social-operations", "__tests__"), (name) =>
    name.endsWith(".test.js"),
  ),
  ...list(path.join(ROOT, "tests"), (name) => name.startsWith("social-operations-section") && name.endsWith(".test.js")),
  ...list(path.join(ROOT, "tests"), (name) => name.startsWith("task-assignee") && name.endsWith(".test.js")),
].filter((file, index, all) => fs.existsSync(file) && all.indexOf(file) === index);

console.log(`focused-social-operations-tests files=${files.length}`);
const networkGuard = path.join(ROOT, "tests", "helpers", "network-guard.js");
const result = spawnSync(process.execPath, ["--require", networkGuard, "--test", ...files], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    TEST_NETWORK_GUARD_ENABLED: "true",
  },
});

process.exit(result.status ?? 1);
