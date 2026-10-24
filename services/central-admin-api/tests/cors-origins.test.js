"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createOriginPolicy } = require("../src/shared/config/cors-origins");

test("canonical admin frontend remains allowed when CORS_ORIGINS is set", () => {
  const allow = createOriginPolicy({ CORS_ORIGINS: "https://other-owned.example" });
  assert.equal(allow("https://centralize-admin.vercel.app"), true);
  assert.equal(allow("https://centralize-admin.cosmiforgegroup.cloud"), true);
  assert.equal(allow("https://centralize-admin-staging.vercel.app"), true);
  assert.equal(allow("https://centralize-admin-staging-cosmicforgedevteamgmailcoms-projects.vercel.app"), true);
  assert.equal(allow("https://other-owned.example"), true);
});

test("configured origins are trimmed, localhost default remains for development", () => {
  const allow = createOriginPolicy({ CORS_ORIGINS: " https://staging.example , https://internal.example " });
  assert.equal(allow("https://staging.example"), true);
  assert.equal(allow("https://internal.example"), true);
  assert.equal(createOriginPolicy({})("http://localhost:3000"), true);
});

test("only this project's preview deployment domains are auto-allowed", () => {
  const allow = createOriginPolicy({});
  assert.equal(allow("https://centralize-admin-abc123-cosmicforgedevteamgmailcoms-projects.vercel.app"), true);
  assert.equal(allow("https://attacker.vercel.app"), false);
  assert.equal(allow("https://centralize-admin.vercel.app.attacker.com"), false);
  assert.equal(allow("https://another-admin-abc123-cosmicforgedevteamgmailcoms-projects.vercel.app"), false);
  assert.equal(allow("null"), false);
  assert.equal(allow(undefined), true); // Non-browser health checks
});
