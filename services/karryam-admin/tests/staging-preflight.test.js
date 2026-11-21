"use strict";

// Section 12.3 staging preflight (scripts/check-config.js): production
// endpoints and superuser runtime identities are refused for staging; the
// denylist being absent is reported, never treated as a pass.

const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("./helpers/fixtures");
const { main } = require("../scripts/check-config");

test("staging preflight refuses production endpoints and superuser identities", (t) => {
  const m = F.material();
  t.after(m.cleanup);
  const env = F.enabledEnv(m, { KARRYAM_ADMIN_ENVIRONMENT: "staging", KARRYAM_ADMIN_DATABASE_URL: "postgresql://karryam_admin_runtime@karryam-admin-db:5432/karryam_admin" });
  assert.equal(main(env).production_denylist, "NOT_PROVIDED");
  assert.equal(main({ ...env, PRODUCT_ADMIN_PRODUCTION_DENYLIST: "prod-db.internal,10.9.9.9" }).production_denylist, "CHECKED");
  assert.throws(() => main({ ...env, PRODUCT_ADMIN_PRODUCTION_DENYLIST: "karryam-admin-db" }), (e) => e.reason === "PRODUCTION_ENDPOINT_IN_STAGING");
  assert.throws(() => main({ ...env, KARRYAM_ADMIN_DATABASE_URL: "postgresql://postgres@karryam-admin-db:5432/karryam_admin" }), (e) => e.reason === "DATABASE_SUPERUSER_IDENTITY");
  assert.throws(() => main({ ...env, KARRYAM_ADMIN_EXPECT_ENVIRONMENT: "production" }), (e) => e.reason === "KARRYAM_ADMIN_ENVIRONMENT_NOT_EXPECTED");
  // Non-staging environments are not subject to the staging-only rule.
  assert.equal(main(F.enabledEnv(m)).production_denylist, undefined);
  // Output never carries values.
  const text = JSON.stringify(main({ ...env, PRODUCT_ADMIN_PRODUCTION_DENYLIST: "prod-db.internal" }));
  for (const forbidden of ["karryam_admin_runtime", "karryam-admin-db", "prod-db.internal", m.dir]) assert.equal(text.includes(forbidden), false, forbidden);
});
