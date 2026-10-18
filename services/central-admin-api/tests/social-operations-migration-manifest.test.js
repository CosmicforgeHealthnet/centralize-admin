const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  MIGRATION_DIR,
  MANIFEST_PATH,
  normalizeManifestFilename,
  normalizeMigrationContent,
  calculateMigrationChecksum,
  writeManifest,
  verifyManifest,
  loadMigrationManifest,
} = require("../scripts/social-operations/migration-manifest");

const PREVIOUSLY_FAILING = [
  "20260705_add_marketing_campaigns_content.sql",
  "20260705_add_marketing_email_templates_social.sql",
  "20260705_add_marketing_promotions_banners_analytics.sql",
  "20260716_add_marketing_attributions_phase1.sql",
];

function sha256(text) {
  return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "migration-manifest-"));
}

function writeSql(dir, file, content) {
  fs.writeFileSync(path.join(dir, file), content);
}

function writeManifestFile(dir, manifest) {
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

function manifest(entries) {
  return {
    version: 1,
    migrations: entries.map((entry, index) => ({
      order: index + 1,
      file: entry.file,
      sha256: entry.sha256,
    })),
  };
}

function validManifestFor(dir, files) {
  return manifest(
    files.map((file) => ({
      file,
      sha256: calculateMigrationChecksum(path.join(dir, file)),
    })),
  );
}

test("LF and CRLF versions of identical SQL produce the same checksum", () => {
  const dir = tempDir();
  try {
    writeSql(dir, "a.sql", "CREATE TABLE demo (\n  id TEXT\n);\n");
    writeSql(dir, "b.sql", "CREATE TABLE demo (\r\n  id TEXT\r\n);\r\n");
    assert.equal(
      calculateMigrationChecksum(path.join(dir, "a.sql")),
      calculateMigrationChecksum(path.join(dir, "b.sql")),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a UTF-8 BOM does not change the checksum", () => {
  assert.equal(
    sha256(normalizeMigrationContent(Buffer.from("SELECT 1;\n", "utf8"))),
    sha256(normalizeMigrationContent(Buffer.from("\ufeffSELECT 1;\n", "utf8"))),
  );
});

test("meaningful SQL content, values and identifiers change the checksum", () => {
  const base = sha256(normalizeMigrationContent("CREATE TABLE demo (id TEXT);\nINSERT INTO demo VALUES ('a');\n"));
  assert.notEqual(base, sha256(normalizeMigrationContent("CREATE TABLE demo (id TEXT);\nINSERT INTO demo VALUES ('b');\n")));
  assert.notEqual(base, sha256(normalizeMigrationContent("CREATE TABLE demo_other (id TEXT);\nINSERT INTO demo VALUES ('a');\n")));
  assert.notEqual(base, sha256(normalizeMigrationContent("CREATE TABLE demo (id TEXT);\n\nINSERT INTO demo VALUES ('a');\n")));
});

test("final newline behavior is deterministic", () => {
  assert.equal(
    sha256(normalizeMigrationContent("SELECT 1;")),
    sha256(normalizeMigrationContent("SELECT 1;\n\n")),
  );
});

test("Windows and POSIX path separators normalize to the same manifest filename", () => {
  assert.equal(
    normalizeManifestFilename("prisma\\manual-migrations\\20260701_example.sql"),
    normalizeManifestFilename("prisma/manual-migrations/20260701_example.sql"),
  );
});

test("file ordering is deterministic", () => {
  const dir = tempDir();
  try {
    writeSql(dir, "20260702_b.sql", "SELECT 2;\n");
    writeSql(dir, "20260701_a.sql", "SELECT 1;\n");
    const generated = writeManifest({ migrationDir: dir, manifestPath: path.join(dir, "manifest.json") });
    assert.deepEqual(
      generated.migrations.map((entry) => entry.file),
      ["20260701_a.sql", "20260702_b.sql"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate migration names fail verification", () => {
  const dir = tempDir();
  try {
    writeSql(dir, "20260701_a.sql", "SELECT 1;\n");
    const hash = calculateMigrationChecksum(path.join(dir, "20260701_a.sql"));
    const manifestPath = writeManifestFile(
      dir,
      manifest([
        { file: "20260701_a.sql", sha256: hash },
        { file: "20260701_a.sql", sha256: hash },
      ]),
    );
    assert.ok(verifyManifest({ migrationDir: dir, manifestPath }).failures.some((failure) => failure.startsWith("DUPLICATE:")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing migration files fail verification", () => {
  const dir = tempDir();
  try {
    writeSql(dir, "20260701_a.sql", "SELECT 1;\n");
    const manifestPath = writeManifestFile(
      dir,
      manifest([{ file: "20260702_missing.sql", sha256: "0".repeat(64) }]),
    );
    assert.ok(verifyManifest({ migrationDir: dir, manifestPath }).failures.includes("MISSING_FILE:20260702_missing.sql"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing manifest entries fail verification", () => {
  const dir = tempDir();
  try {
    writeSql(dir, "20260701_a.sql", "SELECT 1;\n");
    writeSql(dir, "20260702_b.sql", "SELECT 2;\n");
    const manifestPath = writeManifestFile(dir, validManifestFor(dir, ["20260701_a.sql"]));
    assert.ok(verifyManifest({ migrationDir: dir, manifestPath }).failures.includes("MISSING_ENTRY:20260702_b.sql"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extra manifest entries fail verification", () => {
  const dir = tempDir();
  try {
    writeSql(dir, "20260701_a.sql", "SELECT 1;\n");
    const valid = validManifestFor(dir, ["20260701_a.sql"]);
    valid.migrations.push({ order: 2, file: "20260703_extra.sql", sha256: "0".repeat(64) });
    const manifestPath = writeManifestFile(dir, valid);
    assert.ok(verifyManifest({ migrationDir: dir, manifestPath }).failures.includes("EXTRA_ENTRY:20260703_extra.sql"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid checksum format fails verification", () => {
  const dir = tempDir();
  try {
    writeSql(dir, "20260701_a.sql", "SELECT 1;\n");
    const manifestPath = writeManifestFile(
      dir,
      manifest([{ file: "20260701_a.sql", sha256: "not-a-checksum" }]),
    );
    assert.ok(verifyManifest({ migrationDir: dir, manifestPath }).failures.includes("INVALID_CHECKSUM:20260701_a.sql"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verification does not modify manifest.json", () => {
  const dir = tempDir();
  try {
    writeSql(dir, "20260701_a.sql", "SELECT 1;\n");
    const manifestPath = writeManifestFile(dir, validManifestFor(dir, ["20260701_a.sql"]));
    const before = fs.readFileSync(manifestPath, "utf8");
    const result = verifyManifest({ migrationDir: dir, manifestPath });
    const after = fs.readFileSync(manifestPath, "utf8");
    assert.equal(result.failures.length, 0);
    assert.equal(after, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("generation is idempotent", () => {
  const dir = tempDir();
  try {
    writeSql(dir, "20260701_a.sql", "SELECT 1;\n");
    const manifestPath = path.join(dir, "manifest.json");
    writeManifest({ migrationDir: dir, manifestPath });
    const first = fs.readFileSync(manifestPath, "utf8");
    writeManifest({ migrationDir: dir, manifestPath });
    const second = fs.readFileSync(manifestPath, "utf8");
    assert.equal(second, first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the real repository manifest verifies successfully", () => {
  const result = verifyManifest();
  assert.equal(result.failures.length, 0);
  assert.equal(result.count, loadMigrationManifest().migrations.length);
});

test("the four previously failing migrations verify with canonical checksums", () => {
  const manifestByFile = new Map(loadMigrationManifest().migrations.map((entry) => [entry.file, entry.sha256]));
  for (const file of PREVIOUSLY_FAILING) {
    assert.equal(
      calculateMigrationChecksum(path.join(MIGRATION_DIR, file)),
      manifestByFile.get(file),
      file,
    );
  }
});
