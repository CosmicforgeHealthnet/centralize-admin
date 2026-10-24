"use strict";

// Mailbox rules: simple, validated, server-side conditions and actions.
// conditions: { fromContains?, subjectContains?, toContains? } (all must match)
// actions:    { labelId?, folder?: "ARCHIVE"|"SPAM"|"TRASH", markRead?: boolean }

const FOLDERS = new Set(["INBOX", "ARCHIVE", "SPAM", "TRASH"]);

function validateRule({ conditions, actions }) {
  const errors = [];
  const allowedConditions = ["fromContains", "subjectContains", "toContains"];
  const allowedActions = ["labelId", "folder", "markRead"];
  if (!conditions || typeof conditions !== "object" || !Object.keys(conditions).length) errors.push("conditions");
  for (const key of Object.keys(conditions || {})) if (!allowedConditions.includes(key) || typeof conditions[key] !== "string" || conditions[key].length > 200) errors.push(`conditions.${key}`);
  if (!actions || typeof actions !== "object" || !Object.keys(actions).length) errors.push("actions");
  for (const key of Object.keys(actions || {})) if (!allowedActions.includes(key)) errors.push(`actions.${key}`);
  if (actions?.folder && !FOLDERS.has(actions.folder)) errors.push("actions.folder");
  return errors;
}

function matches(rule, { from, subject, to }) {
  const conditions = rule.conditions || {};
  const lower = (value) => String(value || "").toLowerCase();
  if (conditions.fromContains && !lower(`${from?.name || ""} ${from?.address || ""}`).includes(lower(conditions.fromContains))) return false;
  if (conditions.subjectContains && !lower(subject).includes(lower(conditions.subjectContains))) return false;
  if (conditions.toContains && !(to || []).some((party) => lower(party.address).includes(lower(conditions.toContains)))) return false;
  return true;
}

async function applyRules(tx, mailbox, created, context) {
  const rules = await tx.mailRule.findMany({ where: { mailboxId: mailbox.id, enabled: true }, orderBy: { priority: "asc" }, take: 50 });
  for (const rule of rules) {
    if (validateRule(rule).length || !matches(rule, context)) continue;
    const actions = rule.actions || {};
    if (actions.folder && created.message.status !== "QUARANTINED") await tx.mailThread.update({ where: { id: created.thread.id }, data: { folder: actions.folder } });
    if (actions.markRead && mailbox.type === "PERSONAL" && mailbox.ownerAdminUserId) {
      await tx.mailUserThreadState.upsert({
        where: { threadId_adminUserId: { threadId: created.thread.id, adminUserId: mailbox.ownerAdminUserId } },
        create: { threadId: created.thread.id, adminUserId: mailbox.ownerAdminUserId, isRead: true, lastReadAt: new Date() },
        update: { isRead: true, lastReadAt: new Date() },
      });
    }
    if (actions.labelId) {
      const label = await tx.mailLabel.findFirst({ where: { id: actions.labelId, mailboxId: mailbox.id } });
      if (label) await tx.mailThreadLabel.upsert({ where: { threadId_labelId: { threadId: created.thread.id, labelId: label.id } }, create: { threadId: created.thread.id, labelId: label.id }, update: {} });
    }
  }
}

module.exports = { applyRules, validateRule, matches };
