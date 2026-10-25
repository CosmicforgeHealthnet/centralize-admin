"use strict";

const { prisma } = require("../../shared/config/database");
const { createAuditLog } = require("../../shared/middlewares/audit.middleware");
const { sessionService } = require("../../shared/auth");
const notificationService = require("../notifications/notifications.service");
const { createMfaService } = require("./mfa.service");

const mfaService = createMfaService({
  client: prisma,
  sessions: sessionService,
  audit: (entry) => createAuditLog(entry),
  notify: (adminUserId, notification) => notificationService.createNotification({ adminUserId, ...notification }),
});

module.exports = { mfaService };
