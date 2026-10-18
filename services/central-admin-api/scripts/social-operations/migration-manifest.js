const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATION_DIR = path.join(ROOT, "prisma", "manual-migrations");
const MANIFEST_PATH = path.join(MIGRATION_DIR, "manifest.json");
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

function bytewiseCompare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function normalizeManifestFilename(file) {
  return String(file || "").replace(/\\/g, "/").split("/").pop();
}

function normalizeMigrationContent(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  let text = decoder.decode(buffer);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return `${text.replace(/\n*$/g, "")}\n`;
}

function calculateMigrationChecksum(filePath) {
  const normalized = normalizeMigrationContent(fs.readFileSync(filePath));
  return crypto.createHash("sha256").update(Buffer.from(normalized, "utf8")).digest("hex");
}

function loadMigrationManifest({ manifestPath = MANIFEST_PATH } = {}) {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function discoverMigrationFiles({ migrationDir = MIGRATION_DIR } = {}) {
  const files = fs
    .readdirSync(migrationDir)
    .filter((file) => file.endsWith(".sql"))
    .map(normalizeManifestFilename)
    .sort(bytewiseCompare);
  const seen = new Set();
  const duplicates = [];
  for (const file of files) {
    if (seen.has(file)) duplicates.push(file);
    seen.add(file);
  }
  return { files, duplicates };
}

function createManifestObject({ migrationDir = MIGRATION_DIR } = {}) {
  const { files, duplicates } = discoverMigrationFiles({ migrationDir });
  if (duplicates.length) {
    const error = new Error("Duplicate migration filenames found");
    error.failures = duplicates.map((file) => `DUPLICATE:${file}`);
    throw error;
  }
  return {
    version: 1,
    description:
      "Manual migration order and canonical SHA-256 checksums for ADMIN-Backend additive SQL migrations.",
    checksumCanonicalization: "utf8-no-bom-lf-one-final-newline",
    migrations: files.map((file, index) => ({
      order: index + 1,
      file,
      sha256: calculateMigrationChecksum(path.join(migrationDir, file)),
    })),
  };
}

function writeManifest({ manifestPath = MANIFEST_PATH, migrationDir = MIGRATION_DIR } = {}) {
  const manifest = createManifestObject({ migrationDir });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function verifyManifest({ manifestPath = MANIFEST_PATH, migrationDir = MIGRATION_DIR } = {}) {
  const manifest = loadMigrationManifest({ manifestPath });
  const failures = [];
  const entries = Array.isArray(manifest.migrations) ? manifest.migrations : [];
  const { files: actualFiles, duplicates: discoveredDuplicates } = discoverMigrationFiles({
    migrationDir,
  });
  const actualSet = new Set(actualFiles);
  const seen = new Set();

  for (const duplicate of discoveredDuplicates) failures.push(`DUPLICATE:${duplicate}`);

  for (const entry of entries) {
    const file = normalizeManifestFilename(entry.file);
    if (!file || file !== entry.file) failures.push(`MALFORMED_FILE:${entry.file || "unknown"}`);
    if (seen.has(file)) failures.push(`DUPLICATE:${file}`);
    seen.add(file);
    if (!CHECKSUM_PATTERN.test(String(entry.sha256 || ""))) {
      failures.push(`INVALID_CHECKSUM:${file || "unknown"}`);
    }
    const expectedOrder = actualFiles.indexOf(file) + 1;
    if (expectedOrder > 0 && entry.order !== expectedOrder) failures.push(`ORDER:${file}`);
    if (!actualSet.has(file)) {
      failures.push(`MISSING_FILE:${file || "unknown"}`);
      continue;
    }
    const fullPath = path.join(migrationDir, file);
    if (!fs.existsSync(fullPath)) {
      failures.push(`MISSING_FILE:${file}`);
      continue;
    }
    const actualHash = calculateMigrationChecksum(fullPath);
    if (actualHash !== entry.sha256) failures.push(`CHECKSUM:${file}`);
  }

  for (const file of actualFiles) {
    if (!seen.has(file)) failures.push(`MISSING_ENTRY:${file}`);
  }
  for (const file of seen) {
    if (!actualSet.has(file)) failures.push(`EXTRA_ENTRY:${file}`);
  }

  const counts = {
    checksum: failures.filter((failure) => failure.startsWith("CHECKSUM:")).length,
    missing: failures.filter((failure) => failure.startsWith("MISSING_ENTRY:")).length,
    extra: failures.filter((failure) => failure.startsWith("EXTRA_ENTRY:")).length,
    duplicate: failures.filter((failure) => failure.startsWith("DUPLICATE:")).length,
  };

  return {
    manifest,
    count: entries.length,
    failures,
    counts,
  };
}

function verifyMigrationManifest(options = {}) {
  return verifyManifest(options);
}

function main() {
  const shouldGenerate = process.argv.includes("--generate");
  if (shouldGenerate) {
    const manifest = writeManifest();
    console.log(`migration-manifest-generate migrations=${manifest.migrations.length} status=ok`);
    return;
  }

  const result = verifyManifest();
  console.log(
    `migration-manifest migrations=${result.count} checksum_failures=${result.counts.checksum} missing_entries=${result.counts.missing} extra_entries=${result.counts.extra} duplicate_entries=${result.counts.duplicate}`,
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
  normalizeManifestFilename,
  normalizeMigrationContent,
  calculateMigrationChecksum,
  loadMigrationManifest,
  discoverMigrationFiles,
  createManifestObject,
  generateManifest: createManifestObject,
  writeManifest,
  verifyManifest,
  verifyMigrationManifest,
};
