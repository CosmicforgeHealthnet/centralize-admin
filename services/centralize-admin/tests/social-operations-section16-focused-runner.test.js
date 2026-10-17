const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  discoverFocusedTestFiles,
  relativeTestPath,
  sanitizeTestOutput,
} = require("../scripts/social-operations/run-focused-tests");

test("focused runner discovers each intended Social Operations file exactly once", () => {
  const files = discoverFocusedTestFiles();
  const relative = files.map((file) => relativeTestPath(file));
  console.log(`focused-runner-discovery files=${relative.length}`);

  assert.equal(relative.length, 44);
  assert.equal(new Set(relative).size, relative.length);
  assert.equal(relative[0], "tests/marketing-legacy-social-freeze.test.js");
  assert.ok(relative.includes("tests/social-operations-section16-focused-runner.test.js"));
  assert.ok(relative.includes("tests/social-operations-section16-google-oauth-import-safety.test.js"));
  assert.ok(relative.includes("tests/social-operations-section16-timeout-utils.test.js"));
  assert.ok(relative.every((file) => !file.includes("\\")));

  const srcTests = relative.filter((file) => file.startsWith("src/modules/marketing/social-operations/__tests__/"));
  const rootSectionTests = relative.filter((file) => file.startsWith("tests/social-operations-section"));
  assert.deepEqual(srcTests, [...srcTests].sort((left, right) => left.localeCompare(right, "en")));
  assert.deepEqual(rootSectionTests, [...rootSectionTests].sort((left, right) => left.localeCompare(right, "en")));
});

test("focused runner output sanitizer redacts credentials without hiding failure names", () => {
  const sanitized = sanitizeTestOutput(
    "not ok 1 - sample\nDATABASE_URL=postgresql://postgres:secret@localhost:5432/cosmicforge_admin\nAPI_SECRET=abc123\n",
  );
  assert.match(sanitized, /not ok 1 - sample/);
  assert.match(sanitized, /DATABASE_URL=<redacted>/);
  assert.doesNotMatch(sanitized, /secret@|abc123/);
});
