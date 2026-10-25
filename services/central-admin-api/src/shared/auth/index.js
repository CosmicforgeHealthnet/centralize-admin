"use strict";

const { prisma } = require("../config/database");
const { createAuditLog } = require("../middlewares/audit.middleware");
const { createSessionService } = require("./session.service");

// Process-wide session service bound to the Admin DB.
const sessionService = createSessionService({
  client: prisma,
  audit: (entry) => createAuditLog(entry),
});

module.exports = { sessionService };
