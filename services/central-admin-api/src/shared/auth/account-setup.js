"use strict";

// Process-wide account setup link service bound to the Admin DB (tokens,
// Admin users) and, lazily, the HealthNet main DB (lab admin users). The main
// DB client is required only when a lab link is used, so Admin-only flows keep
// working while HealthNet is unreachable.

const { prisma } = require("../config/database");
const logger = require("../utils/logger");
const { createSchemaReadiness } = require("./schema-readiness");
const { createAccountSetupService } = require("./account-setup.service");

const ACCOUNT_SETUP_TABLES = Object.freeze(["account_setup_tokens"]);

const readiness = createSchemaReadiness({
  client: prisma,
  logger,
  tables: ACCOUNT_SETUP_TABLES,
  label: "[AccountSetup]",
  missingMessage: "[AccountSetup] account_setup_tokens is not present (migration 20261031_account_setup_tokens.sql not applied). Setup/reset links cannot be issued; no temporary password is ever emailed instead.",
});

function mainPrisma() {
  return require("../config/mainDatabase").mainPrisma;
}

// Admin-user subject: same database as the tokens. `revokeSessions` ends
// every session that existed before the new password.
function createAdminUserSubject(client, { revokeSessions = null } = {}) {
  return {
    async load(id) {
      const user = await client.adminUser.findUnique({ where: { id }, select: { email: true, name: true, status: true } });
      return user ? { email: user.email, name: user.name, active: user.status !== "INACTIVE" } : null;
    },
    async setPassword(id, passwordHash, { purpose }) {
      const now = new Date();
      const user = await client.adminUser.findUnique({ where: { id }, select: { status: true } });
      await client.adminUser.update({
        where: { id },
        data: {
          password: passwordHash,
          mustChangePassword: false,
          passwordChangedAt: now,
          failedLoginAttempts: 0,
          lockedUntil: null,
          passwordResetToken: null,
          passwordResetExpires: null,
          // An invitation is accepted by setting the password; a reset unlocks.
          status: user?.status === "PENDING" || user?.status === "LOCKED" ? "ACTIVE" : undefined,
        },
      });
      await client.refreshToken.updateMany({ where: { adminUserId: id }, data: { isRevoked: true } });
      if (revokeSessions) await revokeSessions(id, purpose === "ADMIN_INVITE" ? "ACCOUNT_SETUP_COMPLETED" : "PASSWORD_RESET_COMPLETED");
    },
  };
}

// HealthNet lab-admin subject: the product user lives in the main DB.
function createHealthnetUserSubject(getMainClient) {
  return {
    async load(id) {
      const user = await getMainClient().users.findUnique({ where: { id }, select: { email: true, fullName: true, status: true } });
      return user ? { email: user.email, name: user.fullName, active: user.status !== "locked" } : null;
    },
    async setPassword(id, passwordHash) {
      await getMainClient().users.update({ where: { id }, data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() } });
    },
  };
}

const subjects = {
  ADMIN_USER: createAdminUserSubject(prisma, {
    revokeSessions: async (id, reason) => {
      const { getAuthRuntime, sessionService } = require("./index");
      if ((await getAuthRuntime()).ready) await sessionService.revokeAllForUser(id, reason, { actorId: id });
    },
  }),
  HEALTHNET_USER: createHealthnetUserSubject(mainPrisma),
};

const accountSetup = createAccountSetupService({ client: prisma, readiness, subjects, logger });

module.exports = { accountSetup, accountSetupReadiness: readiness, ACCOUNT_SETUP_TABLES, createAdminUserSubject, createHealthnetUserSubject };
