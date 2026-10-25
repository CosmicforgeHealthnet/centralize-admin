"use strict";

const { prisma } = require("../config/database");
const logger = require("../utils/logger");
const { createSessionService } = require("./session.service");
const { createSchemaReadiness } = require("./schema-readiness");
const { createAuthEvents } = require("./auth-events");
const { loadSessionConfig } = require("./session.config");

const authSchema = createSchemaReadiness({ client: prisma, logger });
const recordAuthEvent = createAuthEvents({ client: prisma, logger });

// Process-wide session service bound to the Admin DB.
const sessionService = createSessionService({ client: prisma, events: recordAuthEvent });

let downgradeWarned = false;
// Effective auth runtime for this request: the configured mode, downgraded to
// legacy (loudly, without crashing) while the session/MFA schema is missing.
async function getAuthRuntime(env = process.env) {
  const ready = await authSchema.isReady();
  const config = loadSessionConfig(env, { schemaReady: ready });
  if (config.degradedFrom && !downgradeWarned) {
    downgradeWarned = true;
    logger.warn(`[Auth] AUTH_SESSION_MODE=${config.degradedFrom} requested but the session/MFA schema is not ready; serving legacy mode until the migration is applied.`);
  }
  if (ready) downgradeWarned = false;
  return { ready, config };
}

module.exports = { sessionService, authSchema, recordAuthEvent, getAuthRuntime };
