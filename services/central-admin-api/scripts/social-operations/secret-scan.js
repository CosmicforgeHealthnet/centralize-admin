const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const EXCLUDED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "backups",
  "reports",
  "local-social-media",
  "local-media",
  "src/generated",
]);

const INCLUDED_PREFIXES = [
  ".github/",
  "docs/",
  "prisma/",
  "scripts/",
  "src/",
  "tests/",
];

const INCLUDED_FILES = new Set([
  ".env.example",
  ".gitignore",
  "Dockerfile",
  "package.json",
  "package-lock.json",
  "prisma.config.ts",
]);

const PLACEHOLDER_VALUES = new Set([
  "",
  "token",
  "secret",
  "password",
  "postgres",
  "user:password",
  "changeme",
  "change_me",
  "example",
  "example123",
  "insert_token",
  "your_token",
  "your_secret",
  "placeholder",
  "not_configured",
  "rotated-refresh-token",
  "synthetic-api-secret-with-safe-length",
  "synthetic-cloud",
  "synthetic-api-key",
]);

const RULES = [
  {
    id: "PRIVATE_KEY_BLOCK",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    id: "DATABASE_URL_WITH_PASSWORD",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^@\s]+)@/i,
    valueIndex: 1,
  },
  {
    id: "AUTHORIZATION_BEARER_LITERAL",
    pattern: /\bAuthorization\s*:\s*Bearer\s+([A-Za-z0-9._~+/=-]{24,})/i,
    valueIndex: 1,
  },
  {
    id: "HIGH_CONFIDENCE_SECRET_ASSIGNMENT",
    pattern:
      /\b(access[_-]?token|refresh[_-]?token|client[_-]?secret|consumer[_-]?secret|api[_-]?secret|webhook[_-]?secret|encryption[_-]?key|database_url|cloudinary[_-]?api[_-]?secret)\b\s*[:=]\s*["']?([^"'\s#]{20,})/i,
    valueIndex: 2,
  },
  {
    id: "CLOUDINARY_URL_WITH_SECRET",
    pattern: /\bcloudinary:\/\/[^:\s]+:([^@\s]+)@/i,
    valueIndex: 1,
  },
  {
    id: "COMMON_TOKEN_PREFIX",
    pattern: /\b(ghp|gho|ghu|ghs|github_pat|xox[baprs]|sk_live|sk_test)_[A-Za-z0-9_]{16,}/,
  },
];

function gitFiles(args) {
  const output = execFileSync("git", args, { cwd: ROOT, encoding: "buffer" });
  return output
    .toString("utf8")
    .split("\0")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isExcluded(file) {
  const normalized = file.replace(/\\/g, "/");
  if (normalized === ".env") return true;
  if (normalized.startsWith(".env.") && normalized !== ".env.example") return true;
  for (const segment of EXCLUDED_SEGMENTS) {
    if (normalized === segment || normalized.startsWith(`${segment}/`)) return true;
  }
  return false;
}

function isIncluded(file) {
  const normalized = file.replace(/\\/g, "/");
  if (INCLUDED_FILES.has(normalized)) return true;
  return INCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function looksPlaceholder(value) {
  const raw = String(value || "")
    .trim()
    .replace(/[;,]+$/g, "")
    .replace(/^["']|["']$/g, "");
  const text = raw
    .toLowerCase();
  if (raw.includes("process.env.")) return true;
  if (/[({)]/.test(raw)) return true;
  if (/^[A-Z0-9_]+$/.test(raw)) return true;
  if (/^[a-zA-Z_$][\w$.]+$/.test(raw)) return true;
  if (/^[a-zA-Z_$][\w$]*(\??\.[a-zA-Z_$][\w$]*)+$/.test(raw)) return true;
  if (PLACEHOLDER_VALUES.has(text)) return true;
  if (/^[<{].*[>}]$/.test(text)) return true;
  if (text.includes("example") || text.includes("placeholder")) return true;
  if (text.includes("localhost") && (text.includes("user:password") || text.includes("postgres:postgres"))) return true;
  return false;
}

function scanFile(file) {
  const absolute = path.join(ROOT, file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return [];
  if (/\.(dump|backup|bak)$/i.test(file)) {
    return [{ file, line: 1, rule: "DATABASE_DUMP_FILE_TRACKED" }];
  }
  const text = fs.readFileSync(absolute, "utf8");
  const findings = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const rule of RULES) {
      const match = rule.pattern.exec(line);
      if (!match) continue;
      const value = rule.valueIndex ? match[rule.valueIndex] : match[0];
      if (looksPlaceholder(value)) continue;
      findings.push({ file, line: index + 1, rule: rule.id });
    }
  });
  return findings;
}

function main() {
  const tracked = gitFiles(["ls-files", "-z"]);
  const untracked = gitFiles(["ls-files", "--others", "--exclude-standard", "-z"]);
  const files = [...new Set([...tracked, ...untracked])]
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => !isExcluded(file))
    .filter(isIncluded)
    .sort();

  const findings = files.flatMap(scanFile);
  console.log(`secret-scan files_scanned=${files.length} findings=${findings.length}`);
  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line}:${finding.rule}`);
  }
  if (findings.length > 0) process.exit(1);
}

main();
