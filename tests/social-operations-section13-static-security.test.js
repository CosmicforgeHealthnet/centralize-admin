const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  assertNoMutableSocialAuditUsage,
} = require("../src/modules/marketing/social-operations/security/social-audit.service");

const ROOT = path.resolve(__dirname, "..");
const SOCIAL_ROOT = path.join(ROOT, "src", "modules", "marketing", "social-operations");

function jsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...jsFiles(full));
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

function sourceWithoutTests() {
  return jsFiles(SOCIAL_ROOT)
    .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
    .map((file) => [file, fs.readFileSync(file, "utf8")]);
}

test("Social Operations keeps Marketing Intelligence credentials separate", () => {
  for (const [file, source] of sourceWithoutTests()) {
    assert.equal(
      /marketing[\\/]+intelligence|intelligence[\\/]+.*credential|ad_platform/i.test(source),
      false,
      file,
    );
  }
});

test("Social Operations code has no plaintext encryption fallback or live inbox default", () => {
  const combined = sourceWithoutTests().map(([, source]) => source).join("\n");
  assert.equal(combined.includes("LOCAL_FALLBACK_KEY"), false);
  assert.equal(combined.includes("cosmicforge-social-operations-local-webhook-payload-key"), false);
  assert.equal(/SOCIAL_INBOX_ENABLED[^;\n]*true/.test(combined), false);
  assert.equal(/\b(openai|chatgpt)\b/i.test(combined), false);
});

test("Social audit writes are create-only inside Social Operations", async () => {
  assert.equal(await assertNoMutableSocialAuditUsage({ sourceRoot: SOCIAL_ROOT }), true);
});

test("SocialActionJob creators validate payloadJson and DTOs do not expose encrypted buffers", () => {
  for (const [file, source] of sourceWithoutTests()) {
    if (/socialActionJob\.(create|upsert)/.test(source)) {
      assert.equal(/payloadJson:\s*\{/.test(source), false, file);
    }
    if (file.endsWith(`controllers${path.sep}social.controller.js`)) {
      assert.equal(/encryptedRawPayload|encryptedCredentials/.test(source), false);
    }
  }
});
