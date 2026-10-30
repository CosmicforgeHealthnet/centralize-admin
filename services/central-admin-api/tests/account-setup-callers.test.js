"use strict";

// Drives the real lab approval, HR invitation/resend and HR-approved reset
// code against a replayed Admin database, with the HealthNet main DB and the
// mailers replaced by in-memory fakes. Proves no email carries a password,
// each sends a working single-use link, and nothing breaks before the
// account-setup migration exists.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const sent = [];
const mainUsers = new Map();
const labs = new Map();

function stub(relative, exports) {
  const resolved = require.resolve(relative);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub("../src/shared/config/mailer", {
  createTransporter: async () => ({ sendMail: async (options) => sent.push({ channel: "hq", ...options }) }),
  sendLabEmail: async (options) => sent.push({ channel: "lab", ...options }),
});

const fakeMain = {
  users: {
    findUnique: async ({ where }) => (where.id ? mainUsers.get(where.id) : [...mainUsers.values()].find((user) => user.email === where.email)) || null,
    create: async ({ data }) => {
      const user = { id: crypto.randomUUID(), status: "active", ...data };
      mainUsers.set(user.id, user);
      return user;
    },
    update: async ({ where, data }) => {
      const user = { ...mainUsers.get(where.id), ...data };
      mainUsers.set(where.id, user);
      return user;
    },
  },
  lab_facilities: {
    findUnique: async ({ where }) => labs.get(where.id) || null,
    update: async ({ where, data }) => {
      const lab = { ...labs.get(where.id), ...data };
      labs.set(where.id, lab);
      return lab;
    },
  },
  audit_logs: { create: async () => ({}) },
  $transaction: async (fn) => fn(fakeMain),
};
stub("../src/shared/config/mainDatabase", { mainPrisma: fakeMain, connectMainDatabase: async () => {} });

function linkFrom(html) {
  const match = /account-setup#token=([^"&<\s]+)/.exec(html);
  return match ? decodeURIComponent(match[1]) : null;
}

test("callers send single-use links, never passwords (real Admin DB)", { timeout: 240000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const { openDatabase } = require("./helpers/mail-test-harness");
  const db = await openDatabase();
  // Every module below binds to the replayed database.
  process.env.DATABASE_URL = db.replay.replayUrl;
  process.env.FRONTEND_URL = "https://admin.example.invalid";
  process.env.MAIN_APP_URL = "https://healthnet.example.invalid";
  const { prisma } = require("../src/shared/config/database");
  const verificationService = require("../src/modules/verification/verification.service");
  const accountsService = require("../src/modules/hrm/accounts/accounts.service");
  const authService = require("../src/modules/auth/auth.service");
  const { accountSetup, accountSetupReadiness } = require("../src/shared/auth/account-setup");
  const { comparePassword, validatePasswordStrength, hashPassword } = require("../src/shared/utils/password.util");
  const helpers = { validatePassword: validatePasswordStrength, hashPassword };
  const STRONG = "Str0ng!Passw0rd";

  const actorId = crypto.randomUUID();
  await prisma.adminUser.create({ data: { id: actorId, email: "hr.lead@staff.example.invalid", password: "x", name: "HR Lead", tier: "ADMIN", department: "MANAGEMENT", isTeamLead: true, status: "ACTIVE", mustChangePassword: false } });
  const actor = await prisma.adminUser.findUnique({ where: { id: actorId } });

  try {
    await t.test("lab approval: account gets an unusable password and a setup link email", async () => {
      sent.length = 0;
      const labId = crypto.randomUUID();
      labs.set(labId, { id: labId, status: "pending", adminEmail: "owner@lab.example.invalid", adminFullName: "Lab Owner", facilityName: "Lab One" });
      const result = await verificationService.approveLab({ id: labId, adminUserId: actorId, req: { headers: {}, get: () => null } });
      assert.equal(result.setupLink, "SENT");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].channel, "lab");
      assert.doesNotMatch(sent[0].html, /temporary password/i);
      const token = linkFrom(sent[0].html);
      assert.ok(token, "email carries a setup link");
      const labUser = [...mainUsers.values()].find((user) => user.email === "owner@lab.example.invalid");
      assert.equal(labUser.mustChangePassword, true);
      const info = await accountSetup.inspect(token);
      assert.equal(info.purpose, "LAB_ADMIN_SETUP");
      assert.equal(info.loginUrl, "https://healthnet.example.invalid");
      await accountSetup.complete(token, STRONG, helpers);
      assert.equal(await comparePassword(STRONG, mainUsers.get(labUser.id).passwordHash), true);
      assert.equal(mainUsers.get(labUser.id).mustChangePassword, false);
      // Resend is refused once the password exists.
      await assert.rejects(() => verificationService.resendLabSetupLink({ id: labId, adminUserId: actorId, req: {} }), /already set a password/);
    });

    await t.test("HR invitation: link email, pending account activates on setup; resend revokes the old link", async () => {
      sent.length = 0;
      const created = await accountsService.createAccount({ data: { name: "New Hire", email: "new.hire@staff.example.invalid", tier: "EMPLOYEE", department: "MANAGEMENT" }, actor, req: { headers: {}, get: () => null } });
      assert.equal(created.inviteDelivery, "SENT");
      const first = linkFrom(sent[0].html);
      assert.doesNotMatch(sent[0].html, /temporary password/i);
      const resend = await accountsService.resendInvite({ id: created.id, actor, req: { headers: {}, get: () => null } });
      assert.equal(resend.inviteDelivery, "SENT");
      const second = linkFrom(sent[1].html);
      await assert.rejects(() => accountSetup.inspect(first), (error) => error.code === "ACCOUNT_SETUP_LINK_INVALID");
      await accountSetup.complete(second, STRONG, helpers);
      const user = await prisma.adminUser.findUnique({ where: { id: created.id } });
      assert.equal(user.status, "ACTIVE");
      assert.equal(await comparePassword(STRONG, user.password), true);
    });

    await t.test("HR-approved reset: link email; the old password keeps working until the link is used", async () => {
      sent.length = 0;
      const userId = crypto.randomUUID();
      await prisma.adminUser.create({ data: { id: userId, email: "forgetful@staff.example.invalid", password: await hashPassword("Old!Passw0rd"), name: "Forgetful", tier: "EMPLOYEE", status: "LOCKED", mustChangePassword: false, passwordResetToken: crypto.randomBytes(16).toString("hex"), passwordResetExpires: new Date(Date.now() + 3600000) } });
      await authService.approvePasswordReset({ targetUserId: userId, approvedBy: actorId, req: { headers: {}, get: () => null } });
      assert.equal(sent.length, 1);
      assert.doesNotMatch(sent[0].html, /temporary password/i);
      const before = await prisma.adminUser.findUnique({ where: { id: userId } });
      assert.equal(await comparePassword("Old!Passw0rd", before.password), true, "approval no longer overwrites the password");
      assert.equal(before.passwordResetToken, null);
      await accountSetup.complete(linkFrom(sent[0].html), STRONG, helpers);
      const after = await prisma.adminUser.findUnique({ where: { id: userId } });
      assert.equal(after.status, "ACTIVE");
      assert.equal(await comparePassword(STRONG, after.password), true);
    });

    await t.test("before the migration: invitations are created but nothing is emailed; reset approval is refused", async () => {
      await prisma.$executeRawUnsafe('ALTER TABLE "account_setup_tokens" RENAME TO "account_setup_tokens_hidden"');
      accountSetupReadiness.reset();
      sent.length = 0;
      try {
        const created = await accountsService.createAccount({ data: { name: "Later Hire", email: "later@staff.example.invalid", tier: "EMPLOYEE", department: "MANAGEMENT" }, actor, req: { headers: {}, get: () => null } });
        assert.equal(created.inviteDelivery, "PENDING_MIGRATION");
        const labId = crypto.randomUUID();
        labs.set(labId, { id: labId, status: "pending", adminEmail: "second@lab.example.invalid", adminFullName: "Second", facilityName: "Lab Two" });
        const lab = await verificationService.approveLab({ id: labId, adminUserId: actorId, req: { headers: {}, get: () => null } });
        assert.equal(lab.setupLink, "PENDING_MIGRATION");
        assert.equal(sent.length, 0, "no password or link is emailed without the table");
        const userId = crypto.randomUUID();
        await prisma.adminUser.create({ data: { id: userId, email: "waiting@staff.example.invalid", password: "x", name: "Waiting", tier: "EMPLOYEE", status: "ACTIVE", mustChangePassword: false, passwordResetToken: crypto.randomBytes(16).toString("hex"), passwordResetExpires: new Date(Date.now() + 3600000) } });
        await assert.rejects(() => authService.approvePasswordReset({ targetUserId: userId, approvedBy: actorId, req: {} }), (error) => error.statusCode === 503);
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "account_setup_tokens_hidden" RENAME TO "account_setup_tokens"');
        accountSetupReadiness.reset();
      }
    });
  } finally {
    await prisma.$disconnect().catch(() => {});
    await db.close();
  }
});
