"use strict";

// Mailbox rules (filters): declarative, validated, server-side conditions and
// actions. There is no expression language and no executable user input:
// conditions are fixed operators over a handful of fields, matched with plain
// lowercase substring/equality comparisons (no regular expressions, so no
// ReDoS), and actions are a closed set.
//
// conditions (all present conditions must match; at least one is required):
//   fromContains, fromEquals, toContains, subjectContains: string (1-200)
//   hasAttachment: boolean
// actions (at least one effect is required):
//   labelId: uuid of a label in the SAME mailbox
//   folder: "ARCHIVE" | "SPAM" | "TRASH"
//   markRead, star: true (personal mailboxes only: read/star are per user)
//   stopProcessing: true (lower-priority rules are skipped after a match)

const FOLDERS = new Set(["ARCHIVE", "SPAM", "TRASH"]);
const STRING_CONDITIONS = ["fromContains", "fromEquals", "toContains", "subjectContains"];
const CONDITION_KEYS = new Set([...STRING_CONDITIONS, "hasAttachment"]);
const ACTION_KEYS = new Set(["labelId", "folder", "markRead", "star", "stopProcessing"]);
const PERSONAL_ONLY_ACTIONS = ["markRead", "star"];
const MAX_RULES_PER_MAILBOX = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!trimmed || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

// Returns a list of invalid field paths ([] when valid). `mailboxType` makes
// per-user actions invalid on shared mailboxes.
function validateRule({ conditions, actions }, { mailboxType = null } = {}) {
  const errors = [];
  if (!conditions || typeof conditions !== "object" || Array.isArray(conditions) || !Object.keys(conditions).length) errors.push("conditions");
  for (const key of Object.keys(conditions || {})) {
    if (!CONDITION_KEYS.has(key)) errors.push(`conditions.${key}`);
    else if (key === "hasAttachment" ? typeof conditions[key] !== "boolean" : !cleanString(conditions[key])) errors.push(`conditions.${key}`);
  }
  if (!actions || typeof actions !== "object" || Array.isArray(actions)) errors.push("actions");
  const effects = Object.keys(actions || {}).filter((key) => key !== "stopProcessing");
  if (!effects.length) errors.push("actions");
  for (const key of Object.keys(actions || {})) {
    if (!ACTION_KEYS.has(key)) errors.push(`actions.${key}`);
    else if (key === "folder" && !FOLDERS.has(actions.folder)) errors.push("actions.folder");
    else if (key === "labelId" && !(typeof actions.labelId === "string" && UUID.test(actions.labelId))) errors.push("actions.labelId");
    else if (["markRead", "star", "stopProcessing"].includes(key) && actions[key] !== true) errors.push(`actions.${key}`);
  }
  if (mailboxType === "SHARED") for (const key of PERSONAL_ONLY_ACTIONS) if (actions?.[key]) errors.push(`actions.${key}`);
  return [...new Set(errors)];
}

// Canonical stored form (trimmed strings, only known keys).
function normalizeRule({ conditions, actions }) {
  const outConditions = {};
  for (const key of STRING_CONDITIONS) if (conditions?.[key] != null) outConditions[key] = cleanString(conditions[key]);
  if (typeof conditions?.hasAttachment === "boolean") outConditions.hasAttachment = conditions.hasAttachment;
  const outActions = {};
  if (actions?.labelId) outActions.labelId = String(actions.labelId).toLowerCase();
  if (actions?.folder) outActions.folder = actions.folder;
  for (const key of ["markRead", "star", "stopProcessing"]) if (actions?.[key] === true) outActions[key] = true;
  return { conditions: outConditions, actions: outActions };
}

function matches(rule, { from, subject, to, hasAttachments = false }) {
  const conditions = rule.conditions || {};
  const lower = (value) => String(value || "").toLowerCase();
  if (conditions.fromContains && !lower(`${from?.name || ""} ${from?.address || ""}`).includes(lower(conditions.fromContains))) return false;
  if (conditions.fromEquals && lower(from?.address) !== lower(conditions.fromEquals)) return false;
  if (conditions.subjectContains && !lower(subject).includes(lower(conditions.subjectContains))) return false;
  if (conditions.toContains && !(to || []).some((party) => lower(`${party.name || ""} ${party.address}`).includes(lower(conditions.toContains)))) return false;
  if (typeof conditions.hasAttachment === "boolean" && conditions.hasAttachment !== Boolean(hasAttachments)) return false;
  return true;
}

// Applies enabled rules in priority order (ties: oldest first). Invalid rows
// (e.g. written by an older version) are skipped, never partially applied.
// Quarantined messages are never moved out of quarantine by a rule.
async function applyRules(tx, mailbox, created, context) {
  const rules = await tx.mailRule.findMany({ where: { mailboxId: mailbox.id, enabled: true }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }], take: MAX_RULES_PER_MAILBOX });
  const applied = [];
  for (const rule of rules) {
    if (validateRule(rule, { mailboxType: mailbox.type }).length || !matches(rule, context)) continue;
    const actions = rule.actions || {};
    if (actions.folder && created.message.status !== "QUARANTINED") await tx.mailThread.update({ where: { id: created.thread.id }, data: { folder: actions.folder } });
    if ((actions.markRead || actions.star) && mailbox.type === "PERSONAL" && mailbox.ownerAdminUserId) {
      const data = { ...(actions.markRead ? { isRead: true, lastReadAt: new Date() } : {}), ...(actions.star ? { isStarred: true } : {}) };
      await tx.mailUserThreadState.upsert({
        where: { threadId_adminUserId: { threadId: created.thread.id, adminUserId: mailbox.ownerAdminUserId } },
        create: { threadId: created.thread.id, adminUserId: mailbox.ownerAdminUserId, isRead: Boolean(actions.markRead), isStarred: Boolean(actions.star), lastReadAt: actions.markRead ? new Date() : null },
        update: data,
      });
    }
    if (actions.labelId) {
      const label = await tx.mailLabel.findFirst({ where: { id: actions.labelId, mailboxId: mailbox.id } });
      if (label) await tx.mailThreadLabel.upsert({ where: { threadId_labelId: { threadId: created.thread.id, labelId: label.id } }, create: { threadId: created.thread.id, labelId: label.id }, update: {} });
    }
    applied.push(rule.id);
    if (actions.stopProcessing) break;
  }
  return applied;
}

module.exports = { applyRules, validateRule, normalizeRule, matches, MAX_RULES_PER_MAILBOX, FOLDERS };
