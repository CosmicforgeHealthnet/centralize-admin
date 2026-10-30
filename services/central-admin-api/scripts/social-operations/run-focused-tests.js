const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

require("dotenv").config({ quiet: true });

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_ARTIFACT_DIR = path.join(ROOT, "artifacts");
const TAP_FILE = "social-operations-focused-tests.tap";
const SUMMARY_FILE = "social-operations-focused-summary.json";
const FILE_LIST_FILE = "social-operations-focused-files.txt";

const FAILURE_PATTERNS = [
  /\bnot ok\b/i,
  /\bfailureType\b/i,
  /\berror\b/i,
  /\bcode\b/i,
  /\bstack\b/i,
  /\bcancelled\b/i,
  /\bunhandled/i,
  /\buncaught/i,
];

function stableSort(values) {
  return values.sort((left, right) => left.localeCompare(right, "en"));
}

function list(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  return stableSort(fs.readdirSync(dir).filter(predicate)).map((name) => path.resolve(dir, name));
}

function relativeTestPath(file, root = ROOT) {
  return path.relative(root, file).replace(/\\/g, "/");
}

function uniqueFiles(files) {
  const seen = new Set();
  const unique = [];
  for (const file of files) {
    const resolved = path.resolve(file);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!fs.existsSync(resolved) || seen.has(key)) continue;
    seen.add(key);
    unique.push(resolved);
  }
  return unique;
}

function discoverFocusedTestFiles({ root = ROOT } = {}) {
  return uniqueFiles([
    path.join(root, "tests", "marketing-legacy-social-freeze.test.js"),
    ...list(path.join(root, "src", "modules", "marketing", "social-operations", "__tests__"), (name) =>
      name.endsWith(".test.js"),
    ),
    ...list(path.join(root, "tests"), (name) => name.startsWith("social-operations-section") && name.endsWith(".test.js")),
    ...list(path.join(root, "tests"), (name) => name.startsWith("task-assignee") && name.endsWith(".test.js")),
  ]);
}

function buildSafeDatabaseTarget(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) return { configured: false };
  try {
    const parsed = new URL(databaseUrl);
    return {
      configured: true,
      protocol: parsed.protocol.replace(/:$/, ""),
      host: parsed.hostname,
      port: parsed.port || null,
      database: parsed.pathname.replace(/^\//, ""),
    };
  } catch {
    return { configured: true, parseable: false };
  }
}

function sanitizeTestOutput(text) {
  return String(text)
    .replace(/postgres(?:ql)?:\/\/([^:\s/@]+):([^@\s]+)@/gi, "postgresql://$1:<redacted>@")
    .replace(/\b(DATABASE_URL|PASSWORD|TOKEN|SECRET|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN)(\s*[:=]\s*)[^\s'",}]+/gi, "$1$2<redacted>")
    .replace(/\b(api_secret|apiSecret|client_secret|clientSecret|refresh_token|access_token)(["']?\s*[:=]\s*["']?)[^"',}\s]+/gi, "$1$2<redacted>");
}

function artifactPaths(artifactDir = DEFAULT_ARTIFACT_DIR) {
  return {
    dir: artifactDir,
    tap: path.join(artifactDir, TAP_FILE),
    summary: path.join(artifactDir, SUMMARY_FILE),
    fileList: path.join(artifactDir, FILE_LIST_FILE),
  };
}

function buildSummary({ files, exitCode, signal, startedAt, finishedAt, output }) {
  const lines = output.split(/\r?\n/);
  const failLine = [...lines].reverse().find((line) => /^# fail \d+/.test(line));
  const tapFailCount = failLine ? Number(failLine.replace(/^# fail /, "")) : 0;
  const effectiveExitCode = exitCode || (tapFailCount > 0 ? 1 : 0);
  return {
    exitCode: effectiveExitCode,
    childExitCode: exitCode,
    signal,
    startedAt,
    finishedAt,
    durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    databaseTarget: buildSafeDatabaseTarget(),
    networkGuardEnabled: String(process.env.TEST_NETWORK_GUARD_ENABLED || "").toLowerCase() === "true",
    fileCount: files.length,
    files: files.map((file) => relativeTestPath(file)),
    notOkLines: lines.filter((line) => /\bnot ok\b/i.test(line)),
    cancelledLines: lines.filter((line) => /\bcancelled\b/i.test(line)),
    tapFailCount,
    diagnosticLineCount: lines.filter((line) => FAILURE_PATTERNS.some((pattern) => pattern.test(line))).length,
  };
}

function printFailureDiagnostics(output) {
  const diagnostics = output
    .split(/\r?\n/)
    .filter((line) => FAILURE_PATTERNS.some((pattern) => pattern.test(line)));
  if (!diagnostics.length) return;
  console.error("focused-social-operations-tests failure diagnostics begin");
  for (const line of diagnostics) console.error(line);
  console.error("focused-social-operations-tests failure diagnostics end");
}

function writeDiscoveryArtifacts(paths, files) {
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.fileList, `${files.map((file) => relativeTestPath(file)).join("\n")}\n`);
}

function nodeTestArgs(files) {
  return [
    "--require",
    path.join(ROOT, "tests", "helpers", "network-guard.js"),
    "--test-reporter=tap",
    "--test",
    ...files,
  ];
}

async function runFocusedTests({ artifactDir = process.env.SOCIAL_FOCUSED_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIR } = {}) {
  const paths = artifactPaths(path.resolve(artifactDir));
  const files = discoverFocusedTestFiles();
  writeDiscoveryArtifacts(paths, files);
  const startedAt = new Date().toISOString();
  console.log(`focused-social-operations-tests files=${files.length}`);
  console.log(`focused-social-operations-tests artifact=${relativeTestPath(paths.tap)}`);
  console.log(`focused-social-operations-tests file_list=${relativeTestPath(paths.fileList)}`);

  const child = spawn(process.execPath, nodeTestArgs(files), {
    cwd: ROOT,
    env: {
      ...process.env,
      TEST_NETWORK_GUARD_ENABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const tapStream = fs.createWriteStream(paths.tap, { flags: "w" });
  let output = "";

  const tee = (stream, writer) => {
    stream.on("data", (chunk) => {
      const sanitized = sanitizeTestOutput(chunk.toString());
      output += sanitized;
      tapStream.write(sanitized);
      writer.write(sanitized);
    });
  };
  tee(child.stdout, process.stdout);
  tee(child.stderr, process.stderr);

  const result = await new Promise((resolve) => {
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
    child.on("error", (error) => {
      const sanitized = sanitizeTestOutput(`${error.stack || error.message}\n`);
      output += sanitized;
      tapStream.write(sanitized);
      process.stderr.write(sanitized);
      resolve({ exitCode: 1, signal: null });
    });
  });

  await new Promise((resolve) => tapStream.end(resolve));
  const finishedAt = new Date().toISOString();
  const summary = buildSummary({
    files,
    exitCode: result.exitCode ?? 1,
    signal: result.signal,
    startedAt,
    finishedAt,
    output,
  });
  fs.writeFileSync(paths.summary, `${JSON.stringify(summary, null, 2)}\n`);

  if (summary.exitCode !== 0) printFailureDiagnostics(output);
  return summary.exitCode;
}

async function main() {
  const files = discoverFocusedTestFiles();
  if (process.argv.includes("--list")) {
    for (const file of files) console.log(relativeTestPath(file));
    return;
  }
  if (process.argv.includes("--list-json")) {
    console.log(JSON.stringify(files.map((file) => relativeTestPath(file)), null, 2));
    return;
  }
  process.exitCode = await runFocusedTests();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(sanitizeTestOutput(error.stack || error.message));
    process.exitCode = 1;
  });
}

module.exports = {
  TAP_FILE,
  SUMMARY_FILE,
  FILE_LIST_FILE,
  artifactPaths,
  buildSafeDatabaseTarget,
  discoverFocusedTestFiles,
  nodeTestArgs,
  relativeTestPath,
  runFocusedTests,
  sanitizeTestOutput,
};
