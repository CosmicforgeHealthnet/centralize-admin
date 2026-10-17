const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

require("dotenv").config({ quiet: true });

const ROOT = path.resolve(__dirname, "..", "..");
const EXPECTED_BRANCH = "fix/marketing-admin-db-target";
const EXPECTED_ORIGIN = "https://github.com/CosmicforgeHealthnet/ADMIN-Backend.git";
const EXPECTED_DATABASE = "cosmicforge_admin";

const CI_FLAGS = {
  NODE_ENV: "test",
  SOCIAL_WORKERS_ENABLED: "false",
  SOCIAL_PUBLISHING_WORKER_ENABLED: "false",
  SOCIAL_ACTION_WORKER_ENABLED: "false",
  SOCIAL_REDACTION_WORKER_ENABLED: "false",
  SOCIAL_INBOX_ENABLED: "false",
  SOCIAL_PHASE_D_ENABLED: "false",
  TEST_NETWORK_GUARD_ENABLED: "true",
  MARKETING_INTELLIGENCE_SYNC_ENABLED: "false",
  MARKETING_INTELLIGENCE_BOOTSTRAP_CONNECTIONS: "false",
  META_SOCIAL_ENABLED: "false",
  TIKTOK_SOCIAL_ENABLED: "false",
  X_SOCIAL_ENABLED: "false",
  LINKEDIN_SOCIAL_ENABLED: "false",
  SOCIAL_MEDIA_STORAGE_PROVIDER: "local",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  GOOGLE_CALLBACK_URL: "",
};

function commandName(command) {
  return command;
}

function commandOptions(command) {
  return {
    shell: process.platform === "win32" && (command === "npm" || command === "npx"),
  };
}

function parityEnv() {
  return {
    ...process.env,
    ...CI_FLAGS,
    DATABASE_URL:
      process.env.DATABASE_URL ||
      `postgresql://postgres:postgres@localhost:5432/${EXPECTED_DATABASE}`,
  };
}

function runCapture(command, args, { env = parityEnv() } = {}) {
  return spawnSync(commandName(command), args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    windowsHide: true,
    ...commandOptions(command),
  });
}

function runStep(name, command, args, options = {}) {
  console.log(`ci-parity step=${name} status=running`);
  const result = spawnSync(commandName(command), args, {
    cwd: ROOT,
    env: options.env || parityEnv(),
    stdio: options.stdio || "inherit",
    encoding: options.encoding,
    windowsHide: true,
    ...commandOptions(command),
  });
  if ((result.status ?? 1) !== 0) {
    console.error(`ci-parity step=${name} status=failed exit=${result.status ?? 1}`);
    process.exit(result.status ?? 1);
  }
  console.log(`ci-parity step=${name} status=passed`);
  return result;
}

function assertCapture(name, command, args, expected) {
  const result = runCapture(command, args);
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "");
    throw new Error(`${name} failed`);
  }
  const value = result.stdout.trim();
  if (value !== expected) {
    throw new Error(`${name} expected ${expected} but received ${value}`);
  }
  console.log(`ci-parity config=${name} value=${value}`);
}

function validateRepository() {
  assertCapture("root", "git", ["rev-parse", "--show-toplevel"], ROOT.replace(/\\/g, "/"));
  assertCapture("branch", "git", ["branch", "--show-current"], EXPECTED_BRANCH);
  assertCapture("origin", "git", ["remote", "get-url", "origin"], EXPECTED_ORIGIN);
}

function confirmDatabase() {
  const script = `
    const { Client } = require("pg");
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    client.connect()
      .then(() => client.query("select current_database() as database, current_schema() as schema"))
      .then((result) => {
        const row = result.rows[0];
        console.log("ci-parity database=" + row.database + " schema=" + row.schema);
        if (row.database !== "${EXPECTED_DATABASE}") process.exitCode = 1;
      })
      .finally(() => client.end());
  `;
  runStep("confirm-database", "node", ["-e", script]);
}

function generateAndValidateSbom() {
  console.log("ci-parity step=sbom status=running");
  const result = runCapture("npm", ["run", "security:sbom"]);
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "");
    console.error(`ci-parity step=sbom status=failed exit=${result.status ?? 1}`);
    process.exit(result.status ?? 1);
  }
  const jsonStart = result.stdout.indexOf("{");
  const parsed = JSON.parse(result.stdout.slice(jsonStart));
  const artifactDir = path.join(ROOT, "artifacts");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "social-operations-sbom.json"), JSON.stringify(parsed, null, 2));
  console.log(
    `ci-parity step=sbom status=passed bomFormat=${parsed.bomFormat} specVersion=${parsed.specVersion} components=${parsed.components?.length || 0}`,
  );
}

function main() {
  validateRepository();
  confirmDatabase();
  runStep("config-development", "npm", ["run", "config:validate"]);
  runStep("config-staging", "npm", ["run", "config:validate:staging"]);
  runStep("config-production", "npm", ["run", "config:validate:production"]);
  runStep("migration-manifest", "npm", ["run", "db:manifest:verify"]);
  runStep("admin-target", "npm", ["run", "db:admin:guard"]);
  runStep("prisma-format", "npx", ["prisma", "format", "--schema", "prisma/schema.prisma"]);
  runStep("prisma-format-diff", "git", ["diff", "--exit-code", "--", "prisma/schema.prisma"]);
  runStep("prisma-validate", "npx", ["prisma", "validate", "--schema", "prisma/schema.prisma"]);
  runStep("prisma-generate", "npx", ["prisma", "generate", "--schema", "prisma/schema.prisma"]);
  runStep("prisma-db-push", "npx", ["prisma", "db", "push", "--schema", "prisma/schema.prisma"]);
  runStep("admin-prepare", "npm", ["run", "db:admin:prepare"]);
  runStep("schema-assert", "npm", ["run", "db:schema:assert"]);
  runStep("migration-safety", "npm", ["run", "migrations:safety"]);
  runStep("secret-scan", "npm", ["run", "security:secret-scan"]);
  runStep("dependency-policy", "npm", ["run", "security:audit-policy"]);
  runStep("dependency-policy-production", "npm", ["run", "security:audit-policy:production"]);
  runStep("static-social", "npm", ["run", "security:static-social"]);
  runStep("network-guard-static", "npm", ["run", "security:network-guard-static"]);
  generateAndValidateSbom();
  runStep("network-guard-runtime", "npm", ["run", "test:network-guard"]);
  runStep("focused-social-operations", "npm", ["run", "test:social-operations"]);
  runStep("full-test-suite", "npm", ["test"]);
  console.log("ci-parity status=passed");
}

main();
