const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const marketingService = require("../src/modules/marketing/marketing.service");
const { prisma } = require("../src/shared/config/database");

const createdPostIds = [];
const createdAccountIds = [];

function resetPolicyEnv() {
  delete process.env.MARKETING_LEGACY_SOCIAL_FRONTEND_CUTOVER_COMPLETE;
  delete process.env.MARKETING_LEGACY_SOCIAL_WRITE_DEPRECATION_ENABLED;
  delete process.env.MARKETING_LEGACY_SOCIAL_READ_COMPATIBILITY_ENDS_AT;
}

after(async () => {
  resetPolicyEnv();
  if (createdPostIds.length) {
    await prisma.marketing_social_posts.deleteMany({
      where: { id: { in: createdPostIds } },
    });
  }
  if (createdAccountIds.length) {
    await prisma.marketing_social_accounts.deleteMany({
      where: { id: { in: createdAccountIds } },
    });
  }
  await prisma.$disconnect();
});

test("legacy createSocialPost cannot store Published from a request-only operation", async () => {
  resetPolicyEnv();
  const result = await marketingService.createSocialPost({
    platform: "Facebook",
    caption: `freeze-published-${Date.now()}`,
    status: "Published",
    attachmentUrl: "https://example.com/legacy-post.png",
  });
  createdPostIds.push(result.id);

  const row = await prisma.marketing_social_posts.findUnique({
    where: { id: result.id },
  });

  assert.equal(row.status, "Draft");
  assert.equal(row.postedAt, null);
  assert.notEqual(row.status, "Published");
});

test("legacy createSocialSchedule preserves requested time but cannot store Scheduled", async () => {
  resetPolicyEnv();
  const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const result = await marketingService.createSocialSchedule({
    platform: "Instagram",
    caption: `freeze-scheduled-${Date.now()}`,
    attachmentUrls: ["https://example.com/legacy-schedule.png"],
    scheduledFor: future,
  });
  createdPostIds.push(result.id);

  const row = await prisma.marketing_social_posts.findUnique({
    where: { id: result.id },
  });

  assert.equal(row.status, "Draft");
  assert.ok(row.scheduledFor);
  assert.notEqual(row.status, "Scheduled");
});

test("legacy account write does not persist password-style provider credentials", async () => {
  resetPolicyEnv();
  const username = `legacy-freeze-${Date.now()}`;
  const result = await marketingService.createSocialAccount({
    platform: "Twitter",
    username,
    password: "placeholder-credential-value",
    saveCredentials: true,
  });
  createdAccountIds.push(result.id);

  const row = await prisma.marketing_social_accounts.findUnique({
    where: { id: result.id },
  });
  assert.equal(row.encryptedPassword, null);
  assert.equal(row.credentialsSaved, false);

  const listed = await marketingService.listSocialAccounts();
  const returned = listed.data.find((account) => account.id === result.id);
  assert.ok(returned);
  assert.equal(Object.hasOwn(returned, "encryptedPassword"), false);
  assert.equal(Object.hasOwn(returned, "credentialsSaved"), false);
});

test("explicit legacy write deprecation blocks unsafe legacy writes without provider calls", async () => {
  process.env.MARKETING_LEGACY_SOCIAL_FRONTEND_CUTOVER_COMPLETE = "true";
  process.env.MARKETING_LEGACY_SOCIAL_WRITE_DEPRECATION_ENABLED = "true";

  await assert.rejects(
    marketingService.createSocialPost({
      platform: "Facebook",
      caption: "blocked by cutover",
    }),
    (error) => error.statusCode === 409,
  );

  resetPolicyEnv();
});
