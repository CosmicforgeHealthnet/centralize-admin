require("dotenv").config();
const {
  safeSyntheticEnv,
  SocialOperationsConfigError,
  validateSocialOperationsEnvironment,
} = require("../../src/modules/marketing/social-operations/config/social-operations-env.validator");

function argValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function buildEnv(mode) {
  if (!hasFlag("synthetic")) return process.env;
  return {
    ...process.env,
    ...safeSyntheticEnv(mode || process.env.APP_ENV || process.env.NODE_ENV || "development"),
  };
}

function main() {
  const mode = argValue("mode") || process.env.APP_ENV || process.env.NODE_ENV || "development";
  const expectFail = hasFlag("expect-fail");
  try {
    const result = validateSocialOperationsEnvironment({
      env: buildEnv(mode),
      mode,
      complianceReady: hasFlag("synthetic-compliance-ready"),
    });
    console.log(
      `config-validate mode=${result.mode} status=ok storage=${result.storageProvider} providers_enabled=${result.enabledProviders.length}`,
    );
    if (expectFail) {
      console.error("config-validate expected failure but passed");
      process.exit(1);
    }
  } catch (error) {
    if (!(error instanceof SocialOperationsConfigError)) throw error;
    console.log(`config-validate mode=${mode} status=failed issues=${error.issues.length}`);
    for (const item of error.issues) {
      console.log(`${item.variable}:${item.reasonCode}`);
    }
    if (!expectFail) process.exit(1);
  }
}

main();
