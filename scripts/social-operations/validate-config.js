require("dotenv").config();
const {
  safeSyntheticEnv,
  SocialOperationsConfigError,
  validateSocialOperationsEnvironment,
} = require("../../src/modules/marketing/social-operations/config/social-operations-env.validator");
const {
  MarketingIntelligenceSchedulerConfigError,
  validateIntelligenceSchedulerEnvironment,
} = require("../../src/modules/marketing/intelligence/scheduling/scheduler-config");

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
    const env = buildEnv(mode);
    const result = validateSocialOperationsEnvironment({
      env,
      mode,
      complianceReady: hasFlag("synthetic-compliance-ready"),
    });
    const scheduler = validateIntelligenceSchedulerEnvironment({ env });
    console.log(
      `config-validate mode=${result.mode} status=ok storage=${result.storageProvider} providers_enabled=${result.enabledProviders.length} phase2_master=${scheduler.phase2.enabled} recommendation_scheduler=${scheduler.recommendation.enabled} alert_health_scheduler=${scheduler.alertHealth.enabled} alert_performance_scheduler=${scheduler.alertPerformance.enabled}`,
    );
    if (expectFail) {
      console.error("config-validate expected failure but passed");
      process.exit(1);
    }
  } catch (error) {
    if (!(error instanceof SocialOperationsConfigError) && !(error instanceof MarketingIntelligenceSchedulerConfigError)) throw error;
    console.log(`config-validate mode=${mode} status=failed issues=${error.issues.length}`);
    for (const item of error.issues) {
      console.log(`${item.variable}:${item.reasonCode}`);
    }
    if (!expectFail) process.exit(1);
  }
}

main();
