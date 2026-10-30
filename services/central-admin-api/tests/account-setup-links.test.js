"use strict";

// P0 (specification section 3): no email ever carries a password. Lab admin
// approval, HR invitations and HR-approved resets send a single-use,
// expiring setup link. Covers the email templates, the callers (static) and
// the token lifecycle on real PostgreSQL (replayed migrations).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Capture outgoing mail instead of contacting Gmail/cPanel.
const sent = [];
const mailerPath = require.resolve("../src/shared/config/mailer");
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: {
    createTransporter: async () => ({ sendMail: async (options) => sent.push({ channel: "hq", ...options }) }),
    sendLabEmail: async (options) => sent.push({ channel: "lab", ...options }),
  },
};
const { sendLabApprovalEmail, sendAccountSetupEmail } = require("../src/shared/utils/email.util");
const { createAccountSetupService, hashToken, maskEmail, setupUrl, ttlMs, parse } = require("../src/shared/auth/account-setup.service");
const { createAdminUserSubject } = require("../src/shared/auth/account-setup");
const { validatePasswordStrength, hashPassword, comparePassword } = require("../src/shared/utils/password.util");

const SRC = path.join(__dirname, "..", "src");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

test("emails carry a link and never a password", async () => {
  sent.length = 0;
  const expiresAt = new Date(Date.now() + 3600_000);
  await sendLabApprovalEmail({ to: "lab@example.invalid", fullName: "<b>Ada</b>", setupUrl: "https://admin.example.invalid/account-setup#token=abc", expiresAt });
  await sendAccountSetupEmail({ to: "staff@example.invalid", name: "Bo", purpose: "ADMIN_INVITE", setupUrl: "https://admin.example.invalid/account-setup#token=def", expiresAt });
  await sendAccountSetupEmail({ to: "staff@example.invalid", name: "Bo", purpose: "ADMIN_PASSWORD_RESET", setupUrl: "https://admin.example.invalid/account-setup#token=ghi", expiresAt });
  assert.equal(sent.length, 3);
  for (const message of sent) {
    assert.doesNotMatch(message.html, /temporary password|password:\s*<\/strong>/i);
    assert.match(message.html, /account-setup#token=/);
    assert.match(message.html, /expires on/);
  }
  assert.match(sent[0].html, /&lt;b&gt;Ada&lt;\/b&gt;/, "names are HTML-escaped");
  await assert.rejects(() => sendLabApprovalEmail({ to: "x@example.invalid", fullName: "X", expiresAt }), /setup link/);
  await assert.rejects(() => sendAccountSetupEmail({ to: "x@example.invalid", name: "X", purpose: "OTHER", setupUrl: "u", expiresAt }));
});

test("no caller generates or emails a temporary password any more", () => {
  for (const file of ["shared/utils/email.util.js", "modules/verification/verification.service.js", "modules/hrm/accounts/accounts.service.js", "modules/auth/auth.service.js", "shared/utils/password.util.js"]) {
    const source = read(file);
    assert.doesNotMatch(source, /tempPassword|generateTempPassword|_generateTempPassword/, `${file} still handles a temporary password`);
  }
  assert.match(read("modules/verification/verification.service.js"), /unusablePassword\(\)/);
  assert.match(read("modules/hrm/accounts/accounts.service.js"), /unusablePassword\(\)/);
  assert.match(read("modules/auth/auth.service.js"), /ADMIN_PASSWORD_RESET/);
});

test("link helpers: format, fragment URL, masking and bounded TTLs", () => {
  const token = `${crypto.randomUUID()}.${crypto.randomBytes(32).toString("base64url")}`;
  assert.ok(parse(token));
  assert.equal(parse(`${token}x`), null);
  assert.equal(parse("not-a-token"), null);
  assert.match(setupUrl(token, { FRONTEND_URL: "https://admin.example.invalid/" }), /^https:\/\/admin\.example\.invalid\/account-setup#token=/);
  assert.equal(maskEmail("ada@example.invalid"), "a**@example.invalid");
  assert.equal(ttlMs("ADMIN_PASSWORD_RESET", {}), 30 * 60_000);
  assert.equal(ttlMs("ADMIN_PASSWORD_RESET", { ACCOUNT_SETUP_RESET_TTL_MINUTES: "9999" }), 120 * 60_000);
  assert.equal(ttlMs("LAB_ADMIN_SETUP", { ACCOUNT_SETUP_LAB_TTL_HOURS: "0" }), 48 * 3600_000);
});

test("setup links on real PostgreSQL", { timeout: 180000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const { openDatabase } = require("./helpers/mail-test-harness");
  const db = await openDatabase();
  const { client } = db;
  let now = Date.now();
  const clock = () => new Date(now);
  const revoked = [];
  const products = new Map();
  let productDown = false;
  const subjects = {
    ADMIN_USER: createAdminUserSubject(client, { revokeSessions: async (id, reason) => revoked.push({ id, reason }) }),
    HEALTHNET_USER: {
      async load(id) {
        return products.get(id) || null;
      },
      async setPassword(id, passwordHash) {
        if (productDown) throw Object.assign(new Error("main db offline"), { code: "P1001" });
        products.set(id, { ...products.get(id), passwordHash });
      },
    },
  };
  let ready = true;
  const service = createAccountSetupService({ client, readiness: { isReady: async () => ready }, subjects, clock, env: { FRONTEND_URL: "https://admin.example.invalid" } });
  const helpers = { validatePassword: validatePasswordStrength, hashPassword };
  const STRONG = "Str0ng!Passw0rd";
  const userId = crypto.randomUUID();
  await client.adminUser.create({ data: { id: userId, email: "invitee@staff.example.invalid", password: await hashPassword(crypto.randomBytes(24).toString("hex")), name: "Invitee", tier: "EMPLOYEE", status: "PENDING", mustChangePassword: true } });
  await client.refreshToken.create({ data: { token: crypto.randomBytes(16).toString("hex"), adminUserId: userId, expiresAt: new Date(now + 86400000) } }).catch(() => null);

  try {
    await t.test("issue stores only the hash; inspect masks the email", async () => {
      const link = await service.issue({ purpose: "ADMIN_INVITE", subjectId: userId, email: "invitee@staff.example.invalid", createdBy: "hr" });
      assert.match(link.url, /#token=/);
      const row = await client.accountSetupToken.findUnique({ where: { id: link.tokenId } });
      assert.equal(row.tokenHash, hashToken(link.token));
      assert.ok(!JSON.stringify(row).includes(link.token.split(".")[1]), "secret never stored");
      assert.equal(row.emailDomain, "staff.example.invalid");
      const info = await service.inspect(link.token);
      assert.equal(info.purpose, "ADMIN_INVITE");
      assert.equal(info.email, "i******@staff.example.invalid");
    });

    await t.test("a new link revokes the previous one (one live link per subject)", async () => {
      const first = await service.issue({ purpose: "ADMIN_INVITE", subjectId: userId, email: "invitee@staff.example.invalid" });
      const second = await service.issue({ purpose: "ADMIN_INVITE", subjectId: userId, email: "invitee@staff.example.invalid" });
      await assert.rejects(() => service.inspect(first.token), (error) => error.code === "ACCOUNT_SETUP_LINK_INVALID");
      assert.equal((await service.inspect(second.token)).purpose, "ADMIN_INVITE");
      const live = await client.accountSetupToken.count({ where: { subjectId: userId, purpose: "ADMIN_INVITE", usedAt: null, revokedAt: null } });
      assert.equal(live, 1);
      // The partial unique index enforces it even for a buggy writer.
      await assert.rejects(() => client.accountSetupToken.create({ data: { purpose: "ADMIN_INVITE", subjectKind: "ADMIN_USER", subjectId: userId, tokenHash: "a".repeat(64), expiresAt: new Date(now + 60000), createdAt: clock() } }));
      await assert.rejects(() => client.$executeRawUnsafe(`INSERT INTO account_setup_tokens (id, purpose, subject_kind, subject_id, token_hash, expires_at) VALUES ('${crypto.randomUUID()}', 'SHELL', 'ADMIN_USER', 'x', '${"b".repeat(64)}', now() + interval '1 hour')`), /CHK_account_setup_tokens_purpose/);
    });

    await t.test("weak password is refused and the link stays usable; completion sets the password once", async () => {
      const link = await service.issue({ purpose: "ADMIN_INVITE", subjectId: userId, email: "invitee@staff.example.invalid" });
      await assert.rejects(() => service.complete(link.token, "weak", helpers), (error) => error.code === "ACCOUNT_SETUP_PASSWORD_WEAK" && error.statusCode === 400);
      const result = await service.complete(link.token, STRONG, helpers);
      assert.equal(result.subjectId, userId);
      const user = await client.adminUser.findUnique({ where: { id: userId } });
      assert.equal(await comparePassword(STRONG, user.password), true);
      assert.equal(user.mustChangePassword, false);
      assert.equal(user.status, "ACTIVE", "accepting the invitation activates the account");
      assert.deepEqual(revoked.at(-1), { id: userId, reason: "ACCOUNT_SETUP_COMPLETED" });
      assert.equal(await client.refreshToken.count({ where: { adminUserId: userId, isRevoked: false } }), 0);
      await assert.rejects(() => service.complete(link.token, STRONG, helpers), (error) => error.code === "ACCOUNT_SETUP_LINK_INVALID", "replay refused");
    });

    await t.test("concurrent redemption: exactly one wins", async () => {
      const link = await service.issue({ purpose: "ADMIN_PASSWORD_RESET", subjectId: userId, email: "invitee@staff.example.invalid" });
      const results = await Promise.allSettled([service.complete(link.token, STRONG, helpers), service.complete(link.token, "An0ther!Passw0rd", helpers)]);
      assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
      assert.equal(results.filter((entry) => entry.status === "rejected").length, 1);
    });

    await t.test("expiry, tampering and attempt limits", async () => {
      const link = await service.issue({ purpose: "ADMIN_PASSWORD_RESET", subjectId: userId, email: "invitee@staff.example.invalid" });
      const tampered = `${link.tokenId}.${crypto.randomBytes(32).toString("base64url")}`;
      for (let index = 0; index < 10; index += 1) await assert.rejects(() => service.inspect(tampered), (error) => error.code === "ACCOUNT_SETUP_LINK_INVALID");
      // After 10 wrong secrets even the right one is refused.
      await assert.rejects(() => service.inspect(link.token), (error) => error.code === "ACCOUNT_SETUP_LINK_INVALID");
      const fresh = await service.issue({ purpose: "ADMIN_PASSWORD_RESET", subjectId: userId, email: "invitee@staff.example.invalid" });
      now += 31 * 60_000;
      await assert.rejects(() => service.complete(fresh.token, STRONG, helpers), (error) => error.code === "ACCOUNT_SETUP_LINK_INVALID");
    });

    await t.test("inactive accounts cannot use a link", async () => {
      const link = await service.issue({ purpose: "ADMIN_PASSWORD_RESET", subjectId: userId, email: "invitee@staff.example.invalid" });
      await client.adminUser.update({ where: { id: userId }, data: { status: "INACTIVE" } });
      await assert.rejects(() => service.inspect(link.token), (error) => error.code === "ACCOUNT_SETUP_LINK_INVALID");
      await client.adminUser.update({ where: { id: userId }, data: { status: "ACTIVE" } });
    });

    await t.test("lab admin link: product DB outage gives the link back for a retry", async () => {
      const labUserId = crypto.randomUUID();
      products.set(labUserId, { email: "labadmin@lab.example.invalid", name: "Lab Admin", active: true });
      const link = await service.issue({ purpose: "LAB_ADMIN_SETUP", subjectId: labUserId, email: "labadmin@lab.example.invalid" });
      productDown = true;
      await assert.rejects(() => service.complete(link.token, STRONG, helpers), (error) => error.code === "ACCOUNT_SETUP_UNAVAILABLE" && error.statusCode === 503);
      productDown = false;
      await service.complete(link.token, STRONG, helpers);
      assert.equal(await comparePassword(STRONG, products.get(labUserId).passwordHash), true);
    });

    await t.test("before the migration: 503 and nothing issued", async () => {
      ready = false;
      await assert.rejects(() => service.inspect("x"), (error) => error.code === "ACCOUNT_SETUP_NOT_READY" && error.statusCode === 503);
      ready = true;
    });
  } finally {
    await db.close();
  }
});
