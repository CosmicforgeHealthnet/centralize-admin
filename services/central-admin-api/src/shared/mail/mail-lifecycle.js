"use strict";

// HR/admin account lifecycle hooks into CosmicForge Mail.
//
// Mail is optional: the running app exposes its Mail application on
// app.locals.mail (src/app.js); tests may inject one with
// setMailApplication(). Every hook here is best effort: it never throws, it
// never fails the HR action, it logs what happened and returns a small
// outcome object the caller records in its own audit entry.
//
// - offboardMailForAccount: run after every status change to INACTIVE or
//   LOCKED (deactivate, lock, delete attempt). Reactivation restores nothing.
// - requestMailProvisioningForAccount: HR onboarding; files a PENDING
//   PERSONAL_MAILBOX request (IT approval still required).

const logger = require("../utils/logger");

const MAIL_REVOKING_STATUSES = new Set(["INACTIVE", "LOCKED"]);
let mailApplicationOverride;

// Test seam: an application object, null ("Mail not available") or
// undefined (use req.app.locals.mail).
function setMailApplication(application) {
  mailApplicationOverride = application;
}

function resolveMailApplication(req) {
  if (mailApplicationOverride !== undefined) return mailApplicationOverride;
  return req?.app?.locals?.mail || null;
}

function isMailRevokingStatus(status) {
  return MAIL_REVOKING_STATUSES.has(String(status || ""));
}

function requestContext(req) {
  return { requestId: req?.correlationId || null, ipAddress: req?.ip || null, sessionId: req?.authSession?.id || null };
}

async function schemaReady(mail) {
  if (!mail?.schema?.isReady) return true;
  return Boolean(await mail.schema.isReady());
}

async function offboardMailForAccount({ accountId, actorId = null, trigger, req }) {
  const label = `${trigger} ${accountId}`;
  const mail = resolveMailApplication(req);
  const offboard = mail?.services?.admin?.offboardForAccountLifecycle;
  if (!offboard) {
    logger.info(`Account lifecycle ${label}: Mail not available, Mail offboarding skipped`);
    return { status: "SKIPPED_MAIL_UNAVAILABLE" };
  }
  try {
    if (!(await schemaReady(mail))) {
      logger.warn(`Account lifecycle ${label}: Mail schema not ready, Mail offboarding skipped`);
      return { status: "SKIPPED_SCHEMA_NOT_READY" };
    }
    const summary = await offboard(accountId, { actorAdminUserId: actorId || null, trigger }, requestContext(req));
    return { status: "OFFBOARDED", ...summary };
  } catch (error) {
    logger.error(`Account lifecycle ${label}: Mail offboarding failed (${error?.code || "error"})`);
    return { status: "FAILED" };
  }
}

// Returns { status: "REQUESTED", requestId } | { status: "SKIPPED", reason }
// | { status: "FAILED", reason }. Never creates or modifies an AdminUser.
async function requestMailProvisioningForAccount({ accountId, actorId, localPart = null, domainId = null, name = null, req }) {
  const mail = resolveMailApplication(req);
  const create = mail?.services?.admin?.createOnboardingProvisionRequest;
  if (!create) {
    logger.info(`HR onboarding ${accountId}: Mail not available, work email request skipped`);
    return { status: "SKIPPED", reason: "MAIL_UNAVAILABLE" };
  }
  if (mail.config && !mail.config.enabled) {
    logger.info(`HR onboarding ${accountId}: Mail disabled, work email request skipped`);
    return { status: "SKIPPED", reason: "MAIL_DISABLED" };
  }
  try {
    if (!(await schemaReady(mail))) {
      logger.warn(`HR onboarding ${accountId}: Mail schema not ready, work email request skipped`);
      return { status: "SKIPPED", reason: "MAIL_SCHEMA_NOT_READY" };
    }
    const row = await create(accountId, { requestedByAdminUserId: actorId, localPart, domainId, name }, requestContext(req));
    return { status: "REQUESTED", requestId: row.id, requestStatus: row.status, requestedAddress: row.requestedAddress || null };
  } catch (error) {
    const first = Array.isArray(error?.errors) ? error.errors[0] : null;
    const reason = first?.reason || first?.code || error?.code || "ERROR";
    logger.error(`HR onboarding ${accountId}: work email request failed (${reason})`);
    return { status: "FAILED", reason: String(reason).slice(0, 64) };
  }
}

module.exports = {
  MAIL_REVOKING_STATUSES,
  setMailApplication,
  resolveMailApplication,
  isMailRevokingStatus,
  offboardMailForAccount,
  requestMailProvisioningForAccount,
};
