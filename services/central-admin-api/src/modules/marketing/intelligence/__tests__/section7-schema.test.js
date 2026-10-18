const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../../../..");
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const migrationName = "20260722_marketing_intelligence_phase2_section7_schema.sql";
const migration = fs.readFileSync(
  path.join(root, "prisma/manual-migrations", migrationName),
  "utf8",
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "prisma/manual-migrations/manifest.json"), "utf8"),
);

function model(name) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `missing Prisma model ${name}`);
  return match[1];
}

test("Section 7 reuses the five-value marketing platform enum and extends run types", () => {
  const platform = schema.match(/enum marketing_ad_platform_enum \{([\s\S]*?)\n\}/)?.[1] || "";
  for (const value of ["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"]) {
    assert.match(platform, new RegExp(`\\b${value}\\b`));
  }
  assert.equal((schema.match(/enum marketing_ad_platform_enum \{/g) || []).length, 1);

  const runTypes = schema.match(/enum marketing_intelligence_run_type_enum \{([\s\S]*?)\n\}/)?.[1] || "";
  for (const value of ["CREATIVE_SYNC", "SCORE", "RECOMMEND", "ALERT", "FULL_EVALUATION"]) {
    assert.match(runTypes, new RegExp(`\\b${value}\\b`));
    assert.match(migration, new RegExp(`ADD VALUE IF NOT EXISTS '${value}'`));
  }

  const creativeTypes = schema.match(/enum marketing_creative_type_enum \{([\s\S]*?)\n\}/)?.[1] || "";
  for (const value of ["IMAGE", "VIDEO", "CAROUSEL", "TEXT", "UNKNOWN"]) {
    assert.match(creativeTypes, new RegExp(`\\b${value}\\b`));
  }
});

test("Section 7 models and required uniqueness constraints exist exactly once", () => {
  const names = [
    "marketing_creative_assets",
    "marketing_creative_performance_snapshots",
    "marketing_creative_score_snapshots",
    "marketing_recommendations",
    "marketing_alerts",
    "marketing_experiments",
  ];
  for (const name of names) assert.equal((schema.match(new RegExp(`model ${name} \\{`, "g")) || []).length, 1);
  assert.equal((schema.match(/model marketing_intelligence_evaluation_runs \{/g) || []).length, 1);

  assert.match(model("marketing_creative_assets"), /@@unique\(\[connectionId, sourceKey\]/);
  assert.match(model("marketing_creative_performance_snapshots"), /@@unique\(\[connectionId, sourceMetricKey, date\]/);
  assert.match(model("marketing_creative_score_snapshots"), /@@unique\(\[creativeAssetId, analysisWindowStart, analysisWindowEnd, ruleVersion\]/);
  assert.match(model("marketing_intelligence_settings"), /@@unique\(\[key, scopeFingerprint\]/);
});

test("Section 7 relations target retained admin-domain records safely", () => {
  const assets = model("marketing_creative_assets");
  assert.match(assets, /connection\s+marketing_ad_platform_connections\s+@relation\([^\n]+onDelete: Restrict/);
  assert.match(assets, /sourceSocialMediaAsset\s+SocialMediaAsset\?\s+@relation\([^\n]+onDelete: SetNull/);

  const recommendations = model("marketing_recommendations");
  assert.match(recommendations, /acceptedByAdmin\s+AdminUser\?[\s\S]*onDelete: SetNull/);
  assert.match(recommendations, /convertedToTask\s+Task\?[\s\S]*onDelete: SetNull/);

  const alerts = model("marketing_alerts");
  assert.match(alerts, /resolvedByAdmin\s+AdminUser\?[\s\S]*onDelete: SetNull/);
  assert.match(alerts, /notification\s+Notification\?[\s\S]*onDelete: SetNull/);

  const experiments = model("marketing_experiments");
  assert.match(experiments, /createdByAdmin\s+AdminUser\s+@relation/);
});

test("Section 7 migration is manifested, additive-safe, and uses the admin database schema", () => {
  assert.ok(manifest.migrations.some((entry) => entry.file === migrationName));
  assert.doesNotMatch(migration, /\bDROP\s+(TABLE|COLUMN|TYPE)\b/i);
  assert.match(migration, /REFERENCES "admin_users"\("id"\)/);
  assert.match(migration, /REFERENCES "tasks"\("id"\)/);
  assert.match(migration, /REFERENCES "notifications"\("id"\)/);
  assert.match(migration, /REFERENCES "social_media_assets"\("id"\)/);
  assert.doesNotMatch(schema, /mainPrisma/);
  const adminGuard = fs.readFileSync(
    path.join(root, "scripts/social-operations/admin-database-target.js"),
    "utf8",
  );
  assert.match(adminGuard, /DATABASE_URL/);
  assert.match(adminGuard, /admin/i);
});
