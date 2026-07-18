const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function assert(condition, id) {
  if (!condition) throw new Error(id);
}

function workflowHasPushMain(source) {
  return /on:\s*(?:\r?\n[\s\S]*?)push:\s*(?:\r?\n[\s\S]*?)branches:\s*(?:\r?\n[\s\S]*?-\s*main\b)/.test(source);
}

function main() {
  const checks = [];
  const localAdapter = read("src/modules/marketing/social-operations/media/storage/local-media-storage.adapter.js");
  const cloudinaryAdapter = read("src/modules/marketing/social-operations/media/storage/cloudinary-media-storage.adapter.js");
  const configValidator = read("src/modules/marketing/social-operations/config/social-operations-env.validator.js");
  const productionWorkflow = read(".github/workflows/production.yml");
  const socialCi = read(".github/workflows/social-operations-ci.yml");
  const packageJson = read("package.json");
  const gitignore = read(".gitignore");

  assert(localAdapter.includes("SOCIAL_MEDIA_LOCAL_STORAGE_FORBIDDEN"), "LOCAL_STORAGE_PRODUCTION_REJECTION_MISSING");
  checks.push("local-media-production-rejection");

  assert(!/providerMetadata[\s\S]{0,300}(api_secret|apiSecret|signature|CLOUDINARY_API_SECRET)/.test(cloudinaryAdapter), "CLOUDINARY_SECRET_SERIALIZATION");
  checks.push("cloudinary-secret-serialization");

  assert(configValidator.includes("SocialOperationsConfigError") && !/console\.log\(.*process\.env/.test(configValidator), "CONFIG_VALUE_LOGGING");
  checks.push("config-errors-safe");

  assert(!workflowHasPushMain(productionWorkflow), "PRODUCTION_PUSH_MAIN_DEPLOY_TRIGGER");
  assert(/workflow_dispatch:/.test(productionWorkflow), "PRODUCTION_MANUAL_TRIGGER_MISSING");
  assert(/environment:\s*production/.test(productionWorkflow), "PRODUCTION_ENVIRONMENT_PROTECTION_MISSING");
  checks.push("production-release-governance");

  assert(/postgres:16/.test(socialCi), "CI_POSTGRES_SERVICE_MISSING");
  assert(/db:replay:ci/.test(socialCi), "CI_MIGRATION_REPLAY_MISSING");
  assert(/SOCIAL_WORKERS_ENABLED:\s*"false"/.test(socialCi), "CI_WORKERS_NOT_DISABLED");
  assert(/META_SOCIAL_ENABLED:\s*"false"/.test(socialCi), "CI_LIVE_PROVIDERS_NOT_DISABLED");
  checks.push("ci-database-and-network-guard");

  assert(!/audit\s+fix\s+--force/.test(packageJson), "AUDIT_FORCE_COMMAND_FOUND");
  assert(!/"prisma"\s*:\s*"\^?6\.19\.3"/.test(packageJson), "PRISMA_DOWNGRADE_FOUND");
  checks.push("dependency-policy");

  assert(/SOCIAL_PHASE_D_ENABLED[^"]*"false"/.test(socialCi), "PHASE_D_CI_DEFAULT_UNSAFE");
  assert(/SOCIAL_INBOX_ENABLED[^"]*"false"/.test(socialCi), "INBOX_CI_DEFAULT_UNSAFE");
  checks.push("phase-d-inbox-defaults");

  for (const pattern of [/\.env\.\*/, /\*\.dump/, /\*\.backup/, /reports\/social-operations\//, /local-social-media\//]) {
    assert(pattern.test(gitignore), `GITIGNORE_MISSING_${pattern}`);
  }
  checks.push("ignore-rules");

  console.log(`static-code-safety checks=${checks.length} status=ok`);
}

try {
  main();
} catch (error) {
  console.log(`static-code-safety status=failed reason=${error.message}`);
  process.exit(1);
}
