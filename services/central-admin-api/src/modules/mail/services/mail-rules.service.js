"use strict";

// Filter (mailbox rule) management. Rules live in mail_rules (migration 27)
// and are always scoped to ONE mailbox: every read/write checks MANAGE access
// on the rule's own mailbox, so a rule id from another mailbox is a 404.
// Personal mailbox owners manage their own filters; shared mailbox filters
// need the MANAGER/OWNER role.

const { mailError } = require("../mail.errors");
const policy = require("../authz/mail.policy");
const { validateRule, normalizeRule, MAX_RULES_PER_MAILBOX } = require("./mail-rules");
const { iso } = require("./serializers");

function serializeRule(rule) {
  return { id: rule.id, mailboxId: rule.mailboxId, name: rule.name, enabled: rule.enabled, priority: rule.priority, conditions: rule.conditions, actions: rule.actions, createdAt: iso(rule.createdAt), updatedAt: iso(rule.updatedAt) };
}

function createMailRulesService({ client, audit }) {
  function cleanName(name) {
    const value = String(name || "").trim().slice(0, 160);
    if (!value) throw mailError("MAIL_VALIDATION_FAILED", { field: "name" });
    return value;
  }

  function cleanPriority(priority, fallback) {
    if (priority === undefined) return fallback;
    const value = Number(priority);
    if (!Number.isInteger(value) || value < 1 || value > 1000) throw mailError("MAIL_VALIDATION_FAILED", { field: "priority" });
    return value;
  }

  async function checkDefinition(mailbox, input) {
    const errors = validateRule(input, { mailboxType: mailbox.type });
    if (errors.length) throw mailError("MAIL_VALIDATION_FAILED", { field: errors[0], fields: errors.slice(0, 10) });
    const normalized = normalizeRule(input);
    if (normalized.actions.labelId) {
      const label = await client.mailLabel.findFirst({ where: { id: normalized.actions.labelId, mailboxId: mailbox.id }, select: { id: true } });
      // A label from another mailbox is reported exactly like a missing one.
      if (!label) throw mailError("MAIL_VALIDATION_FAILED", { field: "actions.labelId" });
    }
    return normalized;
  }

  async function loadRule(user, ruleId) {
    if (!policy.isUuid(ruleId)) throw mailError("MAIL_NOT_FOUND", { resource: "rule" });
    const rule = await client.mailRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw mailError("MAIL_NOT_FOUND", { resource: "rule" });
    let access;
    try {
      access = await policy.requireMailboxAccess(client, user, rule.mailboxId, "MANAGE");
    } catch (error) {
      if (error.code === "MAIL_NOT_FOUND" || error.statusCode === 404) throw mailError("MAIL_NOT_FOUND", { resource: "rule" });
      throw error;
    }
    if (access.viaBreakGlass) throw mailError("MAIL_FORBIDDEN");
    return { rule, mailbox: access.mailbox };
  }

  async function requireManage(user, mailboxId) {
    const access = await policy.requireMailboxAccess(client, user, mailboxId, "MANAGE");
    // Break-glass grants read-only investigation, never configuration.
    if (access.viaBreakGlass) throw mailError("MAIL_FORBIDDEN");
    return access.mailbox;
  }

  async function list(user, mailboxId) {
    const mailbox = await requireManage(user, mailboxId);
    const rules = await client.mailRule.findMany({ where: { mailboxId: mailbox.id }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }], take: MAX_RULES_PER_MAILBOX });
    return rules.map(serializeRule);
  }

  async function create(user, mailboxId, input = {}, context = {}) {
    const mailbox = await requireManage(user, mailboxId);
    const count = await client.mailRule.count({ where: { mailboxId: mailbox.id } });
    if (count >= MAX_RULES_PER_MAILBOX) throw mailError("MAIL_VALIDATION_FAILED", { field: "rules", reason: "TOO_MANY_RULES", max: MAX_RULES_PER_MAILBOX });
    const definition = await checkDefinition(mailbox, input);
    const rule = await client.mailRule.create({
      data: { mailboxId: mailbox.id, name: cleanName(input.name), enabled: input.enabled !== false, priority: cleanPriority(input.priority, 100), conditions: definition.conditions, actions: definition.actions, createdBy: user.id },
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_RULE_CREATED", targetType: "rule", targetId: rule.id, mailboxId: mailbox.id, metadata: { conditions: Object.keys(definition.conditions), actions: Object.keys(definition.actions), enabled: rule.enabled } }, context);
    return serializeRule(rule);
  }

  async function update(user, ruleId, input = {}, context = {}) {
    const { rule, mailbox } = await loadRule(user, ruleId);
    const data = {};
    if (input.name !== undefined) data.name = cleanName(input.name);
    if (input.priority !== undefined) data.priority = cleanPriority(input.priority, rule.priority);
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") throw mailError("MAIL_VALIDATION_FAILED", { field: "enabled" });
      data.enabled = input.enabled;
    }
    if (input.conditions !== undefined || input.actions !== undefined) {
      const definition = await checkDefinition(mailbox, { conditions: input.conditions ?? rule.conditions, actions: input.actions ?? rule.actions });
      data.conditions = definition.conditions;
      data.actions = definition.actions;
    }
    if (!Object.keys(data).length) throw mailError("MAIL_VALIDATION_FAILED", { field: "rule" });
    // Scoped by mailbox as well as id: a concurrent move can never edit another mailbox's rule.
    const result = await client.mailRule.updateMany({ where: { id: rule.id, mailboxId: mailbox.id }, data });
    if (result.count !== 1) throw mailError("MAIL_NOT_FOUND", { resource: "rule" });
    const updated = await client.mailRule.findUnique({ where: { id: rule.id } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_RULE_UPDATED", targetType: "rule", targetId: rule.id, mailboxId: mailbox.id, metadata: { fields: Object.keys(data) } }, context);
    return serializeRule(updated);
  }

  async function remove(user, ruleId, context = {}) {
    const { rule, mailbox } = await loadRule(user, ruleId);
    const result = await client.mailRule.deleteMany({ where: { id: rule.id, mailboxId: mailbox.id } });
    if (result.count !== 1) throw mailError("MAIL_NOT_FOUND", { resource: "rule" });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_RULE_DELETED", targetType: "rule", targetId: rule.id, mailboxId: mailbox.id }, context);
    return { deleted: true };
  }

  // Sets priorities 10, 20, 30... in the given order. Every id must belong to
  // this mailbox; unknown or foreign ids reject the whole request.
  async function reorder(user, mailboxId, { ruleIds } = {}, context = {}) {
    const mailbox = await requireManage(user, mailboxId);
    const ids = Array.isArray(ruleIds) ? ruleIds.map(String) : [];
    if (!ids.length || ids.length > MAX_RULES_PER_MAILBOX || new Set(ids).size !== ids.length || !ids.every(policy.isUuid)) throw mailError("MAIL_VALIDATION_FAILED", { field: "ruleIds" });
    const owned = await client.mailRule.count({ where: { id: { in: ids }, mailboxId: mailbox.id } });
    if (owned !== ids.length) throw mailError("MAIL_VALIDATION_FAILED", { field: "ruleIds", reason: "UNKNOWN_RULE" });
    await client.$transaction(ids.map((id, index) => client.mailRule.updateMany({ where: { id, mailboxId: mailbox.id }, data: { priority: (index + 1) * 10 } })));
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_RULES_REORDERED", targetType: "mailbox", targetId: mailbox.id, mailboxId: mailbox.id, metadata: { count: ids.length } }, context);
    return list(user, mailboxId);
  }

  return { list, create, update, remove, reorder };
}

module.exports = { createMailRulesService, serializeRule };
