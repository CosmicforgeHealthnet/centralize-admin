const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  SECTION8_AUTH_ROUTES,
} = require("../src/modules/marketing/social-operations/routes/social.routes");
const {
  getSocialOperationGrant,
  createRequireSocialOperation,
} = require("../src/modules/marketing/social-operations/governance/social-operations.rbac");

test("authenticated Section 8 routes resolve to marketing VIEW or EDIT grants", () => {
  for (const route of SECTION8_AUTH_ROUTES) {
    const grant = getSocialOperationGrant(route.action);
    assert.equal(grant.module, "marketing");
    assert.ok(["VIEW", "EDIT"].includes(grant.mode));
    assert.notEqual(grant.mode, "EMERGENCY_OVERRIDE");
  }
});

test("required Section 8 route permissions match the prompt", () => {
  const grants = Object.fromEntries(
    SECTION8_AUTH_ROUTES.map((route) => [
      `${route.method.toUpperCase()} ${route.path}`,
      getSocialOperationGrant(route.action),
    ]),
  );

  assert.equal(grants["GET /connections"].section, "social_connections");
  assert.equal(grants["GET /connections"].mode, "VIEW");
  assert.equal(grants["POST /connections/:id/disable"].section, "social_connections");
  assert.equal(grants["POST /posts/:id/submit"].section, "social_content_submit");
  assert.equal(grants["POST /posts/:id/publish"].section, "social_publish");
  assert.equal(grants["POST /posts/:id/schedule"].section, "social_schedule");
  assert.equal(grants["POST /publications/:id/retry"].section, "social_publish_retry");
  assert.equal(grants["POST /publications/:id/cancel"].section, "social_publish_cancel");
  assert.equal(
    grants["POST /publications/:id/delete-provider-post"].section,
    "social_publish_delete",
  );
  assert.equal(grants["POST /comments/:id/hide"].section, "social_moderation_hide");
  assert.equal(grants["POST /comments/:id/delete"].section, "social_moderation_delete");
  assert.equal(grants["POST /comments/:id/escalate"].section, "social_moderation_escalate");
  assert.equal(grants["GET /analytics/export"].section, "social_analytics");
  assert.equal(grants["PATCH /settings"].section, "social_settings");
  assert.equal(grants["GET /operations"].section, "social_operations");
});

test("route middleware uses the confirmed three-argument requireSection signature", () => {
  const calls = [];
  const requireSocialOperation = createRequireSocialOperation((module, section, mode, extra) => {
    calls.push([module, section, mode, extra]);
    return (req, res, next) => next();
  });

  for (const route of SECTION8_AUTH_ROUTES) {
    requireSocialOperation(route.action);
  }

  assert.equal(calls.length, SECTION8_AUTH_ROUTES.length);
  for (const call of calls) {
    assert.equal(call.length, 4);
    assert.equal(call[0], "marketing");
    assert.ok(["VIEW", "EDIT"].includes(call[2]));
    assert.equal(call[3], undefined);
  }
});

