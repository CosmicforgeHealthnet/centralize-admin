"use strict";

// Runtime send controls (kill switch). One place every sending path asks
// "may I call the provider for this purpose right now?".
//   M9: environment emergency stop (MAIL_EMERGENCY_STOP_ALL / _MARKETING).
//   M10 extends this with database-backed controls (rollout flags and an
//   operator emergency stop that needs no redeploy).
// A halt never deletes queued work: callers defer or refuse new work.
// Receiving and delivery-event processing are never halted.

const MARKETING_PURPOSES = new Set(["MARKETING_BROADCAST", "MARKETING_AUTOMATION", "MARKETING_CONFIRMATION"]);
const SEND_PURPOSES = new Set(["STAFF_MAIL", "SUPPORT", ...MARKETING_PURPOSES]);

function createRuntimeControls({ config, extraResolvers = [] }) {
  const resolvers = [...extraResolvers];

  async function haltReason(purpose, scope = {}) {
    if (!SEND_PURPOSES.has(purpose)) throw new Error(`unknown send purpose ${purpose}`);
    if (config.emergencyStop.all) return "MAIL_EMERGENCY_STOP";
    if (MARKETING_PURPOSES.has(purpose) && config.emergencyStop.marketing) return "MARKETING_EMERGENCY_STOP";
    for (const resolve of resolvers) {
      const reason = await resolve(purpose, scope);
      if (reason) return reason;
    }
    return null;
  }

  function use(resolver) {
    resolvers.push(resolver);
  }

  return { haltReason, use, MARKETING_PURPOSES, SEND_PURPOSES };
}

function purposeForMailbox(mailbox) {
  return mailbox?.purpose === "SUPPORT" ? "SUPPORT" : "STAFF_MAIL";
}

module.exports = { createRuntimeControls, purposeForMailbox, MARKETING_PURPOSES, SEND_PURPOSES };
