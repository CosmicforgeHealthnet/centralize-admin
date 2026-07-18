const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SOCIAL_SAFETY_ROOT = path.join(
  ROOT,
  "src",
  "modules",
  "marketing",
  "social-operations",
  "safety",
);

function readSafetySource() {
  return fs
    .readdirSync(SOCIAL_SAFETY_ROOT)
    .filter((name) => name.endsWith(".js"))
    .map((name) => fs.readFileSync(path.join(SOCIAL_SAFETY_ROOT, name), "utf8"))
    .join("\n");
}

test("safety Task code does not introduce fake or sentinel assignees", () => {
  const source = readSafetySource();
  assert.equal(/00000000-0000-0000-0000-000000000000/.test(source), false);
  assert.equal(/system-admin|systemAssignee|fallbackAssignee|sentinel/i.test(source), false);
  assert.equal(/assigneeId:\s*["']{2}/.test(source), false);
});

test("emergency and self-harm workflows always attempt Task creation", () => {
  const source = fs.readFileSync(
    path.join(SOCIAL_SAFETY_ROOT, "escalation.service.js"),
    "utf8",
  );
  assert.match(source, /SAFETY_TASK_ALWAYS_CREATE_CLASSIFICATIONS/);
  assert.match(source, /MEDICAL_EMERGENCY/);
  assert.match(source, /SELF_HARM_RISK/);
  assert.equal(/if \(!assignee \|\| !actorId\) return null/.test(source), false);
});

test("safety Task content and alerts do not interpolate message or comment text", () => {
  const source = readSafetySource();
  assert.equal(/messageContent|commentContent|body\.text|comment\.text|message\.content/.test(source), false);
  assert.equal(/sendMessage|replyToComment|providerReply|hotline/i.test(source), false);
});
