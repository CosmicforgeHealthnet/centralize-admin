const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATION_DIR = path.join(ROOT, "prisma", "manual-migrations");

const RULES = [
  { id: "DROP_TABLE", pattern: /\bDROP\s+TABLE\b/i },
  { id: "DROP_COLUMN", pattern: /\bDROP\s+COLUMN\b/i },
  { id: "DROP_TYPE", pattern: /\bDROP\s+TYPE\b/i },
  { id: "TRUNCATE", pattern: /\bTRUNCATE\b/i },
  { id: "MIGRATE_RESET", pattern: /\bmigrate\s+reset\b/i },
  { id: "DATABASE_RESET", pattern: /\bdatabase\s+reset\b/i },
];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.isFile() && entry.name.endsWith(".sql") ? [fullPath] : [];
  });
}

function main() {
  const files = walk(MIGRATION_DIR).sort();
  const findings = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const relative = path.relative(ROOT, file).replace(/\\/g, "/");
    text.split(/\r?\n/).forEach((line, index) => {
      for (const rule of RULES) {
        if (rule.pattern.test(line)) {
          findings.push({ file: relative, line: index + 1, rule: rule.id });
        }
      }
    });
  }

  console.log(`migration-safety files_scanned=${files.length} findings=${findings.length}`);
  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line}:${finding.rule}`);
  }
  if (findings.length > 0) process.exit(1);
}

main();
