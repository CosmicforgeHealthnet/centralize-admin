const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATION_DIR = path.join(ROOT, "prisma", "manual-migrations");
const MANIFEST_PATH = path.join(MIGRATION_DIR, "manifest.json");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function verifyMigrationManifest() {
  const manifest = loadManifest();
  const listed = manifest.migrations.map((entry) => entry.file);
  const actual = fs
    .readdirSync(MIGRATION_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const failures = [];
  if (listed.join("\n") !== actual.join("\n")) {
    failures.push("MANIFEST_ORDER_OR_MEMBERSHIP_MISMATCH");
  }
  for (const entry of manifest.migrations) {
    const fullPath = path.join(MIGRATION_DIR, entry.file);
    if (!fs.existsSync(fullPath)) {
      failures.push(`MISSING:${entry.file}`);
      continue;
    }
    const actualHash = sha256(fullPath);
    if (actualHash !== entry.sha256) {
      failures.push(`CHECKSUM:${entry.file}`);
    }
  }
  return {
    manifest,
    count: manifest.migrations.length,
    failures,
  };
}

function main() {
  const result = verifyMigrationManifest();
  console.log(
    `migration-manifest migrations=${result.count} checksum_failures=${result.failures.length}`,
  );
  for (const failure of result.failures) console.log(failure);
  if (result.failures.length) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  MIGRATION_DIR,
  MANIFEST_PATH,
  loadManifest,
  verifyMigrationManifest,
};
