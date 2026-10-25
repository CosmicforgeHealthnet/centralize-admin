"use strict";

const { prisma } = require("../../shared/config/database");
const { sessionService, recordAuthEvent } = require("../../shared/auth");
const notificationService = require("../notifications/notifications.service");
const { createMfaService } = require("./mfa.service");

// Only used once getAuthRuntime().ready is true (routes guard with requireAuthSchema).
const mfaService = createMfaService({
  client: prisma,
  sessions: sessionService,
  events: recordAuthEvent,
  notify: (adminUserId, notification) => notificationService.createNotification({ adminUserId, ...notification }),
});

module.exports = { mfaService };
